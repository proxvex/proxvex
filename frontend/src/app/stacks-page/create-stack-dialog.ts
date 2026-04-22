import { Component, inject, signal, OnInit } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { FormGroup, FormControl, Validators, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { KeyValueTableComponent, KeyValuePair } from '../shared/components/key-value-table.component';
import { IStack, IStackEntry, IStacktypeEntry, IStackRestorePreviewResponse } from '../../shared/types';

export interface CreateStackDialogData {
  stacktypes: IStacktypeEntry[];
  defaultStacktype?: string;
  suggestedEntries?: string[]; // Marker names to pre-fill
}

export interface CreateStackDialogResult {
  stack: IStack;
}

@Component({
  selector: 'app-create-stack-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    KeyValueTableComponent
  ],
  template: `
    <h2 mat-dialog-title>Create Secrets</h2>
    <mat-dialog-content>
      <form [formGroup]="stackForm">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Name</mat-label>
          <input matInput formControlName="name" required placeholder="e.g., production, staging, default" />
          <mat-hint>Name "default" keeps the original hostname during deployment</mat-hint>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Type</mat-label>
          <mat-select formControlName="stacktype" required>
            @for (tt of data.stacktypes; track tt.name) {
              <mat-option [value]="tt.name">{{ tt.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <h4>Variables</h4>
        @if (data.suggestedEntries && data.suggestedEntries.length > 0) {
          <p class="hint">Pre-filled from detected markers. Add values for each variable.</p>
        }
        <app-key-value-table
          [items]="stackEntries()"
          keyPlaceholder="Variable Name"
          valuePlaceholder="Value"
          keyLabel="variable"
          (itemsChange)="onEntriesChange($event)"
        />
      </form>
    </mat-dialog-content>
    @if (restoreNotice()) {
      <p class="restore-notice">{{ restoreNotice() }}</p>
    }
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-stroked-button type="button" (click)="restoreFromApplications()"
        [disabled]="stackForm.invalid || loading() || restoring()"
        matTooltip="Read secret values from running applications that reference this stack. Disaster recovery only — requires PVE access.">
        @if (restoring()) {
          <mat-spinner diameter="20"></mat-spinner>
        } @else {
          Restore from Applications
        }
      </button>
      <button mat-flat-button color="primary" (click)="save()" [disabled]="stackForm.invalid || loading() || restoring()">
        @if (loading()) {
          <mat-spinner diameter="20"></mat-spinner>
        } @else {
          Create
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 400px;
      max-width: 600px;
    }

    .full-width {
      width: 100%;
    }

    h4 {
      margin: 1rem 0 0.5rem 0;
      font-weight: 500;
    }

    .hint {
      color: #666;
      font-size: 0.85rem;
      margin: 0 0 0.5rem 0;
    }

    .restore-notice {
      background: #fff8e1;
      border-left: 3px solid #ffb300;
      padding: 0.5rem 0.75rem;
      margin: 0.5rem 0;
      font-size: 0.85rem;
      color: #6a4a00;
      white-space: pre-line;
    }

    mat-dialog-actions button {
      min-width: 80px;
    }

    mat-spinner {
      display: inline-block;
    }
  `]
})
export class CreateStackDialog implements OnInit {
  dialogRef = inject(MatDialogRef<CreateStackDialog, CreateStackDialogResult>);
  data = inject<CreateStackDialogData>(MAT_DIALOG_DATA);
  private configService = inject(VeConfigurationService);
  private errorHandler = inject(ErrorHandlerService);

  loading = signal(false);
  restoring = signal(false);
  restoreNotice = signal<string>('');
  stackEntries = signal<KeyValuePair[]>([]);

  stackForm = new FormGroup({
    name: new FormControl('', Validators.required),
    stacktype: new FormControl('', Validators.required)
  });

  ngOnInit(): void {
    // Set default stacktype
    if (this.data.defaultStacktype) {
      this.stackForm.patchValue({ stacktype: this.data.defaultStacktype });
    } else if (this.data.stacktypes.length > 0) {
      this.stackForm.patchValue({ stacktype: this.data.stacktypes[0].name });
    }

    // Pre-fill entries from suggested markers
    if (this.data.suggestedEntries && this.data.suggestedEntries.length > 0) {
      this.stackEntries.set(this.data.suggestedEntries.map(name => ({
        key: name,
        value: ''
      })));
    }
  }

  onEntriesChange(entries: KeyValuePair[]): void {
    this.stackEntries.set(entries);
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
    if (res.errors.length > 0) {
      bits.push('Warnings:');
      for (const e of res.errors) bits.push(`  • ${e}`);
    }
    this.restoreNotice.set(bits.join('\n'));
  }

  save(): void {
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
    this.configService.createStack(stack).subscribe({
      next: (res) => {
        // Construct the full stack object to return
        const createdStack: IStack = {
          id: res.key,
          name: stack.name,
          stacktype: stack.stacktype,
          entries: stack.entries
        };
        this.dialogRef.close({ stack: createdStack });
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to create stack', err);
        this.loading.set(false);
      }
    });
  }
}
