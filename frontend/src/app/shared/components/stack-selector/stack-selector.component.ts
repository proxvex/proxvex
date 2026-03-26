import { Component, Input, Output, EventEmitter } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IStack } from '../../../../shared/types';

/**
 * Reusable Stack Selector Component
 *
 * Used in:
 * - ve-configuration-dialog (global "Secrets" selector)
 * - parameter-group (for env_file/envs parameters with markers)
 * - summary-step (optional stack selection)
 */
@Component({
  selector: 'app-stack-selector',
  standalone: true,
  imports: [
    MatFormFieldModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule
  ],
  template: `
    @if (detectedMarkers.length > 0) {
      <div class="detected-markers">
        Detected markers: {{ detectedMarkers.join(', ') }}
      </div>
    }
    <div class="stack-selector-row">
      <mat-form-field appearance="outline" class="stack-select-field">
        <mat-label>{{ label }}</mat-label>
        <mat-select [value]="selectedStack" (selectionChange)="onStackChange($event.value)">
          @for (stack of availableStacks; track stack.id) {
            <mat-option [value]="stack">
              {{ stack.name }}
              @if (showEntryCount) {
                ({{ stack.entries.length }} vars)
              }
              @if (stack.name.toLowerCase() === 'default' && showDefaultHint) {
                <span class="default-stack-hint">(keeps hostname)</span>
              }
            </mat-option>
          }
        </mat-select>
        @if (showManageLink) {
          <a mat-icon-button matSuffix [href]="getManageLink()" target="_blank"
             matTooltip="Manage Secrets" (click)="$event.stopPropagation()">
            <mat-icon>edit</mat-icon>
          </a>
        }
      </mat-form-field>
      @if (showCreateButton) {
        <button mat-icon-button type="button" (click)="onCreateStack()"
                matTooltip="Create new secrets" class="create-stack-btn">
          <mat-icon>add</mat-icon>
        </button>
      }
    </div>
  `,
  styles: [`
    .stack-selector-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .stack-select-field {
      flex: 1;
    }

    .detected-markers {
      font-size: 12px;
      color: #666;
      margin-bottom: 8px;
      padding: 4px 8px;
      background: #f5f5f5;
      border-radius: 4px;
    }

    .default-stack-hint {
      font-size: 12px;
      color: #666;
      margin-left: 4px;
    }

    .create-stack-btn {
      margin-top: 8px;
    }
  `]
})
export class StackSelectorComponent {
  /** Available stacks to select from */
  @Input() availableStacks: IStack[] = [];

  /** Currently selected stack */
  @Input() selectedStack: IStack | null = null;

  /** Label for the select field */
  @Input() label = 'Select Secrets';

  /** Show create button */
  @Input() showCreateButton = true;

  /** Show manage link (edit icon to /stacks) */
  @Input() showManageLink = false;

  /** Optional stacktype for manage link query param */
  @Input() manageLinkStacktype = '';

  /** Show entry count in options */
  @Input() showEntryCount = true;

  /** Show "(keeps hostname)" hint for default stack */
  @Input() showDefaultHint = false;

  /** Detected markers (for env_file/envs) */
  @Input() detectedMarkers: string[] = [];

  /** Emits when a stack is selected */
  @Output() stackSelected = new EventEmitter<IStack>();

  /** Emits when create button is clicked */
  @Output() createStackRequested = new EventEmitter<void>();

  getManageLink(): string {
    return this.manageLinkStacktype ? `/stacks?stacktype=${this.manageLinkStacktype}` : '/stacks';
  }

  onStackChange(stack: IStack): void {
    this.stackSelected.emit(stack);
  }

  onCreateStack(): void {
    this.createStackRequested.emit();
  }
}
