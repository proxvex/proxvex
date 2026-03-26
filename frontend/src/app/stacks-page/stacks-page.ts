import { Component, OnInit, inject, signal, computed, OnDestroy } from '@angular/core';
import { FormGroup, FormControl, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { IStack, IStackEntry, IStacktypeEntry } from '../../shared/types';
import { KeyValueTableComponent, KeyValuePair } from '../shared/components/key-value-table.component';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-stacks-page',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatExpansionModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    KeyValueTableComponent
  ],
  templateUrl: './stacks-page.html',
  styleUrl: './stacks-page.scss'
})
export class StacksPage implements OnInit, OnDestroy {
  private configService = inject(VeConfigurationService);
  private errorHandler = inject(ErrorHandlerService);
  private route = inject(ActivatedRoute);
  private routeSub?: Subscription;

  loading = signal(false);
  stacktypes = signal<IStacktypeEntry[]>([]);
  stacks = signal<IStack[]>([]);
  selectedStacktype = signal<string>('');

  // For creating/editing a stack
  editingStack = signal<IStack | null>(null);
  isCreating = signal(false);

  // Form for new/edit stack
  stackForm = new FormGroup({
    name: new FormControl('', Validators.required),
    stacktype: new FormControl('', Validators.required)
  });

  // Stack entries as signal for KeyValueTableComponent
  stackEntries = signal<KeyValuePair[]>([]);

  // Check if a 'default' stack exists for current stacktype
  hasDefaultStack = computed(() => {
    return this.stacks().some(s => s.name.toLowerCase() === 'default');
  });

  // Check if current stacktype has external entries (requires manual input)
  currentStacktypeHasExternalEntries = computed(() => {
    const stacktype = this.stacktypes().find(st => st.name === this.selectedStacktype());
    return stacktype?.entries.some(e => e.external) ?? false;
  });

  // Show "Create default" button only if no default exists AND has external entries
  showCreateDefaultButton = computed(() => {
    return !this.hasDefaultStack() && this.currentStacktypeHasExternalEntries();
  });

  ngOnInit(): void {
    this.routeSub = this.route.queryParamMap.subscribe(params => {
      this._requestedStacktype = params.get('stacktype') ?? undefined;
    });
    this.loadStacktypes();
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
  }

  /** Stacktype requested via ?stacktype= query parameter */
  private _requestedStacktype?: string;

