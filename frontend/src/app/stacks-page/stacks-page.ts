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
import { MatDialog } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { IStack, IStackEntry, IStacktypeEntry, IStackRestorePreviewResponse } from '../../shared/types';
import { KeyValueTableComponent, KeyValuePair } from '../shared/components/key-value-table.component';
import { RefreshStackDialog } from './refresh-stack-dialog';
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
  private dialog = inject(MatDialog);
  private route = inject(ActivatedRoute);
  private routeSub?: Subscription;

  loading = signal(false);
  restoring = signal(false);
  restoreNotice = signal<string>('');
  spokeStatus = signal<{ active: boolean; hubUrl?: string } | null>(null);
  stacktypes = signal<IStacktypeEntry[]>([]);
  stacks = signal<IStack[]>([]);
  selectedStacktype = signal<string>('');

  // For creating/editing a stack
  editingStack = signal<IStack | null>(null);
  isCreating = signal(false);

  // Pre-loaded refresh previews per stackId. Populated when the user expands
  // a dirty stack row so that a subsequent save can open the dialog without
  // a visible round-trip. Not a source of truth — `stack.dirty` decides
  // whether the button is visible; the cache is purely a latency hack.
  private previewCache = new Map<string, {
    preview: { targets: unknown[] } & Record<string, unknown>;
    veContextHost: string;
  }>();

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
    this.configService.getSpokeSyncStatus().subscribe({
      next: (s) => this.spokeStatus.set(s),
      error: () => this.spokeStatus.set(null),
    });
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
    this.restoreNotice.set('');
  }

  restoreFromApplications(): void {
    if (this.stackForm.invalid) return;
    const name = this.stackForm.value.name!;
    const stacktype = this.stackForm.value.stacktype!;

    const warning =
      'Restore from Applications\n\n' +
      `This reads secret values from managed containers whose PVE notes reference the stack "${stacktype}_${name}", and pre-fills this form with them.\n\n` +
      'Intended for disaster recovery after the deployer lost its state. The containers must still be running and must already reference this stack-id.\n\n' +
      'Rules:\n' +
      '  • Identical values across containers → restored\n' +
      '  • Different values for the same key → aborted (system drift)\n' +
      '  • No value found → left empty (auto-generated on Create for non-external vars)\n\n' +
      'Continue?';

    if (!confirm(warning)) return;

    this.restoring.set(true);
    this.restoreNotice.set('');
    this.configService.stackRestorePreview({ stacktype, name }).subscribe({
      next: (res: IStackRestorePreviewResponse) => {
        this.restoring.set(false);
        this.applyRestoreResult(res);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to scan applications for stack values', err);
        this.restoring.set(false);
      }
    });
  }

  private applyRestoreResult(res: IStackRestorePreviewResponse): void {
    if (res.conflicts.length > 0) {
      const lines = res.conflicts.map(c => {
        const variants = c.values.map(v =>
          `    - "${v.value}" (from ${v.sources.join(', ')})`
        ).join('\n');
        return `  ${c.name}:\n${variants}`;
      });
      alert(
        'Restore aborted — conflicting values found across containers:\n\n' +
        lines.join('\n\n') +
        '\n\nResolve the drift (redeploy the divergent containers against a known-good value) before retrying.'
      );
      this.restoreNotice.set('Restore aborted due to value conflicts — see dialog above.');
      return;
    }

    const restored = res.entries.filter(e => e.status === 'unique');
    const missing = res.entries.filter(e => e.status === 'missing');

    const existing = new Map(this.stackEntries().map(kv => [kv.key, kv]));
    for (const entry of res.entries) {
      existing.set(entry.name, { key: entry.name, value: entry.value });
    }
    this.stackEntries.set(Array.from(existing.values()));

    const bits: string[] = [];
    bits.push(`Scanned ${res.sources_scanned} container(s).`);
    bits.push(`${restored.length} restored, ${missing.length} left empty (will be auto-generated on Create for non-external vars).`);
    const aliasLines = (res.dependency_trace ?? [])
      .filter(d => d.alias !== d.canonical)
      .map(d => `  • ${d.canonical} ← ${d.alias} (from ${d.source}${d.replacement ? `, ${d.replacement}` : ''})`);
    if (aliasLines.length > 0) {
      bits.push('Resolved aliases:');
      bits.push(...aliasLines);
    }
    if (res.errors.length > 0) {
      bits.push('Warnings:');
      for (const e of res.errors) bits.push(`  • ${e}`);
    }
    this.restoreNotice.set(bits.join('\n'));
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
    const editedStack = this.editingStack();

    if (editedStack) {
      // Update existing stack. Backend sets `dirty=true` iff any entry value
      // actually changed. After save we reload stacks and — if the updated
      // stack is now dirty — auto-open the refresh dialog.
      const updatedId = this.computeStackId(stack.stacktype, stack.name!);
      this.configService.updateStack({ ...stack, id: editedStack.id }).subscribe({
        next: () => {
          this.cancelEdit();
          this.configService.getStacks(this.selectedStacktype()).subscribe({
            next: (res) => {
              this.stacks.set(res.stacks);
              this.loading.set(false);
              const updated = res.stacks.find((s) => s.id === updatedId);
              if (updated?.dirty) {
                this.openRefreshDialog(updated);
              }
            },
            error: (err) => {
              this.errorHandler.handleError('Failed to reload stacks', err);
              this.loading.set(false);
            },
          });
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

  /**
   * Mirrors the backend id-generation rule so we can locate the (possibly
   * renamed) stack in the reloaded list after an update.
   */
  private computeStackId(stacktype: string | string[], name: string): string {
    const prefix = Array.isArray(stacktype)
      ? [...stacktype].sort().join('_')
      : stacktype;
    return `${prefix}_${name}`;
  }

  /**
   * Called when a stack row is expanded. Pre-fetches the refresh preview in
   * the background so a subsequent save / button click can open the dialog
   * without a visible delay.
   */
  onStackExpanded(stack: IStack): void {
    if (this.previewCache.has(stack.id)) return;
    this.configService.getStackRefreshPreview(stack.id).subscribe({
      next: (res) => {
        const preview = res.preview as { targets: unknown[] } & Record<string, unknown>;
        this.previewCache.set(stack.id, { preview, veContextHost: res.veContextHost });
      },
      // Silently ignore — cache just stays empty; the dialog-open path will
      // fetch on demand and surface any error there.
      error: () => { /* noop */ },
    });
  }

  /**
   * Opens the refresh dialog for a stack. Uses the cached preview if one was
   * pre-fetched on expand; otherwise fetches now. Called from the action-row
   * button (visible only when `stack.dirty`) and automatically after a save
   * that flipped dirty to true.
   */
  openRefreshDialog(stack: IStack): void {
    const cached = this.previewCache.get(stack.id);
    if (cached) {
      this.previewCache.delete(stack.id);
      this.showRefreshDialog(stack, cached.preview, cached.veContextHost);
      return;
    }
    this.configService.getStackRefreshPreview(stack.id).subscribe({
      next: (res) => {
        this.showRefreshDialog(
          stack,
          res.preview as { targets: unknown[] } & Record<string, unknown>,
          res.veContextHost,
        );
      },
      error: (err) => {
        if (err?.status === 400 && typeof err?.error?.error === 'string' && err.error.error.includes('VE context')) {
          alert('Bitte wähle zuerst im Header einen PVE-Host aus.');
          return;
        }
        this.errorHandler.handleError('Failed to fetch refresh preview', err);
      },
    });
  }

  private showRefreshDialog(
    stack: IStack,
    preview: { targets: unknown[] } & Record<string, unknown>,
    veContextHost: string,
  ): void {
    this.dialog
      .open(RefreshStackDialog, {
        data: { stack, preview, veContextHost },
        width: '960px',
        maxWidth: '96vw',
      })
      .afterClosed()
      .subscribe(() => {
        // Refresh may have cleared the backend `dirty` flag — reload to reflect.
        this.loadStacks();
      });
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
