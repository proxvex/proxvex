import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, AsyncValidatorFn, AbstractControl, ValidationErrors } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { Observable, Subject, of } from 'rxjs';
import { map, catchError, takeUntil } from 'rxjs/operators';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { IconUploadComponent, IconSelectedEvent } from '../components/icon-upload.component';
import { TagsSelectorComponent } from '../components/tags-selector.component';
import { CacheService } from '../../shared/services/cache.service';
import { VeConfigurationService } from '../../ve-configuration.service';
import { ITagsConfig } from '../../../shared/types';

@Component({
  selector: 'app-properties-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatExpansionModule,
    MatIconModule,
    IconUploadComponent,
    TagsSelectorComponent
  ],
  template: `
    <div class="step-content">
      <form [formGroup]="appPropertiesForm">
        <!-- Identity row: Icon left, Name + ID right -->
        <div class="identity-row">
          <app-icon-upload
            [iconPreview]="state.iconPreview()"
            (iconSelected)="onIconSelected($event)"
            (iconRemoved)="onIconRemoved()"
          ></app-icon-upload>

          <div class="identity-fields">
            <div class="name-id-row">
              <mat-form-field appearance="outline" class="field-name">
                <mat-label>Application Name</mat-label>
                <input matInput formControlName="name" data-testid="app-name-input" required />
                @if (appPropertiesForm.get('name')?.hasError('required') && appPropertiesForm.get('name')?.touched) {
                  <mat-error>Required</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline" class="field-id">
                <mat-label>Application ID</mat-label>
                <input matInput formControlName="applicationId" data-testid="app-id-input" required (input)="onApplicationIdInput($event)" />
                <mat-hint>a-z, 0-9, hyphens</mat-hint>
                @if (appPropertiesForm.get('applicationId')?.hasError('required') && appPropertiesForm.get('applicationId')?.touched) {
                  <mat-error>Required</mat-error>
                }
                @if (appPropertiesForm.get('applicationId')?.hasError('pattern') && appPropertiesForm.get('applicationId')?.touched) {
                  <mat-error>Only a-z, 0-9, hyphens</mat-error>
                }
                @if (appPropertiesForm.get('applicationId')?.hasError('applicationIdTaken') && appPropertiesForm.get('applicationId')?.touched) {
                  <mat-error>ID already exists</mat-error>
                }
                @if (appPropertiesForm.get('applicationId')?.pending) {
                  <mat-hint align="end">Checking...</mat-hint>
                }
              </mat-form-field>
            </div>

            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Description</mat-label>
              <textarea matInput formControlName="description" data-testid="app-description-input" required rows="2"></textarea>
              @if (appPropertiesForm.get('description')?.hasError('required') && appPropertiesForm.get('description')?.touched) {
                <mat-error>Required</mat-error>
              }
            </mat-form-field>
          </div>
        </div>

        <!-- Stacktype + Tags side by side -->
        <div class="tags-stack-row">
          @if (state.stacktypes().length > 0) {
            <mat-form-field appearance="outline" class="field-stacktype">
              <mat-label>Stacktypes</mat-label>
              <mat-select [value]="state.selectedStacktypes()" (selectionChange)="onStacktypeChange($event.value)" multiple>
                @for (st of state.stacktypes(); track st.name) {
                  <mat-option [value]="st.name">{{ st.name }}</mat-option>
                }
              </mat-select>
              <mat-hint>Shared environment variables</mat-hint>
            </mat-form-field>
          }

          <div class="tags-wrapper">
            <app-tags-selector
              [tagsConfig]="tagsConfig"
              [selectedTags]="state.selectedTags()"
              (tagToggled)="onTagToggle($event)"
            ></app-tags-selector>
          </div>
        </div>

        <!-- Optional metadata: collapsed -->
        <mat-expansion-panel class="metadata-panel">
          <mat-expansion-panel-header>
            <mat-panel-title>
              <mat-icon>link</mat-icon>
              Additional Metadata
            </mat-panel-title>
            <mat-panel-description>URL, Documentation, Source, Vendor</mat-panel-description>
          </mat-expansion-panel-header>

          <div class="metadata-grid">
            <mat-form-field appearance="outline">
              <mat-label>URL</mat-label>
              <input matInput formControlName="url" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Documentation URL</mat-label>
              <input matInput formControlName="documentation" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Source URL</mat-label>
              <input matInput formControlName="source" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Vendor</mat-label>
              <input matInput formControlName="vendor" />
            </mat-form-field>
          </div>
        </mat-expansion-panel>
      </form>
    </div>
  `,
  styles: [`
    .step-content {
      padding: 1rem 0;
    }

    .full-width {
      width: 100%;
    }

    /* Identity row: icon left, fields right */
    .identity-row {
      display: flex;
      gap: 1.5rem;
      align-items: flex-start;
      margin-bottom: 0.5rem;
    }

    .identity-fields {
      flex: 1;
      min-width: 0;
    }

    .name-id-row {
      display: flex;
      gap: 1rem;
    }

    .field-name {
      flex: 1;
    }

    .field-id {
      flex: 1;
    }

    /* Tags + Stacktype row */
    .tags-stack-row {
      display: flex;
      gap: 1.5rem;
      align-items: flex-start;
      margin-bottom: 1rem;
    }

    .field-stacktype {
      width: 220px;
      flex-shrink: 0;
    }

    .tags-wrapper {
      flex: 1;
      min-width: 0;
    }

    /* Collapsed metadata */
    .metadata-panel {
      margin-top: 0.5rem;
    }

    .metadata-panel mat-icon {
      margin-right: 0.5rem;
      font-size: 20px;
      color: rgba(0, 0, 0, 0.54);
    }

    .metadata-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 1rem;
    }
  `]
})
export class AppPropertiesStepComponent implements OnInit, OnDestroy {
  readonly state = inject(CreateApplicationStateService);
  private cacheService = inject(CacheService);
  private configService = inject(VeConfigurationService);
  private destroy$ = new Subject<void>();