  loadStacktypes(): void {
    this.loading.set(true);
    this.configService.getStacktypes().subscribe({
      next: (res) => {
        this.stacktypes.set(res.stacktypes);
        if (res.stacktypes.length > 0) {
          // Pre-select stacktype from query parameter if valid, otherwise first
          const requested = this._requestedStacktype;
          const match = requested ? res.stacktypes.find(st => st.name === requested) : undefined;
          this.selectedStacktype.set(match ? match.name : res.stacktypes[0].name);
          this.loadStacks();
        } else {
          this.loading.set(false);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load stack types', err);
        this.loading.set(false);
      }
    });
  }

  loadStacks(): void {
    const stacktypeName = this.selectedStacktype();
    if (!stacktypeName) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.configService.getStacks(stacktypeName).subscribe({
      next: (res) => {
        this.stacks.set(res.stacks);
        this.loading.set(false);
        // Auto-create 'default' stack if none exists and no external entries required
        this.autoCreateDefaultStackIfNeeded();
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load stacks', err);
        this.loading.set(false);
      }
    });
  }

  private autoCreateDefaultStackIfNeeded(): void {
    // Only auto-create if no default exists and stacktype has no external entries
    if (this.hasDefaultStack() || this.currentStacktypeHasExternalEntries()) {
      return;
    }

    const stacktypeName = this.selectedStacktype();
    if (!stacktypeName) return;

    // Create default stack with empty entries (backend will auto-generate secrets)
    const defaultStack: Omit<IStack, 'id'> = {
      name: 'default',
      stacktype: stacktypeName,
      entries: []
    };

    this.configService.createStack(defaultStack).subscribe({
      next: () => {
        // Reload stacks to show the new default stack
        this.configService.getStacks(stacktypeName).subscribe({
          next: (res) => {
            this.stacks.set(res.stacks);
          }
        });
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to auto-create default stack', err);
      }
    });
  }

  onStacktypeChange(stacktype: string): void {
    this.selectedStacktype.set(stacktype);
    this.cancelEdit();
    this.loadStacks();
  }

  startCreate(): void {
    this.isCreating.set(true);
    this.editingStack.set(null);
    this.stackForm.reset();
    this.stackForm.patchValue({ stacktype: this.selectedStacktype() });

    // Load variables from stacktype definition
    const stacktype = this.stacktypes().find(st => st.name === this.selectedStacktype());
    if (stacktype) {
      // Sort: external (required) first, then auto-generate
      const sorted = [...stacktype.entries].sort((a, b) => {
        if (a.external && !b.external) return -1;
        if (!a.external && b.external) return 1;
        return 0;
      });
      // Create KeyValuePairs with placeholder info
      this.stackEntries.set(sorted.map(v => ({
        key: v.name,
        value: '',
        placeholder: v.external ? '' : 'Wird automatisch generiert',
        required: v.external ?? false,
        readonly: true  // Key is readonly (defined by stacktype)
      })));
    } else {
      this.stackEntries.set([]);
    }
  }

  startEdit(stack: IStack): void {
    this.isCreating.set(false);
    this.editingStack.set(stack);
    const primaryType = Array.isArray(stack.stacktype) ? stack.stacktype[0] : stack.stacktype;
    this.stackForm.patchValue({
      name: stack.name,
      stacktype: primaryType
    });

    // Load stacktype definition for metadata
    const stacktype = this.stacktypes().find(st => st.name === primaryType);
    const variableMap = new Map(stacktype?.entries.map(v => [v.name, v]) ?? []);

    // Sort entries: external first, then auto-generate
    const sortedEntries = [...stack.entries].sort((a, b) => {
      const aExternal = variableMap.get(a.name)?.external ?? false;
      const bExternal = variableMap.get(b.name)?.external ?? false;
      if (aExternal && !bExternal) return -1;
      if (!aExternal && bExternal) return 1;
      return 0;
    });

    // Convert IStackEntry[] to KeyValuePair[] with metadata
    this.stackEntries.set(sortedEntries.map(e => {
      const varDef = variableMap.get(e.name);
      return {
        key: e.name,
        value: String(e.value),
        placeholder: varDef?.external ? '' : 'Wird automatisch generiert',
        required: varDef?.external ?? false,
        readonly: true
      };
    }));
  }

  cancelEdit(): void {
    this.isCreating.set(false);
    this.editingStack.set(null);
    this.stackForm.reset();
    this.stackEntries.set([]);
  }

  saveStack(): void {
    if (this.stackForm.invalid) return;

    const formValue = this.stackForm.value;
    const entries: IStackEntry[] = this.stackEntries().map(kv => ({
      name: kv.key,
      value: kv.value
    }));

    const stack: Omit<IStack, 'id'> = {
      name: formValue.name!,
      stacktype: formValue.stacktype!,
      entries
    };

    this.loading.set(true);

    if (this.editingStack()) {
      // Update existing stack
      this.configService.updateStack({ ...stack, id: this.editingStack()!.id }).subscribe({
        next: () => {
          this.cancelEdit();
          this.loadStacks();
        },
        error: (err) => {
          this.errorHandler.handleError('Failed to update stack', err);
          this.loading.set(false);
        }
      });
    } else {
      // Create new stack
      this.configService.createStack(stack).subscribe({
        next: () => {
          this.cancelEdit();
          this.loadStacks();
        },
        error: (err) => {
          this.errorHandler.handleError('Failed to create stack', err);
          this.loading.set(false);
        }
      });
    }
  }

  deleteStack(stack: IStack, event: Event): void {
    event.stopPropagation();
    if (!confirm(`Delete stack "${stack.name}"?`)) return;

    this.loading.set(true);
    this.configService.deleteStack(stack.id).subscribe({
      next: () => {
        this.loadStacks();
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to delete stack', err);
        this.loading.set(false);
      }
    });
  }

  onEntriesChange(entries: KeyValuePair[]): void {
    this.stackEntries.set(entries);
  }

  isEditing(): boolean {
    return this.isCreating() || this.editingStack() !== null;
  }

  startCreateDefault(): void {
    this.isCreating.set(true);
    this.editingStack.set(null);
    this.stackForm.reset();
    this.stackForm.patchValue({
      name: 'default',
      stacktype: this.selectedStacktype()
    });

    // Load variables from stacktype definition
    const stacktype = this.stacktypes().find(st => st.name === this.selectedStacktype());
    if (stacktype) {
      // Sort: external (required) first, then auto-generate
      const sorted = [...stacktype.entries].sort((a, b) => {
        if (a.external && !b.external) return -1;
        if (!a.external && b.external) return 1;
        return 0;
      });
      // Create KeyValuePairs with placeholder info
      this.stackEntries.set(sorted.map(v => ({
        key: v.name,
        value: '',
        placeholder: v.external ? '' : 'Wird automatisch generiert',
        required: v.external ?? false,
        readonly: true
      })));
    } else {
      this.stackEntries.set([]);
    }
  }

  isDefaultStack(stack: IStack): boolean {
    return stack.name.toLowerCase() === 'default';
  }
}
