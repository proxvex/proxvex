import { Component, EventEmitter, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { VeConfigurationService } from '../../ve-configuration.service';
import { IFrameworkApplicationDataBody, IParameterClassification, IUploadFile, ParameterTarget } from '../../../shared/types';

@Component({
  selector: 'app-summary-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatIconModule
  ],
  template: `
    <div class="summary-step">
<<<<<<< HEAD
=======

      <!-- ═══════════════════════════════════════════════════════════════════ -->
      <!-- SECTION 1: Saved in Application                                    -->
      <!-- ═══════════════════════════════════════════════════════════════════ -->
      <div class="section-header section-app">
        <mat-icon>save</mat-icon>
        <div>
          <h2>Saved in Application</h2>
          <p>This configuration is saved permanently and used for every installation.</p>
        </div>
      </div>
>>>>>>> a738729 (feat: refactored create application and ve-configuration-dialog)

      <!-- Application Properties -->
      <mat-card>
        <mat-card-header>
          <mat-card-title>Properties</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <dl class="summary-list">
            <dt>Name:</dt>
            <dd>{{ state.appPropertiesForm.get('name')?.value }}</dd>

            <dt>Application ID:</dt>
            <dd>{{ state.appPropertiesForm.get('applicationId')?.value }}</dd>

            <dt>Description:</dt>
            <dd>{{ state.appPropertiesForm.get('description')?.value }}</dd>

            <dt>Framework:</dt>
            <dd>{{ state.selectedFramework()?.name }}</dd>

            @if (state.selectedTags().length > 0) {
              <dt>Tags:</dt>
              <dd>{{ state.selectedTags().join(', ') }}</dd>
            }

            @if (state.selectedStacktype()) {
              <dt>Stacktype:</dt>
              <dd>{{ state.selectedStacktype() }}</dd>
            }

            @if (state.selectedSupportedAddons().length > 0) {
              <dt>Supported Addons:</dt>
              <dd>{{ state.selectedSupportedAddons().join(', ') }}</dd>
            }

            @if (state.appPropertiesForm.get('url')?.value) {
              <dt>URL:</dt>
              <dd>{{ state.appPropertiesForm.get('url')?.value }}</dd>
            }

            @if (state.appPropertiesForm.get('vendor')?.value) {
              <dt>Vendor:</dt>
              <dd>{{ state.appPropertiesForm.get('vendor')?.value }}</dd>
            }
          </dl>
        </mat-card-content>
      </mat-card>

      <!-- Fixed Parameters -->
      @if (valueParams().length > 0) {
        <mat-card>
          <mat-card-header>
            <mat-card-title>Fixed Parameters</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <p class="section-hint">These values cannot be changed during installation.</p>
            <ul class="param-list">
              @for (p of valueParams(); track p.id) {
                <li><strong>{{ p.name }}</strong>: {{ getParamDisplayValue(p.id) }}</li>
              }
            </ul>
          </mat-card-content>
        </mat-card>
      }

      <!-- Editable Parameters (defaults) -->
      @if (defaultParams().length > 0) {
        <mat-card>
          <mat-card-header>
            <mat-card-title>Editable Parameters</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <p class="section-hint">Pre-filled with these values, but can be changed during installation.</p>
            <ul class="param-list">
              @for (p of defaultParams(); track p.id) {
                <li><strong>{{ p.name }}</strong>: {{ getParamDisplayValue(p.id) }}</li>
              }
            </ul>
          </mat-card-content>
        </mat-card>
      }

      <!-- Upload File Slots -->
      @if (state.getUploadFiles().length > 0) {
        <mat-card data-testid="summary-upload-files">
          <mat-card-header>
            <mat-card-title>Upload Files</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <ul class="upload-files-list">
              @for (file of state.getUploadFiles(); track file.destination; let i = $index) {
                <li [attr.data-testid]="'summary-upload-file-' + i">
                  <strong>{{ getUploadFileLabel(file) }}</strong> → {{ file.destination }}
                  @if (file.required) { <span class="required-badge">Required</span> }
                </li>
              }
            </ul>
          </mat-card-content>
        </mat-card>
      }

      <!-- ═══════════════════════════════════════════════════════════════════ -->
      <!-- SECTION 2: Installation Only                                       -->
      <!-- ═══════════════════════════════════════════════════════════════════ -->
      @if (installOnlyParams().length > 0) {
        <div class="section-header section-install">
          <mat-icon>play_circle</mat-icon>
          <div>
            <h2>Installation Only</h2>
            <p>Used for this installation but not saved in the application. Must be entered again for future installations.</p>
          </div>
        </div>

        <mat-card>
          <mat-card-header>
            <mat-card-title>Parameters</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <ul class="param-list">
              @for (p of installOnlyParams(); track p.id) {
                <li><strong>{{ p.name }}</strong>: {{ getParamDisplayValue(p.id) }}</li>
              }
            </ul>
          </mat-card-content>
        </mat-card>
      }

      <!-- Error Display -->
      @if (state.createError()) {
        <mat-card class="error-card">
          <mat-card-header>
            <mat-card-title>Error</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <p class="error-message">{{ state.createError() }}</p>
            @if (state.createErrorStep() !== null) {
              <button mat-stroked-button color="primary" (click)="onNavigateToErrorStep()">
                Go to Step {{ (state.createErrorStep() ?? 0) + 1 }} to Fix
              </button>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .summary-step {
      padding: 1rem 0;
    }

    /* Section headers */
    .section-header {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
    }

    .section-header mat-icon {
      margin-top: 2px;
      font-size: 24px;
      width: 24px;
      height: 24px;
    }

    .section-header h2 {
      margin: 0;
      font-size: 1.1rem;
    }

    .section-header p {
      margin: 0.25rem 0 0;
      font-size: 0.8rem;
    }

    .section-app {
      background: #e8f5e9;
      border-left: 4px solid #4caf50;
      color: #2e7d32;
    }

    .section-install {
      background: #fff3e0;
      border-left: 4px solid #ff9800;
      color: #e65100;
      margin-top: 1.5rem;
    }

    /* Summary list */
    .summary-list {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.4rem 1rem;
    }

    .summary-list dt {
      font-weight: 500;
    }

    .summary-list dd {
      margin: 0;
    }

    mat-card {
      margin-bottom: 1rem;
    }

    .section-hint {
      margin: 0 0 0.75rem;
      font-size: 0.8rem;
      color: rgba(0, 0, 0, 0.5);
      font-style: italic;
    }

    /* Error */
    .error-card {
      border: 1px solid #f44336;
    }

    .error-message {
      color: #f44336;
    }

    /* Param lists */
    .param-list {
      list-style: none;
      padding: 0;
      margin: 0;
      font-size: 0.9rem;
    }

    .param-list li {
      padding: 0.25rem 0;
    }

    /* Upload files */
    .upload-files-list {
      list-style: none;
      padding: 0;
      margin: 0;
      font-family: monospace;
      font-size: 0.9rem;
    }

    .upload-files-list li {
      padding: 0.4rem 0;
      border-bottom: 1px solid #eee;
    }

    .upload-files-list li:last-child {
      border-bottom: none;
    }

    .required-badge {
      background: #f44336;
      color: white;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.75rem;
      margin-left: 0.5rem;
    }
  `]
})
export class SummaryStepComponent {
  readonly state = inject(CreateApplicationStateService);
  private configService = inject(VeConfigurationService);

