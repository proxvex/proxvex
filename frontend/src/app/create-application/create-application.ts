import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { MatTooltipModule } from '@angular/material/tooltip';
import { debounceTime, distinctUntilChanged, Subject, takeUntil } from 'rxjs';

import { IApplicationWeb, IFrameworkName, IParameter, IPostFrameworkFromImageResponse } from '../../shared/types';
import { VeConfigurationDialog, VeConfigurationDialogData } from '../ve-configuration-dialog/ve-configuration-dialog';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { CreateApplicationStateService } from './services/create-application-state.service';
import { AppPropertiesStepComponent } from './steps/app-properties-step.component';
import { FrameworkStepComponent } from './steps/framework-step.component';
import { ParametersStepComponent } from './steps/parameters-step.component';
import { SslStepComponent } from './steps/ssl-step.component';
import { UploadFilesStepComponent } from './steps/upload-files-step.component';
import { SummaryStepComponent } from './steps/summary-step.component';

@Component({
  selector: 'app-create-application',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatStepperModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonToggleModule,
    MatChipsModule,
    MatDialogModule,
    AppPropertiesStepComponent,
    FrameworkStepComponent,
    ParametersStepComponent,
    SslStepComponent,
    UploadFilesStepComponent,
    SummaryStepComponent
  ],
  templateUrl: './create-application.html',
  styleUrls: ['./create-application.scss']
})
export class CreateApplication implements OnInit, OnDestroy {
  @ViewChild('stepper') stepper!: MatStepper;
  @ViewChild(SummaryStepComponent) summaryStep: SummaryStepComponent | undefined;
  @ViewChild(UploadFilesStepComponent) uploadFilesStep: UploadFilesStepComponent | undefined;

