import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';

export interface BooleanColumnConfig {
  field: string;           // Field name in flags object, e.g., 'required', 'advanced'
  label: string;           // Column header label
  icon?: string;           // Material icon name (optional)
  tooltip?: string;        // Tooltip text for the checkbox
}

export interface KeyValuePair {
  key: string;
  value: string | number;
  placeholder?: string;    // Optional per-row placeholder for value field
  readonly?: boolean;      // Optional per-row readonly flag for key field
  flags?: Record<string, boolean>;  // Dynamic boolean fields (required, advanced, etc.)
}

@Component({
  selector: 'app-key-value-table',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule,
    MatTooltipModule
  ],
  template: `
    <div class="key-value-table" [style.--grid-columns]="getGridColumns()">
      <!-- Column headers -->
      @if (items.length > 0 || isAddingNew) {
        <div class="grid-row header-row">
          @if (showRadio) {
            <div class="col radio"></div>
          }
          <div class="col key header-label">{{ keyPlaceholder || 'Key' }}</div>
          <div class="col value header-label">{{ valuePlaceholder || 'Value' }}</div>
          @for (col of booleanColumns; track col.field) {
            <div class="col boolean-col header-label" [matTooltip]="col.tooltip || ''">{{ col.label }}</div>
          }
          @if (!readonly) {
            <div class="col actions"></div>
          }
        </div>
      }

      @if (items.length > 0) {
        @for (item of items; track $index; let idx = $index) {
          <div class="grid-row" [attr.data-testid]="'key-value-row-' + idx">
            @if (showRadio) {
              <div class="col radio">
                <mat-radio-button
                  [checked]="selectedIndex === idx"
                  (change)="setSelected(idx)"
                  [attr.aria-label]="'Set current ' + keyLabel"
                ></mat-radio-button>
              </div>
            }
            <div class="col key">
              <mat-form-field appearance="fill" class="field">
                <input
                  matInput
                  [(ngModel)]="item.key"
                  [name]="'key' + idx"
                  [placeholder]="keyPlaceholder"
                  (blur)="onKeyChange(idx, item.key)"
                  [readonly]="readonly || item.readonly"
                  [attr.data-testid]="'key-input-' + idx"
                />
              </mat-form-field>
            </div>
            <div class="col value">
              <mat-form-field appearance="fill" class="field">
                @if (valueType === 'number') {
                  <input
                    matInput
                    type="number"
                    [(ngModel)]="item.value"
                    [name]="'value' + idx"
                    [placeholder]="item.placeholder || valuePlaceholder"
                    (blur)="onValueChange(idx, item.value)"
                    [readonly]="readonly"
                    [attr.data-testid]="'value-input-' + idx"
                  />
                } @else {
                  <input
                    matInput
                    [(ngModel)]="item.value"
                    [name]="'value' + idx"
                    [placeholder]="item.placeholder || valuePlaceholder"
                    (blur)="onValueChange(idx, item.value)"
                    [readonly]="readonly"
                    [attr.data-testid]="'value-input-' + idx"
                  />
                }
              </mat-form-field>
            </div>
            <!-- Dynamic boolean columns -->
            @for (col of booleanColumns; track col.field) {
              <div class="col boolean-col">
                <mat-checkbox
                  [checked]="!!item.flags?.[col.field]"
                  (change)="onBooleanChange(idx, col.field, $event.checked)"
                  [matTooltip]="col.tooltip || col.label"
                  [disabled]="readonly"
                  [attr.data-testid]="'boolean-' + col.field + '-' + idx"
                >
                  @if (col.icon) {
                    <mat-icon class="checkbox-icon">{{ col.icon }}</mat-icon>
                  } @else {
                    <span class="checkbox-label">{{ col.label }}</span>
                  }
                </mat-checkbox>
              </div>
            }
            @if (!readonly) {
              <div class="col actions">
                <button
                  type="button"
                  mat-icon-button
                  color="warn"
                  (click)="removeItem(idx)"
                  [attr.aria-label]="'Remove ' + keyLabel"
                  [attr.data-testid]="'delete-row-btn-' + idx"
                >
                  <mat-icon>delete</mat-icon>
                </button>
              </div>
            }
          </div>
        }
      }

      @if (!readonly) {
        @if (!isAddingNew) {
          <!-- Collapsed: Show only "Add" button -->
          <div class="add-trigger" data-testid="add-trigger">
            <button
              type="button"
              mat-stroked-button
              color="primary"
              (click)="startAdding()"
              data-testid="add-row-btn"
            >
              <mat-icon>add</mat-icon>
              Add {{ keyLabel }}
            </button>
          </div>
        } @else {
          <!-- Expanded: Show input fields -->
          <div class="grid-row add-row" data-testid="add-row">
            @if (showRadio) {
              <div class="col radio">
                <mat-radio-button [checked]="false" disabled [attr.aria-label]="'Set current (new) ' + keyLabel"></mat-radio-button>
              </div>
            }
            <div class="col key">
              <mat-form-field appearance="fill" class="field">
                <input
                  #newKeyInput
                  matInput
                  [(ngModel)]="newKey"
                  name="newKey"
                  [placeholder]="keyPlaceholder"
                  (keyup.enter)="addItem()"
                  (keyup.escape)="cancelAdding()"
                  required
                  data-testid="new-key-input"
                />
                @if (!newKey.trim()) {
                  <mat-error>Required</mat-error>
                }
              </mat-form-field>
            </div>
            <div class="col value">
              <mat-form-field appearance="fill" class="field">
                @if (valueType === 'number') {
                  <input
                    matInput
                    type="number"
                    [(ngModel)]="newValue"
                    name="newValue"
                    [placeholder]="valuePlaceholder"
                    (keyup.enter)="addItem()"
                    (keyup.escape)="cancelAdding()"
                    data-testid="new-value-input"
                  />
                } @else {
                  <input
                    matInput
                    [(ngModel)]="newValue"
                    name="newValue"
                    [placeholder]="valuePlaceholder"
                    (keyup.enter)="addItem()"
                    (keyup.escape)="cancelAdding()"
                    data-testid="new-value-input"
                  />
                }
              </mat-form-field>
            </div>
            <!-- Placeholder for boolean columns in add row -->
            @for (col of booleanColumns; track col.field) {
              <div class="col boolean-col">
                <mat-checkbox
                  [checked]="!!newFlags[col.field]"
                  (change)="newFlags[col.field] = $event.checked"
                  [matTooltip]="col.tooltip || col.label"
                  [attr.data-testid]="'boolean-' + col.field + '-new'"
                >
                  @if (col.icon) {
                    <mat-icon class="checkbox-icon">{{ col.icon }}</mat-icon>
                  } @else {
                    <span class="checkbox-label">{{ col.label }}</span>
                  }
                </mat-checkbox>
              </div>
            }
            <div class="col actions add-actions">
              <button
                type="button"
                mat-icon-button
                color="primary"
                (click)="addItem()"
                [disabled]="!newKey.trim()"
                matTooltip="Add (Enter)"
                [attr.aria-label]="'Confirm add ' + keyLabel"
                data-testid="confirm-add-btn"
              >
                <mat-icon>check</mat-icon>
              </button>
              <button
                type="button"
                mat-icon-button
                (click)="cancelAdding()"
                matTooltip="Cancel (Esc)"
                [attr.aria-label]="'Cancel add ' + keyLabel"
                data-testid="cancel-add-btn"
              >
                <mat-icon>close</mat-icon>
              </button>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .key-value-table {
      width: 100%;
    }

    .grid-row {
      display: grid;
      gap: 0.5rem;
      align-items: start;
      margin-bottom: 0.5rem;
    }

    .grid-row:not(.add-row) {
      grid-template-columns: var(--grid-columns, 1fr 1fr auto);
    }

    .add-row {
      grid-template-columns: var(--grid-columns, 1fr 1fr auto);
    }

    .col.radio {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: auto;
    }

    .col {
      display: flex;
      align-items: center;
    }

    .col.key {
      min-width: 0;
    }

    .col.value {
      min-width: 0;
    }

    .col.actions {
      flex-shrink: 0;
      width: auto;
    }

    .field {
      width: 100%;
    }

    .add-row {
      margin-top: 0.5rem;
    }

    .col.boolean-col {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .checkbox-icon {
      font-size: 18px;
      height: 18px;
      width: 18px;
    }

    .checkbox-label {
      font-size: 12px;
    }

    .header-row {
      margin-bottom: 0;
    }

    .header-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: rgba(0, 0, 0, 0.54);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding-bottom: 0.25rem;
    }

    .add-trigger {
      margin-top: 0.5rem;
    }

    .add-trigger button {
      gap: 0.25rem;
    }

    .add-actions {
      display: flex;
      gap: 0;
    }
  `]
})
export class KeyValueTableComponent {
  @Input() items: KeyValuePair[] = [];
  @Input() keyPlaceholder = 'Key';
  @Input() valuePlaceholder = 'Value';
  @Input() keyLabel = 'item';
  @Input() valueType: 'text' | 'number' = 'text';
  @Input() readonly = false;
  @Input() showRadio = false;
  @Input() selectedIndex: number | null = null;
  @Input() booleanColumns: BooleanColumnConfig[] = [];

