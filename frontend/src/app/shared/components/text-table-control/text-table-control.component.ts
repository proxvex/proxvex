import { Component, Input, forwardRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * Reusable row editor for newline-separated list parameters (volumes, envs,
 * mTLS CNs). Implemented as a ControlValueAccessor so it drops into the
 * existing reactive form by `[formControl]` alone and keeps the FormControl
 * value as the SAME newline-joined string the previous <textarea> produced
 * (round-trip is byte-identical: split(/\r?\n/) on read, join('\n') on write,
 * no trimming, no empty-line filtering). Each line is opaque free text.
 */
@Component({
  selector: 'app-text-table-control',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
  ],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      multi: true,
      useExisting: forwardRef(() => TextTableControlComponent),
    },
  ],
  template: `
    <div class="ttc" [attr.data-testid]="'ttc-' + (testId || label)">
      @if (label) {
        <div class="ttc-label">{{ label }}@if (required) {<span class="ttc-req">*</span>}</div>
      }
      <div class="ttc-scroll">
        @for (row of rows; track $index; let i = $index) {
          <div class="ttc-row" [attr.data-testid]="'ttc-row-' + i">
            <mat-form-field appearance="fill" class="ttc-field">
              <input
                matInput
                [ngModel]="row"
                (ngModelChange)="updateRow(i, $event)"
                [name]="'row' + i"
                [placeholder]="placeholder"
                [attr.data-testid]="'ttc-input-' + i"
              />
            </mat-form-field>
            <button
              type="button"
              mat-icon-button
              color="warn"
              (click)="deleteRow(i)"
              aria-label="Remove row"
              [attr.data-testid]="'ttc-delete-' + i"
            >
              <mat-icon>delete</mat-icon>
            </button>
          </div>
        }
        <div class="ttc-row ttc-add-row" data-testid="ttc-add-row">
          <mat-form-field appearance="fill" class="ttc-field">
            <input
              matInput
              [(ngModel)]="newRow"
              name="newRow"
              [placeholder]="placeholder"
              (keyup.enter)="addRow()"
              (keyup.escape)="newRow = ''"
              data-testid="ttc-new-input"
            />
          </mat-form-field>
          <button
            type="button"
            mat-icon-button
            color="primary"
            (click)="addRow()"
            [disabled]="!newRow"
            matTooltip="Add (Enter)"
            aria-label="Add row"
            data-testid="ttc-add-btn"
          >
            <mat-icon>add</mat-icon>
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .ttc { width: 100%; }
    .ttc-label {
      font-size: .75rem;
      font-weight: 600;
      color: rgba(0, 0, 0, .54);
      text-transform: uppercase;
      letter-spacing: .5px;
      padding-bottom: .25rem;
    }
    .ttc-req { color: #d32f2f; margin-left: 2px; }
    .ttc-scroll { overflow-x: auto; }
    .ttc-row {
      display: flex;
      align-items: center;
      gap: .5rem;
      flex-wrap: nowrap;
      min-width: 320px;
      margin-bottom: .25rem;
    }
    .ttc-field { flex: 1 1 auto; min-width: 0; }
  `],
})
export class TextTableControlComponent implements ControlValueAccessor {
  @Input() label = '';
  @Input() placeholder = '';
  @Input() required = false;
  @Input() testId = '';

  rows: string[] = [];
  newRow = '';

  private onChange: (v: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(v: string | null): void {
    this.rows = v && v.length ? v.split(/\r?\n/) : [];
  }

  registerOnChange(fn: (v: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  private emit(): void {
    this.onChange(this.rows.join('\n'));
    this.onTouched();
  }

  updateRow(i: number, v: string): void {
    this.rows[i] = v;
    this.emit();
  }

  deleteRow(i: number): void {
    this.rows.splice(i, 1);
    this.emit();
  }

  addRow(): void {
    if (!this.newRow) return;
    this.rows = [...this.rows, this.newRow];
    this.newRow = '';
    this.emit();
  }
}