  // Tags config loaded directly (simplified, similar to framework names)
  tagsConfig: ITagsConfig | null = null;

  get appPropertiesForm() {
    return this.state.appPropertiesForm;
  }

  ngOnInit(): void {
    // Load tags config directly
    this.loadTagsConfig();
    // Load stacktypes
    this.state.loadStacktypes();
    // Set up async validator for application ID uniqueness
    const applicationIdControl = this.appPropertiesForm.get('applicationId');
    if (applicationIdControl && !applicationIdControl.asyncValidator) {
      applicationIdControl.setAsyncValidators([this.applicationIdUniqueValidator()]);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Custom async validator for application ID uniqueness
   */
  applicationIdUniqueValidator(): AsyncValidatorFn {
    return (control: AbstractControl): Observable<ValidationErrors | null> => {
      const applicationId = control.value;

      // In edit mode, skip validation for the current application ID
      if (this.state.editMode() && applicationId === this.state.editApplicationId()) {
        return of(null);
      }

      // If empty, don't validate (required validator will handle it)
      if (!applicationId || !applicationId.trim()) {
        return of(null);
      }

      // Check against cache
      return this.cacheService.isApplicationIdTaken(applicationId.trim()).pipe(
        map(isTaken => {
          if (isTaken) {
            return { applicationIdTaken: true };
          }
          return null;
        }),
        catchError(() => {
          // On error, don't block the user - validation will happen on submit
          return of(null);
        })
      );
    };
  }

  onApplicationIdInput(_event: Event): void {
    // Sync hostname with applicationId for oci-image and docker-compose frameworks
    this.state.syncHostnameWithApplicationId();
  }

  onIconSelected(event: IconSelectedEvent): void {
    this.state.selectedIconFile.set(event.file);
    this.state.iconContent.set(event.content);
    this.state.iconPreview.set(event.preview);
  }

  onIconRemoved(): void {
    this.state.selectedIconFile.set(null);
    this.state.iconContent.set(null);
    this.state.iconPreview.set(null);
  }

  onTagToggle(tagId: string): void {
    this.state.toggleTag(tagId);
  }

  onStacktypeChange(stacktypes: string[]): void {
    this.state.selectedStacktypes.set(stacktypes);
  }

  /**
   * Load tags configuration directly (simplified, similar to framework names).
   * This avoids async signal issues in Playwright tests.
   */
  private loadTagsConfig(): void {
    this.configService.getTagsConfig().pipe(
      takeUntil(this.destroy$)
    ).subscribe({
      next: (config) => {
        this.tagsConfig = config;
      },
      error: (err) => {
        console.error('Failed to load tags config', err);
      }
    });
  }
}