  @Output() itemsChange = new EventEmitter<KeyValuePair[]>();
  @Output() selectedIndexChange = new EventEmitter<number | null>();

  newKey = '';
  newValue: string | number = '';
  newFlags: Record<string, boolean> = {};
  isAddingNew = false;


  getGridColumns(): string {
    const parts: string[] = [];
    if (this.showRadio) parts.push('40px');
    parts.push('1fr');  // key
    parts.push('1fr');  // value
    for (const _ of this.booleanColumns) {
      parts.push('auto');  // each boolean column
    }
    if (!this.readonly) parts.push('48px');  // actions
    return parts.join(' ');
  }

  onKeyChange(index: number, key: string): void {
    const currentItems = [...this.items];
    currentItems[index].key = key;
    this.items = currentItems;
    this.itemsChange.emit(currentItems);
  }

  onValueChange(index: number, value: string | number): void {
    const currentItems = [...this.items];
    if (this.valueType === 'number') {
      currentItems[index].value = Number(value) || 0;
    } else {
      currentItems[index].value = String(value);
    }
    this.items = currentItems;
    this.itemsChange.emit(currentItems);
  }

  onBooleanChange(index: number, field: string, checked: boolean): void {
    const currentItems = [...this.items];
    const item = currentItems[index];
    if (!item.flags) {
      item.flags = {};
    }
    item.flags[field] = checked;
    this.items = currentItems;
    this.itemsChange.emit(currentItems);
  }