  @Output() navigateToStep = new EventEmitter<number>();
  @Output() applicationSaved = new EventEmitter<string>();

  /** Get the display label for an upload file. */
  getUploadFileLabel(file: IUploadFile): string {
    if (file.label) return file.label;
    const colonIndex = file.destination.indexOf(':');
    const filePath = colonIndex >= 0 ? file.destination.slice(colonIndex + 1) : file.destination;
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Classification display helpers
  // ─────────────────────────────────────────────────────────────────────────────

  classifiedParams() {
    return this.state.installParameters().filter(p =>
      !p.advanced && this.state.parameterClassifications().has(p.id)
    );
  }

  private filterByTarget(target: ParameterTarget) {
    return this.state.installParameters().filter(p =>
      !p.advanced && this.state.parameterClassifications().get(p.id) === target
    );
  }

  valueParams() { return this.filterByTarget('value'); }
  defaultParams() { return this.filterByTarget('default'); }
  installOnlyParams() { return this.filterByTarget('install'); }

  getParamDisplayValue(paramId: string): string {
    const value = this.state.installForm.get(paramId)?.value;
    if (value === null || value === undefined || value === '') return '(empty)';
    if (typeof value === 'string' && value.length > 80) return value.substring(0, 80) + '...';
    return String(value);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Application creation
  // ─────────────────────────────────────────────────────────────────────────────

<<<<<<< HEAD
  /**
   * Saves the application and then installs it.
   */
  async saveAndInstall(): Promise<void> {
    const applicationId = await this.saveApplicationOnly();
    if (!applicationId) return;

    if (!this.state.installFormManager) {
      this.state.createError.set('Install form not initialized');
      return;
    }

    this.state.installFormManager.install(applicationId).subscribe({
      next: () => {
        this.state.creating.set(false);
      },
      error: (err: { error?: { error?: string }; message?: string }) => {
        this.state.creating.set(false);
        this.state.createError.set(err?.error?.error || err?.message || 'Installation failed');
      }
    });
  }

  /**
   * Saves the application without installing.
   */
  private saveApplicationOnly(): Promise<string | null> {
    return new Promise((resolve) => {
      const body = this.buildCreateApplicationBody();
      if (!body) {
        resolve(null);
        return;
      }

      this.state.creating.set(true);
      this.state.createError.set(null);
      this.state.createErrorStep.set(null);

      this.configService.createApplicationFromFramework(body).subscribe({
        next: (res) => {
          this.state.creating.set(false);
          if (res.success) {
            this.applicationSaved.emit(body.applicationId);
            resolve(body.applicationId);
          } else {
            this.state.createError.set(`Failed to ${this.state.editMode() ? 'update' : 'create'} application.`);
            resolve(null);
          }
        },
        error: (err: { error?: { error?: string }; message?: string }) => {
          this.state.creating.set(false);
          this.state.createError.set(err?.error?.error || err?.message || 'Failed to save application');
          resolve(null);
        }
      });
    });
  }
=======
>>>>>>> a738729 (feat: refactored create application and ve-configuration-dialog)

  /**
   * Builds the request body for creating/updating an application.
   * Uses parameterClassifications to include only value/default params.
   */
  private buildCreateApplicationBody(): IFrameworkApplicationDataBody & { applicationId: string; update?: boolean } | null {
    const selectedFramework = this.state.selectedFramework();
    if (!selectedFramework || this.state.appPropertiesForm.invalid || this.state.parameterForm.invalid) {
      return null;
    }

    const selectedIconFile = this.state.selectedIconFile();
    const iconContent = this.state.iconContent();
    const applicationId = this.state.editMode()
      ? this.state.editApplicationId()
      : this.state.appPropertiesForm.get('applicationId')?.value;

    // Collect parameter values from framework step (Step 1/3 original params)
    const parameterValues = this.state.collectParameterValues();

    // Build classifications from the classification map
    const classifications: IParameterClassification[] = [];
    for (const [paramId, target] of this.state.parameterClassifications()) {
      if (target !== 'install') {
        classifications.push({ id: paramId, target });
      }
    }

    // Add SSL properties as 'value' classifications (stored in application.json properties)
    for (const sslProp of this.state.collectSslProperties()) {
      classifications.push({ id: sslProp.id, target: 'value' });
    }

    return {
      frameworkId: selectedFramework.id,
      applicationId,
      name: this.state.appPropertiesForm.get('name')?.value,
      description: this.state.appPropertiesForm.get('description')?.value,
      url: this.state.appPropertiesForm.get('url')?.value || undefined,
      documentation: this.state.appPropertiesForm.get('documentation')?.value || undefined,
      source: this.state.appPropertiesForm.get('source')?.value || undefined,
      vendor: this.state.appPropertiesForm.get('vendor')?.value || undefined,
      ...(selectedIconFile && iconContent && {
        icon: selectedIconFile.name,
        iconContent: iconContent,
      }),
      ...(!selectedIconFile && iconContent && this.state.editMode() && {
        iconContent: iconContent,
      }),
      ...(this.state.selectedTags().length > 0 && { tags: this.state.selectedTags() }),
<<<<<<< HEAD
      ...(this.state.selectedStacktype() && { stacktype: this.state.selectedStacktype() ?? undefined }),
=======
      ...(this.state.selectedStacktypes().length > 0 && { stacktype: this.state.selectedStacktypes().length === 1 ? this.state.selectedStacktypes()[0] : this.state.selectedStacktypes() }),
      ...(this.state.selectedSupportedAddons().length > 0 && { supported_addons: this.state.selectedSupportedAddons() }),
>>>>>>> 40267ab (feat: Dependency resolution in application and addon)
      parameterValues,
      ...(classifications.length > 0 && { parameterClassifications: classifications }),
      ...(this.state.getUploadFiles().length > 0 && { uploadfiles: this.state.getUploadFiles() }),
      ...(this.state.editMode() && { update: true }),
    };
  }


  createApplication(): void {
    const body = this.buildCreateApplicationBody();
    if (!body) return;

    this.state.creating.set(true);
    this.state.createError.set(null);
    this.state.createErrorStep.set(null);

    this.configService.createApplicationFromFramework(body).subscribe({
      next: (res) => {
        this.state.creating.set(false);
        if (res.success) {
          this.applicationSaved.emit(body.applicationId);
        } else {
          this.state.createError.set(`Failed to ${this.state.editMode() ? 'update' : 'create'} application.`);
        }
      },
      error: (err: { error?: { error?: string }; message?: string }) => {
        this.state.creating.set(false);
        const errorMessage = err?.error?.error || err?.message || 'Failed to create application';

        let targetStep: number | null = null;
        if (errorMessage.includes('already exists') || errorMessage.includes('Application') && errorMessage.includes('exists')) {
          targetStep = 1;
          this.state.createError.set(`Application ID "${body.applicationId}" already exists. Please choose a different ID.`);
        } else if (errorMessage.includes('applicationId') || errorMessage.includes('Missing applicationId')) {
          targetStep = 1;
          this.state.createError.set(errorMessage);
        } else if (errorMessage.includes('name') || errorMessage.includes('Missing name')) {
          targetStep = 1;
          this.state.createError.set(errorMessage);
        } else if (errorMessage.includes('parameter') || errorMessage.includes('Parameter')) {
          targetStep = 2;
          this.state.createError.set(errorMessage);
        } else {
          this.state.createError.set(errorMessage);
        }

        this.state.createErrorStep.set(targetStep);
      }
    });
  }

  onNavigateToErrorStep(): void {
    const errorStep = this.state.createErrorStep();
    if (errorStep !== null) {
      this.navigateToStep.emit(errorStep);
    }
  }

  clearError(): void {
    this.state.clearError();
  }
}
