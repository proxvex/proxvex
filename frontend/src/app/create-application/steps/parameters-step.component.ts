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
    StackSelectorComponent,
    AddonSectionComponent
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
      } @else if (state.installParameters().length === 0 && state.availableAddons().length === 0) {
        <div class="info-container">
          <mat-icon>info</mat-icon>
          <span>No additional parameters required for installation.</span>
        </div>
      } @else {
        <p class="preview-note">Configure parameters and choose how they are stored in the application:</p>

        @if (hasAdvancedParams()) {
          <div class="advanced-toggle">
            <button mat-button (click)="toggleAdvanced()">
              {{ state.showAdvanced() ? 'Hide' : 'Show' }} Advanced Parameters
            </button>
          </div>
        }

        <!-- Stack selector for applications with stacktype -->
        @if (state.selectedStacktypes().length > 0 && state.availableStacks().length > 0) {
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

        @if (state.availableAddons().length > 0) {
          <app-addon-section
            [availableAddons]="state.availableAddons()"
            [selectedAddons]="state.selectedAddons()"
            [expandedAddons]="state.expandedAddons()"
            [form]="state.installForm"
            [showAdvanced]="state.showAdvanced()"
            [availableStacks]="state.availableStacks()"
            (addonToggled)="state.onAddonToggle($event)"
            (addonExpandedChanged)="state.onAddonExpandedToggle($event)"
            (stackSelected)="state.onInstallStackSelected($event)"
          ></app-addon-section>
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

    .preview-note {
      color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
      margin-bottom: 1rem;
      font-style: italic;
    }

    .secrets-selector {
      margin-bottom: 1.5rem;
      padding: 1rem;
      background: #f5f5f5;
      border-radius: 8px;
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