  startAdding(): void {
    this.isAddingNew = true;
    this.newKey = '';
    this.newValue = this.valueType === 'number' ? 0 : '';
    this.newFlags = {};
  }

  cancelAdding(): void {
    this.isAddingNew = false;
    this.newKey = '';
    this.newValue = this.valueType === 'number' ? 0 : '';
    this.newFlags = {};
  }

  addItem(): void {
    const key = String(this.newKey || '').trim();
    const value = this.valueType === 'number'
      ? (Number(this.newValue) || 0)
      : String(this.newValue || '').trim();

    if (!key) {
      return;
    }

    // Prevent duplicate keys
    if (this.items.some((item: KeyValuePair) => item.key === key)) {
      return;
    }

    // Copy flags if any boolean columns are configured
    const flags = this.booleanColumns.length > 0 ? { ...this.newFlags } : undefined;
    const newItem: KeyValuePair = { key, value };
    if (flags && Object.keys(flags).length > 0) {
      newItem.flags = flags;
    }

    const currentItems = [...this.items, newItem];
    this.items = currentItems;
    this.itemsChange.emit(currentItems);

    // Reset and close add form
    this.isAddingNew = false;
    this.newKey = '';
    this.newValue = this.valueType === 'number' ? 0 : '';
    this.newFlags = {};
  }

  removeItem(index: number): void {
    const currentItems = [...this.items];
    const wasSelected = this.selectedIndex === index;
    currentItems.splice(index, 1);
    this.items = currentItems;
    this.itemsChange.emit(currentItems);

    // Update selected index if needed
    if (wasSelected) {
      if (currentItems.length > 0) {
        this.setSelected(0);
      } else {
        this.setSelected(null);
      }
    } else if (this.selectedIndex !== null && this.selectedIndex > index) {
      this.setSelected(this.selectedIndex - 1);
    }
  }

  setSelected(index: number | null): void {
    this.selectedIndex = index;
    this.selectedIndexChange.emit(index);
  }
}
