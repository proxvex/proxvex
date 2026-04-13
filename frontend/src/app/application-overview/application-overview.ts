import { Component, inject, OnInit } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';

import {
  IApplicationOverviewResponse,
  IApplicationOverviewParameter,
  IApplicationOverviewTemplate,
} from './application-overview.types';
import { VeConfigurationService } from '../ve-configuration.service';
import { CommandsTableComponent } from '../shared/components/commands-table/commands-table';
import { ICommandRow, ICommandDetail } from '../shared/components/commands-table/commands-table.types';

type OriginFilter = 'all' | 'local' | 'public';
type ScopeFilter = 'all' | 'application' | 'shared';
type SourceFilter = 'all' | 'value' | 'default' | 'parameter';

@Component({
  selector: 'app-application-overview',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonToggleModule,
    CommandsTableComponent,
  ],
  templateUrl: './application-overview.html',
  styleUrl: './application-overview.scss',
})
export class ApplicationOverview implements OnInit {
  private route = inject(ActivatedRoute);
  private location = inject(Location);
  private sanitizer = inject(DomSanitizer);
  private configService = inject(VeConfigurationService);

  applicationId = '';
  selectedTask = 'installation';
  tasks = ['installation', 'upgrade', 'reconfigure'];

  data: IApplicationOverviewResponse | null = null;
  renderedMarkdown: SafeHtml | null = null;
  filteredParameters: IApplicationOverviewParameter[] = [];
  commandRows: ICommandRow[] = [];

  // Parameter filters
  filterOrigin: OriginFilter = 'all';
  filterScope: ScopeFilter = 'all';
  flagRequired: 'all' | 'yes' | 'no' = 'all';
  flagAdvanced: 'all' | 'yes' | 'no' = 'no';
  flagInternal: 'all' | 'yes' | 'no' = 'all';
  filterBinding: SourceFilter = 'all';

  vmId?: number;
  veContextKey?: string;

  ngOnInit(): void {
    this.applicationId = this.route.snapshot.paramMap.get('applicationId') ?? '';
    const vmIdParam = this.route.snapshot.queryParamMap.get('vm_id');
    this.vmId = vmIdParam ? Number(vmIdParam) : undefined;
    this.veContextKey = this.route.snapshot.queryParamMap.get('veContext') ?? undefined;
    this.loadData();
  }

  loading = false;
  error: string | null = null;

  loadData(): void {
    this.loading = true;
    this.error = null;
    this.configService.getApplicationOverview(this.applicationId, this.selectedTask, this.vmId, this.veContextKey).subscribe({
      next: (result) => {
        this.data = result;
        this.loading = false;
        this.renderedMarkdown = null;
        this.renderMarkdown();
        this.applyFilters();
        this.buildCommandRows();
      },
      error: (err: unknown) => {
        this.loading = false;
        this.error = err instanceof Error ? err.message : 'Failed to load application overview';
      },
    });
  }

  onTaskChange(): void {
    this.loadData();
  }

  goBack(): void {
    this.location.back();
  }

  private renderMarkdown(): void {
    if (this.data?.markdownContent) {
      const html = marked.parse(this.data.markdownContent) as string;
      this.renderedMarkdown = this.sanitizer.bypassSecurityTrustHtml(html);
    }
  }

  applyFilters(): void {
    if (!this.data) return;
    let filtered = this.data.parameters;

    if (this.filterOrigin !== 'all') {
      filtered = filtered.filter((p) =>
        this.filterOrigin === 'local' ? p.origin.includes('local') : p.origin.includes('json'),
      );
    }
    if (this.filterScope !== 'all') {
      filtered = filtered.filter((p) =>
        this.filterScope === 'application' ? p.origin.includes('application') : p.origin.includes('shared'),
      );
    }
    if (this.flagRequired === 'yes') {
      filtered = filtered.filter((p) => p.required);
    } else if (this.flagRequired === 'no') {
      filtered = filtered.filter((p) => !p.required);
    }
    if (this.flagAdvanced === 'yes') {
      filtered = filtered.filter((p) => p.advanced);
    } else if (this.flagAdvanced === 'no') {
      filtered = filtered.filter((p) => !p.advanced);
    }
    if (this.flagInternal === 'yes') {
      filtered = filtered.filter((p) => p.internal);
    } else if (this.flagInternal === 'no') {
      filtered = filtered.filter((p) => !p.internal);
    }
    if (this.filterBinding !== 'all') {
      filtered = filtered.filter((p) => p.sourceType === this.filterBinding);
    }

    this.filteredParameters = filtered;
  }

