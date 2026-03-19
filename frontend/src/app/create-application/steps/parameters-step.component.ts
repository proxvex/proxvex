import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ParameterTarget } from '../../../shared/types';
import { CreateApplicationStateService } from '../services/create-application-state.service';
import { ParameterGroupComponent } from '../../ve-configuration-dialog/parameter-group.component';
import { StackSelectorComponent } from '../../shared/components/stack-selector/stack-selector.component';
import { AddonSectionComponent } from '../../shared/components/addon-section/addon-section.component';

@Component({
  selector: 'app-parameters-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ParameterGroupComponent,
    StackSelectorComponent
  ],
  template: `
    <div class="step-content">
      @if (state.loadingInstallParameters()) {
        <div class="loading-container">
          <mat-spinner diameter="32"></mat-spinner>
          <span>Loading parameters...</span>
        </div>
      } @else if (state.installParametersError()) {
        <div class="error-container">
          <mat-icon>error</mat-icon>
          <span>{{ state.installParametersError() }}</span>
          <button mat-button color="primary" (click)="state.loadInstallParameters()">Retry</button>
        </div>
      } @else if (state.installParameters().length === 0) {
        <div class="info-container">
          <mat-icon>info</mat-icon>
          <span>No additional parameters required for installation.</span>
        </div>
      } @else {
        <div class="classification-legend">
          <p class="legend-title">Choose how each parameter is handled in the application:</p>
          <div class="legend-items">
            <span class="legend-item"><strong>Fixed</strong> — Value is saved and cannot be changed during installation</span>
            <span class="legend-item"><strong>Editable</strong> — Value is pre-filled but can be changed during installation</span>
            <span class="legend-item"><strong>Ask</strong> — User must enter this value at every installation</span>
          </div>
        </div>

        @if (hasAdvancedParams()) {
          <div class="advanced-toggle">
            <button mat-button (click)="toggleAdvanced()">
              {{ state.showAdvanced() ? 'Hide' : 'Show' }} Advanced Parameters
            </button>
          </div>
        }

        <!-- Stack selector for applications with stacktype -->
        @if (state.selectedStacktype() && state.availableStacks().length > 0) {
          <div class="secrets-selector">
            <app-stack-selector
              [availableStacks]="state.availableStacks()"
              [selectedStack]="state.selectedInstallStack"
              [label]="'Secrets'"
              [showCreateButton]="false"
              [showManageLink]="true"
              [showEntryCount]="false"
              [showDefaultHint]="true"
              (stackSelected)="state.onInstallStackSelected($event)"
            ></app-stack-selector>
          </div>
        }

        @for (groupName of groupNames; track groupName) {
          <app-parameter-group
            [groupName]="groupName"
            [groupedParameters]="state.installParametersGrouped()"
            [form]="state.installForm"
            [showAdvanced]="state.showAdvanced()"
            [showClassification]="true"
            [parameterClassifications]="state.parameterClassifications()"
            [availableStacks]="state.availableStacks()"
            (classificationChanged)="onClassificationChanged($event)"
            (stackSelected)="state.onInstallStackSelected($event)"
          ></app-parameter-group>
        }

      }
    </div>
  `,
  styles: [`
    .step-content {
      padding: 1rem 0;
    }

    .advanced-toggle {
      margin-bottom: 1rem;
    }

    .loading-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 2rem;
      color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
    }

    .error-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: #ffebee;
      border-radius: 4px;
      color: #c62828;
    }

    .info-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: #e3f2fd;
      border-radius: 4px;
      color: #1565c0;
    }

    .classification-legend {
      margin-bottom: 1.5rem;
      padding: 0.75rem 1rem;
      background: #e8eaf6;
      border-radius: 8px;
      border-left: 4px solid #3f51b5;

      .legend-title {
        margin: 0 0 0.5rem 0;
        font-weight: 500;
        color: #283593;
        font-size: 0.9rem;
      }

      .legend-items {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 1.5rem;
      }

      .legend-item {
        font-size: 0.8rem;
        color: #37474f;
      }
    }

  `]
})
export class ParametersStepComponent {
  readonly state = inject(CreateApplicationStateService);

  toggleAdvanced(): void {
    this.state.showAdvanced.set(!this.state.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.state.installParameters().some(p => p.advanced);
  }

  get groupNames(): string[] {
    return Object.keys(this.state.installParametersGrouped());
  }

  onClassificationChanged(event: { paramId: string; target: ParameterTarget }): void {
    this.state.updateClassification(event.paramId, event.target);
  }
}