  // Inject services
  private configService = inject(VeConfigurationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private errorHandler = inject(ErrorHandlerService);
  private cacheService = inject(CacheService);
  private composeService = inject(DockerComposeService);
  private dialog = inject(MatDialog);

  // State Service - holds all shared state
  readonly state = inject(CreateApplicationStateService);

  // ─────────────────────────────────────────────────────────────────────────────
  // Delegate to State Service signals
  // ─────────────────────────────────────────────────────────────────────────────

  // Edit mode
  get editMode() { return this.state.editMode; }
  get editApplicationId() { return this.state.editApplicationId; }
  get loadingEditData() { return this.state.loadingEditData; }

  // Step 1: Framework selection
  get frameworks() { return this.state.frameworks(); }
  get selectedFramework() { return this.state.selectedFramework(); }
  set selectedFramework(value: IFrameworkName | null) { this.state.selectedFramework.set(value); }

  // OCI Image
  get imageReference() { return this.state.imageReference; }
  get loadingImageAnnotations() { return this.state.loadingImageAnnotations; }
  get imageError() { return this.state.imageError; }
  get imageAnnotationsReceived() { return this.state.imageAnnotationsReceived; }

  // OCI install mode
  get ociInstallMode() { return this.state.ociInstallMode; }

  // Step 2: App properties
  get appPropertiesForm() { return this.state.appPropertiesForm; }

  // Icon
  get iconPreview() { return this.state.iconPreview; }
  get iconContent() { return this.state.iconContent; }

  // Tags
  get tagsConfig() { return this.state.tagsConfig; }
  get selectedTags() { return this.state.selectedTags; }

  // Docker Compose
  get parsedComposeData() { return this.state.parsedComposeData; }
  get selectedServiceName() { return this.state.selectedServiceName; }
  get composeServices() { return this.state.composeServices; }
  get requiredEnvVars() { return this.state.requiredEnvVars; }
  get missingEnvVars() { return this.state.missingEnvVars; }
  get composeProperties() { return this.state.composeProperties; }

  // Step 3: Parameters
  get parameters() { return this.state.parameters(); }
  set parameters(value: IParameter[]) { this.state.parameters.set(value); }
  get parameterForm() { return this.state.parameterForm; }

  // Step 4: Summary
  get creating() { return this.state.creating; }
  get createError() { return this.state.createError; }
  get createErrorStep() { return this.state.createErrorStep; }

  // ─────────────────────────────────────────────────────────────────────────────
  // Local state (component-specific, not shared)
  // ─────────────────────────────────────────────────────────────────────────────
  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.cacheService.preloadAll();
    // Tags are now loaded directly in app-properties-step.component.ts

    // Subscribe to debounced image input from state service
    this.state.imageInputSubject.pipe(
      takeUntil(this.destroy$),
      debounceTime(500),
      distinctUntilChanged()
    ).subscribe((imageRef: string) => {
      if (imageRef && imageRef.trim()) {
        this.state.updateOciImageParameter(imageRef);
        // In edit mode, don't fetch annotations automatically - user already has their data
        if (!this.editMode()) {
          this.state.fetchImageAnnotations(imageRef.trim());
        }
      } else {
        this.imageError.set(null);
        this.loadingImageAnnotations.set(false);
        if (this.parameterForm.get('oci_image')) {
          this.parameterForm.patchValue({ oci_image: '' }, { emitEvent: false });
        }
      }
    });

    // Check for edit mode via query parameter
    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const applicationId = params['applicationId'];
      if (applicationId) {
        this.editMode.set(true);
        this.editApplicationId.set(applicationId);
        this.loadEditData(applicationId);
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadEditData(applicationId: string): void {
    this.loadingEditData.set(true);

    this.configService.getApplicationFrameworkData(applicationId).subscribe({
      next: (data) => {
        // Set framework
        const framework = this.frameworks.find(f => f.id === data.frameworkId);
        if (framework) {
          this.selectedFramework = framework;

          // Load parameters first, then fill with edit data
          this.configService.getFrameworkParameters(data.frameworkId).subscribe({
            next: (res) => {
              this.parameters = res.parameters;
              this.state.setupParameterForm();

              // Fill application properties form
              this.appPropertiesForm.patchValue({
                name: data.name,
                applicationId: data.applicationId,
                description: data.description,
                url: data.url || '',
                documentation: data.documentation || '',
                source: data.source || '',
                vendor: data.vendor || '',
              }, { emitEvent: false });

              // Disable applicationId field in edit mode
              this.appPropertiesForm.get('applicationId')?.disable();

              // Fill icon if present
              if (data.iconContent) {
                this.iconContent.set(data.iconContent);
                const iconType = data.icon?.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
                this.iconPreview.set(`data:${iconType};base64,${data.iconContent}`);
              }

              // Fill tags if present
              if (data.tags && data.tags.length > 0) {
                this.selectedTags.set(data.tags);
              }

              // Fill stacktype if present
              if (data.stacktype) {
                const st = Array.isArray(data.stacktype) ? data.stacktype[0] : data.stacktype;
                this.state.selectedStacktype.set(st);
              }

              // Fill supported addons if present
              if (data.supported_addons?.length) {
                this.state.selectedSupportedAddons.set(data.supported_addons);
              }

              // Fill supported addons if present
              if (data.supported_addons?.length) {
                this.state.selectedSupportedAddons.set(data.supported_addons);
              }

              // Fill parameter values
              for (const pv of data.parameterValues) {
                const ctrl = this.parameterForm.get(pv.id);
                if (ctrl) {
                  ctrl.patchValue(pv.value, { emitEvent: false });
                }

                // Special handling for oci_image - also set imageReference signal
                if (pv.id === 'oci_image' && typeof pv.value === 'string') {
                  this.imageReference.set(pv.value);
                }

                // Special handling for compose_file - parse it
                if (pv.id === 'compose_file' && typeof pv.value === 'string' && pv.value.trim()) {
                  const parsed = this.composeService.parseComposeFile(pv.value);
                  if (parsed) {
                    this.parsedComposeData.set(parsed);
                    this.composeServices.set(parsed.services);
                    this.composeProperties.set(parsed.properties);
                    if (parsed.services.length > 0) {
                      this.selectedServiceName.set(parsed.services[0].name);
                    }
                    // Set install mode to compose if compose_file is present
                    this.ociInstallMode.set('compose');
                  }
                }

                // Restore SSL properties
                if (pv.id === 'ssl.mode' && typeof pv.value === 'string') {
                  this.state.sslMode.set(pv.value as 'proxy' | 'native' | 'certs');
                }
                if (pv.id === 'ssl.needs_server_cert') {
                  this.state.sslNeedsServerCert.set(String(pv.value) === 'true');
                }
                if (pv.id === 'ssl.needs_ca_cert') {
                  this.state.sslNeedsCaCert.set(String(pv.value) === 'true');
                }
                if (pv.id === 'ssl.addon_volumes' && typeof pv.value === 'string') {
                  this.state.sslAddonVolumes.set(pv.value);
                }
              }

              this.loadingEditData.set(false);

              // Navigate to step 2 after view is ready
              setTimeout(() => {
                if (this.stepper) {
                  this.stepper.selectedIndex = 1;
                }
              }, 100);
            },
            error: (err) => {
              this.errorHandler.handleError('Failed to load framework parameters', err);
              this.loadingEditData.set(false);
            }
          });
        } else {
          this.errorHandler.handleError('Framework not found', new Error(`Framework ${data.frameworkId} not found`));
          this.loadingEditData.set(false);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load application data', err);
        this.loadingEditData.set(false);
        // Navigate back to applications list on error
        this.router.navigate(['/applications']);
      }
    });
  }

  onFrameworkSelected(_frameworkId: string): void {
    // Ensure compose controls exist immediately for docker-compose framework
    // This prevents template errors before loadParameters() completes
    if (this.isDockerComposeFramework()) {
      this.state.ensureComposeControls({ requireComposeFile: true });
    }
    // Also ensure compose controls for oci-image in compose mode
    if (this.isOciImageFramework() && this.state.ociInstallMode() === 'compose') {
      this.state.ensureComposeControls({ requireComposeFile: true });
    }
    // Parameters are loaded when transitioning from Step 1 to Step 2 (onStepChange)
  }

  onInstallModeChanged(mode: 'image' | 'compose'): void {
    if (mode === 'compose') {
      this.state.ensureComposeControls({ requireComposeFile: true });
    } else {
      this.state.setComposeFileRequired(false);
      this.state.updateEnvFileRequirement();
      this.state.refreshEnvSummary();
    }
  }


  onServiceSelected(_serviceName: string): void {
    if (this.isOciComposeMode()) {
      this.state.updateImageFromCompose();
      this.state.updateInitialCommandFromCompose();
      this.state.updateUserFromCompose();
      this.state.fillEnvsForSelectedService();
    }
    this.state.updateEnvFileRequirement();
  }

  canProceedToStep2(): boolean {
    if (!this.selectedFramework) {
      return false;
    }

    // For oci-image framework
    if (this.isOciImageFramework()) {
      if (this.ociInstallMode() === 'compose') {
        const composeFile = this.parameterForm.get('compose_file')?.value;
        const hasCompose = !!composeFile && String(composeFile).trim().length > 0 && this.parsedComposeData() !== null;
        const hasImage = this.imageReference().trim().length > 0;
        return hasCompose && hasImage;
      }
      return this.imageReference().trim().length > 0;
    }

    // For docker-compose framework, require compose_file
    if (this.isDockerComposeFramework()) {
      const composeFile = this.parameterForm.get('compose_file')?.value;
      return composeFile && composeFile.trim().length > 0 && this.parsedComposeData() !== null;
    }

    return true;
  }

  onStepChange(event: { selectedIndex: number; previouslySelectedIndex: number }): void {
    // When moving FROM Step 1 TO Step 2 (not when going back from Step 3 to Step 2)
    if (event.selectedIndex === 1 && event.previouslySelectedIndex === 0) {
      const framework = this.state.selectedFramework();
      if (framework) {
        this.state.loadParameters(framework.id);
      }

      // Fill fields from annotations if they were already loaded
      const lastResponse = this.state.lastAnnotationsResponse();
      if (lastResponse) {
        // Use setTimeout to ensure the form is fully rendered
        setTimeout(() => {
          this.state.fillFieldsFromAnnotations(lastResponse);
        }, 0);
      }
    }

    // When entering Step 3 (Configure Parameters), load install parameters preview
    if (event.selectedIndex === 2 && event.previouslySelectedIndex < 2) {
      setTimeout(() => {
        this.state.loadInstallParameters();
      }, 0);
    }

    // When leaving Step 5 (Upload Files), auto-confirm any pending new file entry
    if (event.previouslySelectedIndex === 4) {
      this.uploadFilesStep?.autoConfirmPendingAdd();
    }
  }

  canProceedToStep3(): boolean {
    if (this.appPropertiesForm.invalid) {
      this.appPropertiesForm.markAllAsTouched();
      return false;
    }
    return true;
  }

  canProceedToStep4(): boolean {
    if (this.parameterForm.invalid) {
      this.parameterForm.markAllAsTouched();
      return false;
    }
    return true;
  }

  createApplication(): void {
    this.summaryStep?.createApplication();
  }

  onApplicationSaved(applicationId: string): void {
    // Build a minimal IApplicationWeb to open the install dialog
    const app: IApplicationWeb = {
      id: applicationId,
      name: this.state.appPropertiesForm.get('name')?.value ?? applicationId,
      description: this.state.appPropertiesForm.get('description')?.value ?? '',
      source: 'local',
      framework: this.state.selectedFramework()?.id,
      tags: this.state.selectedTags(),
      stacktype: this.state.selectedStacktype() ?? undefined,
    };

    // Navigate to applications list first
    this.router.navigate(['/applications']).then(() => {
      // Open install dialog
      const dialogData: VeConfigurationDialogData = { app, task: 'installation' };
      this.dialog.open(VeConfigurationDialog, { data: dialogData });
    });
  }

  saveAndInstall(): void {
    this.summaryStep?.saveAndInstall();
  }

  onApplicationSaved(applicationId: string): void {
    // Build a minimal IApplicationWeb to open the install dialog
    const app: IApplicationWeb = {
      id: applicationId,
      name: this.state.appPropertiesForm.get('name')?.value ?? applicationId,
      description: this.state.appPropertiesForm.get('description')?.value ?? '',
      source: 'local',
      framework: this.state.selectedFramework()?.id,
      tags: this.state.selectedTags(),
      stacktype: this.state.selectedStacktypes().length > 0 ? (this.state.selectedStacktypes().length === 1 ? this.state.selectedStacktypes()[0] : this.state.selectedStacktypes()) : undefined,
    };

    // Navigate to applications list first
    this.router.navigate(['/applications']).then(() => {
      // Open install dialog
      const dialogData: VeConfigurationDialogData = { app, task: 'installation' };
      this.dialog.open(VeConfigurationDialog, { data: dialogData });
    });
  }

  onNavigateToStep(stepIndex: number): void {
    if (this.stepper) {
      this.stepper.selectedIndex = stepIndex;

      // Mark the form field as touched to show validation errors after navigation
      setTimeout(() => {
        if (stepIndex === 1) {
          // Step 2 - mark applicationId field as touched if it's an ID error
          const errorMessage = this.createError();
          if (errorMessage && (errorMessage.includes('already exists') || errorMessage.includes('applicationId'))) {
            this.appPropertiesForm.get('applicationId')?.markAsTouched();
          }
        }
      }, 100);
    }
  }

  getImageReferenceTooltip(): string {
    return `Enter an OCI image reference:
• Docker Hub: image:tag or owner/image:tag (e.g., mariadb:latest, nodered/node-red:latest)
• GitHub Container Registry: ghcr.io/owner/image:tag (e.g., ghcr.io/home-assistant/home-assistant:latest)
• Tag is optional and defaults to 'latest' if not specified
The system will automatically fetch metadata from the image and pre-fill application properties.`;
  }

  cancel(): void {
    this.router.navigate(['/applications']);
  }

  // --- CONSOLIDATED: framework helpers used by template ---
  isOciImageFramework(): boolean {
    return this.selectedFramework?.id === 'oci-image';
  }

  isDockerComposeFramework(): boolean {
    return this.selectedFramework?.id === 'docker-compose';
  }

  isOciComposeMode(): boolean {
    return this.isOciImageFramework() && this.ociInstallMode() === 'compose';
  }

  // Template: (imageReferenceChange)="onImageReferenceChange($event)"
  onImageReferenceChange(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    this.imageReference.set(v);
    this.imageError.set(null);
    this.imageAnnotationsReceived.set(false);
    this.state.imageInputSubject.next(v);
  }

  // Template: (annotationsReceived)="onAnnotationsReceived($event)"
  onAnnotationsReceived(response: IPostFrameworkFromImageResponse): void {
    this.state.lastAnnotationsResponse.set(response);
    this.loadingImageAnnotations.set(false);
    this.imageAnnotationsReceived.set(true);
    setTimeout(() => this.state.fillFieldsFromAnnotations(response), 0);
  }

  // Delegate compose/env file selection to state service
  async onComposeFileSelected(file: File): Promise<void> {
    await this.state.onComposeFileSelected(file);
  }

  async onEnvFileSelected(file: File): Promise<void> {
    await this.state.onEnvFileSelected(file);
  }

  // --- Template helpers for env summary display (delegate to state) ---
  envFileConfigured(): boolean {
    return this.state.envFileConfigured();
  }

  envVarKeys(): string[] {
    return this.state.envVarKeys();
  }

  envVarKeysText(): string {
    return this.state.envVarKeysText();
  }
}
