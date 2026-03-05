import {
  Component,
  Input,
  ContentChild,
  TemplateRef,
  inject,
  OnInit,
  OnChanges,
  Output,
  EventEmitter,
  ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ITagsConfig } from '../../../../shared/types';
import { VeConfigurationService } from '../../../ve-configuration.service';

export type CardTheme = 'blue' | 'green';

export interface GroupedItems<T> {
  id: string;
  name: string;
  items: T[];
  collapsed: boolean;
}

@Component({
  selector: 'app-card-grid',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './card-grid.html',
  styleUrl: './card-grid.scss',
  encapsulation: ViewEncapsulation.None,
})
export class CardGridComponent<T> implements OnInit, OnChanges {
  @Input() items: T[] = [];
  @Input() loading = false;
  @Input() error?: string;
  @Input() theme: CardTheme = 'blue';
  @Input() loadingText = 'Loading...';
  @Input() trackByFn: (index: number, item: T) => unknown = (_, item) => item;

  // Filter configuration
  @Input() enableFilters = false;
  @Input() filterFn?: (item: T, tagsConfig: ITagsConfig, showInternal: boolean) => boolean;
  @Input() getItemId?: (item: T) => string;

  // Grouping configuration
  @Input() enableGrouping = false;
  @Input() getItemTags?: (item: T) => string[] | undefined;

  @Input() enableFrameworkFilter = false;

  @Output() itemsFiltered = new EventEmitter<T[]>();

  @ContentChild('cardTemplate') cardTemplate!: TemplateRef<{ $implicit: T }>;

  // URL parameters
  showInternal = false;
  showFramework = false;

  // Tags config
  tagsConfig: ITagsConfig = { groups: [], internal: [] };

  // Filtered items (flat list)
  filteredItems: T[] = [];

  // Grouped items
  groupedItems: GroupedItems<T>[] = [];

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private configService = inject(VeConfigurationService);

  ngOnInit(): void {
    if (this.enableFilters || this.enableGrouping) {
      // Read URL parameters
      this.route.queryParams.subscribe(params => {
        this.showInternal = params['showInternal'] === 'true';
        this.showFramework = params['showFramework'] === 'true';
        this.applyFilters();
      });

      // Load tags config
      this.configService.getTagsConfig().subscribe({
        next: (config) => {
          this.tagsConfig = config;
          this.applyFilters();
        },
        error: () => {
          // Ignore error, use empty config
          this.applyFilters();
        }
      });
    }
  }

  ngOnChanges(): void {
    this.applyFilters();
  }

  private applyFilters(): void {
    // First filter
    if (!this.enableFilters || !this.filterFn) {
      this.filteredItems = this.items;
    } else {
      this.filteredItems = this.items.filter(item =>
        this.filterFn!(item, this.tagsConfig, this.showInternal)
      );
    }

    // Then group if enabled
    if (this.enableGrouping) {
      this.buildGroups();
    }

    this.itemsFiltered.emit(this.filteredItems);
  }

  private buildGroups(): void {
    // Get all tag definitions from first group (function)
    const tagGroup = this.tagsConfig.groups[0];
    const tagDefs = tagGroup?.tags || [];

    // Create a map of tag id -> items
    const tagToItems = new Map<string, T[]>();
    const uncategorized: T[] = [];

    for (const item of this.filteredItems) {
      const tags = this.getItemTags?.(item) || [];
      if (tags.length === 0) {
        uncategorized.push(item);
      } else {
        // Add item to each of its tags
        for (const tag of tags) {
          if (!tagToItems.has(tag)) {
            tagToItems.set(tag, []);
          }
          tagToItems.get(tag)!.push(item);
        }
      }
    }

    // Build grouped items array in tag definition order
    const groups: GroupedItems<T>[] = [];

    for (const tagDef of tagDefs) {
      const items = tagToItems.get(tagDef.id);
      if (items && items.length > 0) {
        groups.push({
          id: tagDef.id,
          name: tagDef.name,
          items,
          collapsed: false,
        });
      }
    }

    // Add uncategorized at the end if any
    if (uncategorized.length > 0) {
      groups.push({
        id: 'uncategorized',
        name: 'Uncategorized',
        items: uncategorized,
        collapsed: false,
      });
    }

    this.groupedItems = groups;
  }

  toggleGroup(group: GroupedItems<T>): void {
    group.collapsed = !group.collapsed;
  }

  toggleShowInternal(): void {
    this.showInternal = !this.showInternal;
    this.updateUrlParams();
    this.applyFilters();
  }

  toggleShowFramework(): void {
    this.showFramework = !this.showFramework;
    this.updateUrlParams();
  }

  private updateUrlParams(): void {
    const queryParams: Record<string, string | null> = {};
    queryParams['showInternal'] = this.showInternal ? 'true' : null;
    queryParams['showFramework'] = this.showFramework ? 'true' : null;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge'
    });
  }

  isInternal(item: T): boolean {
    if (!this.getItemId) return false;
    return this.tagsConfig.internal.includes(this.getItemId(item));
  }

  trackByGroup(_: number, group: GroupedItems<T>): string {
    return group.id;
  }
}