  cycleFlag(flag: 'required' | 'advanced' | 'internal'): void {
    const key = flag === 'required' ? 'flagRequired' : flag === 'advanced' ? 'flagAdvanced' : 'flagInternal';
    const current = this[key];
    this[key] = current === 'all' ? 'yes' : current === 'yes' ? 'no' : 'all';
    this.applyFilters();
  }

  originLabel(origin: string): string {
    switch (origin) {
      case 'application-local': return 'App (local)';
      case 'application-hub': return 'App (hub)';
      case 'application-json': return 'App (public)';
      case 'shared-local': return 'Shared (local)';
      case 'shared-hub': return 'Shared (hub)';
      case 'shared-json': return 'Shared (public)';
      default: return origin;
    }
  }

  originBadgeCls(origin: string): string {
    if (origin.includes('local')) return 'badge-origin-local';
    if (origin.includes('hub')) return 'badge-origin-hub';
    return 'badge-origin-json';
  }

  paramBadges(p: IApplicationOverviewParameter): { label: string; cls: string }[] {
    const badges: { label: string; cls: string }[] = [];
    if (p.required) badges.push({ label: 'required', cls: 'badge-required' });
    if (p.advanced) badges.push({ label: 'advanced', cls: 'badge-advanced' });
    if (p.internal) badges.push({ label: 'internal', cls: 'badge-internal' });
    if (p.secure) badges.push({ label: 'secure', cls: 'badge-secure' });
    badges.push({ label: p.sourceType, cls: 'badge-source-' + p.sourceType });
    return badges;
  }

  private buildCommandRows(): void {
    if (!this.data) { this.commandRows = []; return; }
    this.commandRows = this.data.templates.map((t) => this.toCommandRow(t));
  }

  private toCommandRow(t: IApplicationOverviewTemplate): ICommandRow {
    return {
      seq: t.seq,
      name: t.name,
      skipped: t.skipped,
      badges: this.templateBadges(t),
      details: this.templateDetails(t),
    };
  }

  private templateBadges(t: IApplicationOverviewTemplate): { label: string; cls: string }[] {
    const badges: { label: string; cls: string }[] = [];
    badges.push(t.isShared
      ? { label: 'shared', cls: 'badge-shared' }
      : { label: 'app', cls: 'badge-app' });
    if (t.origin.includes('local')) badges.push({ label: 'local', cls: 'badge-local' });
    if (t.origin.includes('hub')) badges.push({ label: 'hub', cls: 'badge-hub' });
    if (t.skipped) badges.push({ label: 'skipped', cls: 'badge-skipped' });
    if (t.addedByAddon) badges.push({ label: t.addedByAddon, cls: 'badge-addon' });
    if (t.executeOn) badges.push({ label: t.executeOn, cls: 'badge-exec' });
    return badges;
  }

  private templateDetails(t: IApplicationOverviewTemplate): ICommandDetail[] {
    const d: ICommandDetail[] = [];
    if (t.category) d.push({ label: 'Category', value: t.category });
    const fileName = t.path.split('/').pop() ?? t.path;
    d.push({ label: 'Template', value: fileName, tooltip: t.path, type: 'badge', badgeCls: this.originBadgeCls(t.origin), badgeLabel: this.originLabel(t.origin) });
    if (t.executeOn) d.push({ label: 'Execute on', value: t.executeOn });
    if (t.scriptName) {
      if (t.scriptOrigin) {
        d.push({ label: 'Script', value: t.scriptName, tooltip: t.scriptPath, type: 'badge', badgeCls: this.originBadgeCls(t.scriptOrigin), badgeLabel: this.originLabel(t.scriptOrigin) });
      } else {
        d.push({ label: 'Script', value: t.scriptName, tooltip: t.scriptPath });
      }
    }
    if (t.addedByAddon) d.push({ label: 'Injected by', value: t.addedByAddon });
    if (t.skipped && t.skipReason) d.push({ label: 'Skip reason', value: t.skipReason, type: 'warn' });
    if (t.skipIfAllMissing?.length && !t.skipped) d.push({ label: 'Conditional', value: 'skip_if_all_missing: ' + t.skipIfAllMissing.join(', ') });
    if (t.skipIfPropertySet && !t.skipped) d.push({ label: 'Conditional', value: 'skip_if_property_set: ' + t.skipIfPropertySet });
    if (t.implements) d.push({ label: 'Implements', value: t.implements });
    if (t.outputs.length > 0) d.push({ label: 'Outputs', value: t.outputs.join(', ') });
    if (t.parameters.length > 0) d.push({ label: 'Parameters', value: t.parameters.join(', ') });
    return d;
  }
}
