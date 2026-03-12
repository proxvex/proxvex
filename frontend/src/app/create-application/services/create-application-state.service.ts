import { Injectable, signal, inject } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';

import { IAddonWithParameters, IFrameworkApplicationDataBody, IFrameworkPropertyInfo, IFrameworkName, IParameter, IParameterValue, IPostFrameworkFromImageResponse, IStack, IStacktypeEntry, ITagsConfig, IUploadFile, ParameterTarget } from '../../../shared/types';
import { ParameterFormManager } from '../../shared/utils/parameter-form.utils';
import { ComposeService, DockerComposeService, ParsedComposeData } from '../../shared/services/docker-compose.service';
import { ErrorHandlerService } from '../../shared/services/error-handler.service';
import { VeConfigurationService } from '../../ve-configuration.service';

/**
 * State service for Create Application wizard.
 * Holds all shared state (signals, forms) across step components.
 */
@Injectable({ providedIn: 'root' })
export class CreateApplicationStateService {
  private fb = inject(FormBuilder);
  private configService = inject(VeConfigurationService);
  private router = inject(Router);
  private composeService = inject(DockerComposeService);
  private errorHandler = inject(ErrorHandlerService);

  // ─────────────────────────────────────────────────────────────────────────────
  // Edit mode state
  // ─────────────────────────────────────────────────────────────────────────────
  editMode = signal(false);
  editApplicationId = signal<string | null>(null);
  loadingEditData = signal(false);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Framework selection
  // ─────────────────────────────────────────────────────────────────────────────
  frameworks = signal<IFrameworkName[]>([]);
  selectedFramework = signal<IFrameworkName | null>(null);
  loadingFrameworks = signal(true);

  // OCI Image input (only for oci-image framework)
  imageReference = signal('');
  loadingImageAnnotations = signal(false);
  imageError = signal<string | null>(null);
  imageAnnotationsReceived = signal(false);
  lastAnnotationsResponse = signal<IPostFrameworkFromImageResponse | null>(null);

  // OCI framework install mode
  ociInstallMode = signal<'image' | 'compose'>('compose');

  // Subjects for debounced input handling
  imageInputSubject = new Subject<string>();
  applicationIdSubject = new Subject<string>();

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Application properties
  // ─────────────────────────────────────────────────────────────────────────────
  appPropertiesForm: FormGroup = this.createAppPropertiesForm();
  applicationIdError = signal<string | null>(null);

  // Icon upload
  selectedIconFile = signal<File | null>(null);
  iconPreview = signal<string | null>(null);
  iconContent = signal<string | null>(null);

  // Tags
  tagsConfig = signal<ITagsConfig | null>(null);
  selectedTags = signal<string[]>([]);

  // Stacktypes
  stacktypes = signal<IStacktypeEntry[]>([]);
  selectedStacktype = signal<string | null>(null);

  // Supported Addons
  selectedSupportedAddons = signal<string[]>([]);
  availableAddonEntries = signal<{id: string; name: string}[]>([]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Docker Compose specific
  // ─────────────────────────────────────────────────────────────────────────────
  parsedComposeData = signal<ParsedComposeData | null>(null);
  selectedServiceName = signal<string>('');

  // Expose signals for child display
  composeServices = signal<ComposeService[]>([]);
  requiredEnvVars = signal<string[]>([]);
  missingEnvVars = signal<string[]>([]);
  composeProperties = signal<{
    services?: string;
    ports?: string;
    images?: string;
    networks?: string;
    volumes?: string;
  } | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3: Parameters
  // ─────────────────────────────────────────────────────────────────────────────
  parameters = signal<IParameter[]>([]);
  parameterForm: FormGroup = this.fb.group({});
  groupedParameters = signal<Record<string, IParameter[]>>({});
  showAdvanced = signal(false);
  loadingParameters = signal(false);

  /** Pending values for controls that don't exist yet (set before parameters are loaded) */
  private pendingControlValues: Record<string, string> = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3 (new): Install Parameters + Classifications + Addons
  // ─────────────────────────────────────────────────────────────────────────────
  installParameters = signal<IParameter[]>([]);
  installParametersGrouped = signal<Record<string, IParameter[]>>({});
  installFormManager: ParameterFormManager | null = null;
  loadingInstallParameters = signal(false);
  installParametersError = signal<string | null>(null);

  // Addon support
  availableAddons = signal<IAddonWithParameters[]>([]);
  selectedAddons = signal<string[]>([]);
  expandedAddons = signal<string[]>([]);

  // Stack support for install step
  availableStacks = signal<IStack[]>([]);
  selectedInstallStack: IStack | null = null;

  // Classification: maps paramId → 'value' | 'default' | 'install'
  parameterClassifications = signal<Map<string, ParameterTarget>>(new Map());
  frameworkProperties = signal<IFrameworkPropertyInfo[]>([]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 4: SSL Configuration
  // ─────────────────────────────────────────────────────────────────────────────
  sslMode = signal<'proxy' | 'native' | 'certs'>('proxy');
  sslNeedsServerCert = signal(true);
  sslNeedsCaCert = signal(false);
  sslAddonVolumes = signal('certs=/etc/ssl/addon,0700,0:0');

  /** Collect SSL properties that differ from addon defaults */
  collectSslProperties(): { id: string; value: string }[] {
    const props: { id: string; value: string }[] = [];
    if (this.sslMode() !== 'proxy') {
      props.push({ id: 'ssl.mode', value: this.sslMode() });
    }
    if (!this.sslNeedsServerCert()) {
      props.push({ id: 'ssl.needs_server_cert', value: 'false' });
    }
    if (this.sslNeedsCaCert()) {
      props.push({ id: 'ssl.needs_ca_cert', value: 'true' });
    }
    const volumes = this.sslAddonVolumes().trim();
    if (volumes && volumes !== 'certs=/etc/ssl/addon,0700,0:0') {
      props.push({ id: 'ssl.addon_volumes', value: volumes });
    }
    return props;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 5: Upload Files
  // ─────────────────────────────────────────────────────────────────────────────
  private _uploadFiles: IUploadFile[] = [];

  getUploadFiles(): IUploadFile[] {
    return this._uploadFiles;
  }

  setUploadFiles(files: IUploadFile[]): void {
    this._uploadFiles = files;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 6: Summary
  // ─────────────────────────────────────────────────────────────────────────────
  creating = signal(false);
  createError = signal<string | null>(null);
  createErrorStep = signal<number | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Framework helper methods
  // ─────────────────────────────────────────────────────────────────────────────
  isOciImageFramework(): boolean {
    return this.selectedFramework()?.id === 'oci-image';
  }

  isDockerComposeFramework(): boolean {
    return this.selectedFramework()?.id === 'docker-compose';
  }

  isOciComposeMode(): boolean {
    return this.isOciImageFramework() && this.ociInstallMode() === 'compose';
  }

  usesComposeControls(): boolean {
    return this.isDockerComposeFramework() || this.isOciComposeMode();
  }

  /** Tracks previous applicationId to detect auto-synced hostnames */
  private previousApplicationId = '';

  /**
   * Syncs hostname with applicationId for oci-image and docker-compose frameworks.
   * Updates hostname in both parameterForm and installForm when it hasn't been manually changed.
   */
  syncHostnameWithApplicationId(): void {
    if (!this.isOciImageFramework() && !this.isDockerComposeFramework()) {
      return;
    }

    const applicationId = this.appPropertiesForm.get('applicationId')?.value?.trim() ?? '';
    if (!applicationId) {
      return;
    }

    // Update hostname in parameterForm
    const hostnameCtrl = this.parameterForm.get('hostname');
    if (hostnameCtrl) {
      const current = hostnameCtrl.value?.trim() ?? '';
      if (!current || current === this.previousApplicationId) {
        hostnameCtrl.patchValue(applicationId, { emitEvent: false });
      }
    }

    // Update hostname in installForm (Step 3)
    const installHostnameCtrl = this.installForm.get('hostname');
    if (installHostnameCtrl) {
      const current = installHostnameCtrl.value?.trim() ?? '';
      if (!current || current === this.previousApplicationId) {
        installHostnameCtrl.patchValue(applicationId, { emitEvent: false });
      }
    }

    this.previousApplicationId = applicationId;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tag methods
  // ─────────────────────────────────────────────────────────────────────────────
  toggleTag(tagId: string): void {
    const current = this.selectedTags();
    if (current.includes(tagId)) {
      this.selectedTags.set(current.filter(t => t !== tagId));
    } else {
      this.selectedTags.set([...current, tagId]);
    }
  }

  isTagSelected(tagId: string): boolean {
    return this.selectedTags().includes(tagId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Form creation
  // ─────────────────────────────────────────────────────────────────────────────
  private createAppPropertiesForm(): FormGroup {
    return this.fb.group({
      name: ['', [Validators.required]],
      applicationId: ['', [Validators.required, Validators.pattern(/^[a-z0-9-]+$/)]],
      description: ['', [Validators.required]],
      url: [''],
      documentation: [''],
      source: [''],
      vendor: [''],
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reset state (for fresh wizard)
  // ─────────────────────────────────────────────────────────────────────────────
  reset(): void {
    // Edit mode
    this.editMode.set(false);
    this.editApplicationId.set(null);
    this.loadingEditData.set(false);

    // Step 1: Framework
    this.selectedFramework.set(null);
    this.loadingFrameworks.set(true);

    // OCI Image
    this.imageReference.set('');
    this.loadingImageAnnotations.set(false);
    this.imageError.set(null);
    this.imageAnnotationsReceived.set(false);
    this.lastAnnotationsResponse.set(null);
    this.ociInstallMode.set('compose');

    // Step 2: App properties
    this.appPropertiesForm = this.createAppPropertiesForm();
    this.applicationIdError.set(null);
    this.previousApplicationId = '';

    // Icon
    this.selectedIconFile.set(null);
    this.iconPreview.set(null);
    this.iconContent.set(null);

    // Tags
    this.selectedTags.set([]);

    // Stacktypes
    this.selectedStacktype.set(null);

    // Supported Addons
    this.selectedSupportedAddons.set([]);

    // Supported Addons
    this.selectedSupportedAddons.set([]);

    // Docker Compose
    this.parsedComposeData.set(null);
    this.selectedServiceName.set('');
    this.composeServices.set([]);
    this.requiredEnvVars.set([]);
    this.missingEnvVars.set([]);
    this.composeProperties.set(null);

    // Step 3: Parameters
    this.parameters.set([]);
    this.parameterForm = this.fb.group({});
    this.groupedParameters.set({});
    this.showAdvanced.set(false);
    this.loadingParameters.set(false);
    this.pendingControlValues = {};

    // Step 3 (new): Install Parameters + Classifications + Addons
    this.installParameters.set([]);
    this.installParametersGrouped.set({});
    this.installFormManager = null;
    this.loadingInstallParameters.set(false);
    this.installParametersError.set(null);
    this.availableAddons.set([]);
    this.selectedAddons.set([]);
    this.expandedAddons.set([]);
    this.availableStacks.set([]);
    this.selectedInstallStack = null;
    this.parameterClassifications.set(new Map());
    this.frameworkProperties.set([]);

    // Step 4: SSL Configuration
    this.sslMode.set('proxy');
    this.sslNeedsServerCert.set(true);
    this.sslNeedsCaCert.set(false);
    this.sslAddonVolumes.set('certs=/etc/ssl/addon,0700,0:0');

    // Step 5: Upload Files
    this._uploadFiles = [];

    // Step 6: Summary
    this.creating.set(false);
    this.createError.set(null);
    this.createErrorStep.set(null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Clear error
  // ─────────────────────────────────────────────────────────────────────────────
  clearError(): void {
    this.createError.set(null);
    this.createErrorStep.set(null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Compose/Image Logic - Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Resets form controls to their default values from parameter definitions.
   * @param preserveControls - Control names to skip (not reset)
   */
  private resetControlsToDefaults(preserveControls: string[]): void {
    for (const controlName of Object.keys(this.parameterForm.controls)) {
      if (!preserveControls.includes(controlName)) {
        const param = this.parameters().find(p => p.id === controlName);
        const defaultValue = this.resolveParameterDefault(param?.default ?? '');
        this.parameterForm.get(controlName)?.setValue(defaultValue);
      }
    }
  }

  /**
   * Resolves ${VAR:-default} patterns in parameter default values using .env file.
   * Enables parameter defaults to reference environment variables from the secure .env.
   *
   * Uses the raw .env file values directly, not the service-specific environment,
   * because parameter defaults may reference variables not defined in the compose service.
   */
  private resolveParameterDefault(defaultValue: string | number | boolean | undefined): string | number | boolean {
    if (typeof defaultValue !== 'string') {
      return defaultValue ?? '';
    }
    // Only resolve if the default contains ${...} patterns
    if (!defaultValue.includes('${')) {
      return defaultValue;
    }
    // Parse the raw .env file to get all defined variables
    const envFileValue = this.parameterForm.get('env_file')?.value ?? '';
    const envVarsMap = this.composeService.parseEnvFile(envFileValue);
    return this.composeService.resolveVariables(defaultValue, envVarsMap);
  }

  /**
   * Gets the currently selected service name, falling back to first service.
   */
  getSelectedServiceName(): string {
    const data = this.parsedComposeData();
    return this.selectedServiceName() || data?.services?.[0]?.name || '';
  }

  /**
   * Gets the effective environment variables for the selected service.
   * Combines .env file values with compose environment and defaults.
   */
  getEffectiveEnvsForSelectedService(): Map<string, string> {
    const data = this.parsedComposeData();
    if (!data) return new Map();

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return new Map();

    const service = data.services.find(s => s.name === serviceName);
    if (!service) return new Map();

    const envFileContent = this.parameterForm.get('env_file')?.value ?? '';
    return this.composeService.getEffectiveServiceEnvironment(
      service.config, data, serviceName, envFileContent
    );
  }

  /**
   * Updates all compose-derived fields for the selected service.
   * Call this after compose file or env file changes.
   */
  private updateFieldsFromComposeService(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data || data.services.length === 0) return;

    this.updateImageFromCompose();
    this.updateInitialCommandFromCompose();
    this.updateUserFromCompose();
    this.fillEnvsForSelectedService();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Clear Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Clears fields that will be populated from a new compose file.
   */
  private clearFieldsForNewComposeFile(): void {
    this.resetControlsToDefaults(['compose_file', 'env_file']);

    if (this.isOciComposeMode()) {
      this.imageReference.set('');
    }

    this.parsedComposeData.set(null);
    this.composeServices.set([]);
    this.composeProperties.set(null);
    this.selectedServiceName.set('');
  }

  /**
   * Clears fields that will be populated from a new env file.
   */
  private clearFieldsForNewEnvFile(): void {
    if (this.isOciComposeMode()) {
      this.resetControlsToDefaults(['compose_file', 'env_file']);
    }
  }

  /**
   * Clears fields that will be populated from image annotations.
   */
  clearFieldsForNewImage(): void {
    this.appPropertiesForm.patchValue({
      name: '',
      description: '',
      url: '',
      documentation: '',
      source: '',
      vendor: '',
      applicationId: ''
    });

    this.selectedIconFile.set(null);
    this.iconPreview.set(null);
    this.iconContent.set(null);
    this.selectedTags.set([]);

    // Preserve compose-derived controls (uid, gid, initial_command come from compose, not image annotations)
    this.resetControlsToDefaults(['compose_file', 'env_file', 'volumes', 'envs', 'uid', 'gid', 'initial_command']);

    this.imageAnnotationsReceived.set(false);
    this.lastAnnotationsResponse.set(null);
    this.imageError.set(null);
  }

  /**
   * Handles compose file selection, parses it and updates state.
   */
  async onComposeFileSelected(file: File): Promise<void> {
    // Clear fields that will be populated from the new compose file
    this.clearFieldsForNewComposeFile();
    const base64 = await this.readFileAsBase64(file);
    const valueWithMetadata = `file:${file.name}:content:${base64}`;
    this.parameterForm.get('compose_file')?.setValue(valueWithMetadata);

    const parsed = this.composeService.parseComposeFile(valueWithMetadata);
    if (!parsed) return;

    this.parsedComposeData.set(parsed);
    this.composeServices.set(parsed.services);
    this.composeProperties.set(parsed.properties);

    // Fill volumes ONLY if there are volumes AND field is empty.
    // Use parsed.properties.volumes which is in key=path format (e.g., "config=mosquitto/config")
    // instead of parsed.volumes which contains raw Docker format (e.g., "config:/mosquitto/config:ro")
    // that includes volume flags like :ro which the backend doesn't understand.
    if (parsed.properties.volumes) {
      const volumesText = parsed.properties.volumes;
      const volumesCtrl = this.parameterForm.get('volumes');
      if (volumesCtrl) {
        const currentValue = volumesCtrl.value;
        if (!currentValue || String(currentValue).trim() === '') {
          volumesCtrl.patchValue(volumesText, { emitEvent: false });
        }
      } else {
        // Control doesn't exist yet - store as pending
        this.pendingControlValues['volumes'] = volumesText;
      }
    }

    if (this.isOciComposeMode() && parsed.services.length > 0) {
      this.selectedServiceName.set(parsed.services[0].name);
      this.updateFieldsFromComposeService();
    }

    this.updateRequiredEnvVars();
    this.updateEnvFileRequirement();
    this.refreshEnvSummary();
  }

  /**
   * Handles env file selection, parses it and updates state.
   */
  async onEnvFileSelected(file: File): Promise<void> {
    this.clearFieldsForNewEnvFile();

    const base64 = await this.readFileAsBase64(file);
    const valueWithMetadata = `file:${file.name}:content:${base64}`;
    this.parameterForm.get('env_file')?.setValue(valueWithMetadata);

    const envVars = this.composeService.parseEnvFile(valueWithMetadata);
    this.updateMissingEnvVars(envVars);
    this.updateEnvFileRequirement();

    // Update fields in next tick to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => this.updateFieldsFromComposeService(), 0);
  }

  /**
   * Fetches image annotations from the registry.
   */
  fetchImageAnnotations(imageRef: string): void {
    const ref = (imageRef ?? '').trim();
    if (!ref) return;

    // Clear fields that will be populated from the new image
    this.clearFieldsForNewImage();

    this.loadingImageAnnotations.set(true);
    this.imageError.set(null);

    const [image, tag = 'latest'] = ref.split(':');

    this.configService.getFrameworkFromImage({ image, tag }).subscribe({
      next: (res: IPostFrameworkFromImageResponse) => {
        this.loadingImageAnnotations.set(false);
        this.imageAnnotationsReceived.set(true);
        this.lastAnnotationsResponse.set(res);
        this.fillFieldsFromAnnotations(res);
      },
      error: (err) => {
        this.loadingImageAnnotations.set(false);
        const msg = err?.error?.error || err?.message || 'Failed to fetch image annotations';
        this.imageError.set(msg);
      }
    });
  }

  /**
   * Fills form fields from image annotations response.
   */
  fillFieldsFromAnnotations(res: IPostFrameworkFromImageResponse): void {
    const defaults = res?.defaults;
    if (!defaults) return;

    const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

    const appProps = defaults.applicationProperties;
    if (appProps) {
      const form = this.appPropertiesForm;
      if (appProps.name && isEmpty(form.get('name')?.value)) form.patchValue({ name: appProps.name }, { emitEvent: false });
      if (appProps.description && isEmpty(form.get('description')?.value)) form.patchValue({ description: appProps.description }, { emitEvent: false });
      if (appProps.url && isEmpty(form.get('url')?.value)) form.patchValue({ url: appProps.url }, { emitEvent: false });
      if (appProps.documentation && isEmpty(form.get('documentation')?.value)) form.patchValue({ documentation: appProps.documentation }, { emitEvent: false });
      if (appProps.source && isEmpty(form.get('source')?.value)) form.patchValue({ source: appProps.source }, { emitEvent: false });
      if (appProps.vendor && isEmpty(form.get('vendor')?.value)) form.patchValue({ vendor: appProps.vendor }, { emitEvent: false });

      if (appProps.applicationId && isEmpty(form.get('applicationId')?.value)) {
        const ctrl = form.get('applicationId');
        ctrl?.patchValue(appProps.applicationId, { emitEvent: false });
        ctrl?.updateValueAndValidity();
      }
    }

    const params = defaults.parameters;
    if (params) {
      for (const [paramId, paramValue] of Object.entries(params)) {
        const ctrl = this.parameterForm.get(paramId);
        if (ctrl && isEmpty(ctrl.value)) ctrl.patchValue(paramValue, { emitEvent: false });
      }
    }

    const img = this.imageReference().trim();
    if (img && this.parameterForm.get('oci_image') && isEmpty(this.parameterForm.get('oci_image')?.value)) {
      this.parameterForm.patchValue({ oci_image: img }, { emitEvent: false });
    }
  }

  /**
   * Updates image reference from compose file for selected service.
   */
  updateImageFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const image = service?.config?.['image'];
    if (typeof image !== 'string' || !image.trim()) return;

    // Use effective envs for variable resolution (includes .env + compose defaults)
    const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
    const imageRef = this.composeService.resolveVariables(image.trim(), effectiveEnvs);
    if (imageRef === this.imageReference()) return;

    this.imageReference.set(imageRef);
    this.imageInputSubject.next(imageRef);
    this.updateOciImageParameter(imageRef);
  }

  /**
   * Updates initial command from compose file for selected service.
   * Resolves environment variables like ${VAR:-default} using values from .env file.
   */
  updateInitialCommandFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const command = service?.config?.['command'];

    let cmdStr = '';
    if (Array.isArray(command)) {
      cmdStr = command.join(' ');
    } else if (typeof command === 'string') {
      cmdStr = command;
    }

    if (cmdStr) {
       const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
       const resolvedCmd = this.composeService.resolveVariables(cmdStr, effectiveEnvs);
       if (this.parameterForm.get('initial_command')) {
         this.parameterForm.patchValue({ initial_command: resolvedCmd });
       } else {
         this.pendingControlValues['initial_command'] = resolvedCmd;
       }
    }
  }

  /**
   * Updates uid/gid from compose file for selected service.
   */
  updateUserFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const user = service?.config?.['user'];

    if (typeof user === 'string' || typeof user === 'number') {
        const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
        const resolvedUser = this.composeService.resolveVariables(String(user), effectiveEnvs);
        const parts = resolvedUser.split(':');

        if (parts.length > 0 && parts[0].trim()) {
          const uidValue = parts[0].trim();
          if (this.parameterForm.get('uid')) {
            this.parameterForm.patchValue({ uid: uidValue });
          } else {
            this.pendingControlValues['uid'] = uidValue;
          }
        }

        if (parts.length > 1 && parts[1].trim()) {
          const gidValue = parts[1].trim();
          if (this.parameterForm.get('gid')) {
            this.parameterForm.patchValue({ gid: gidValue });
          } else {
            this.pendingControlValues['gid'] = gidValue;
          }
        }
    }
  }

  /**
   * Fills environment variables for selected service.
   */
  fillEnvsForSelectedService(): void {
    if (!this.isOciComposeMode()) return;

    const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
    if (effectiveEnvs.size === 0) return;

    const lines: string[] = [];
    for (const [key, value] of effectiveEnvs.entries()) {
      lines.push(`${key}=${value}`);
    }

    const envsValue = lines.join('\n');
    const envsControl = this.parameterForm.get('envs');

    if (envsControl) {
      // Control exists - set value directly
      envsControl.patchValue(envsValue);
    } else {
      // Control doesn't exist yet - store as pending (will be applied when parameters are loaded)
      this.pendingControlValues['envs'] = envsValue;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Compose control helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ensures compose_file, env_file, and volumes controls exist.
   */
  ensureComposeControls(opts?: { requireComposeFile?: boolean }): void {
    const requireComposeFile = opts?.requireComposeFile ?? false;

    if (!this.parameterForm.get('compose_file')) {
      this.parameterForm.addControl('compose_file', new FormControl(''));
    }
    this.setComposeFileRequired(requireComposeFile);

    if (!this.parameterForm.get('env_file')) {
      this.parameterForm.addControl('env_file', new FormControl(''));
    }
    if (!this.parameterForm.get('volumes')) {
      this.parameterForm.addControl('volumes', new FormControl(''));
    }
  }

  /**
   * Sets compose_file control as required or not.
   */
  setComposeFileRequired(required: boolean): void {
    const ctrl = this.parameterForm.get('compose_file');
    if (!ctrl) return;

    if (required) ctrl.setValidators([Validators.required]);
    else ctrl.clearValidators();

    ctrl.updateValueAndValidity({ emitEvent: false });
  }

  /**
   * Updates the oci_image parameter form control.
   */
  updateOciImageParameter(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    if (!v) return;
    if (this.parameterForm.get('oci_image')) {
      this.parameterForm.patchValue({ oci_image: v }, { emitEvent: false });
    } else {
      // Control doesn't exist yet - store as pending (will be applied when parameters are loaded)
      this.pendingControlValues['oci_image'] = v;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Environment variable helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Updates required environment variables based on parsed compose data.
   */
  updateRequiredEnvVars(): void {
    const data = this.parsedComposeData();
    if (!data) {
      this.requiredEnvVars.set([]);
      this.missingEnvVars.set([]);
      return;
    }

    let vars: string[] = [];
    if (this.isDockerComposeFramework()) {
      vars = data.environmentVariablesRequired ?? data.environmentVariables ?? [];
    } else if (this.isOciComposeMode()) {
      const serviceName = this.getSelectedServiceName();
      if (!serviceName) return;
      vars = data.serviceEnvironmentVariablesRequired?.[serviceName] ?? data.serviceEnvironmentVariables?.[serviceName] ?? [];
    }

    this.requiredEnvVars.set(vars);

    const envFile = this.parameterForm.get('env_file')?.value;
    if (envFile) {
      const envVars = this.composeService.parseEnvFile(envFile);
      this.updateMissingEnvVars(envVars);
    } else {
      this.missingEnvVars.set(vars);
    }
  }

  /**
   * Updates missing environment variables based on provided env vars.
   */
  updateMissingEnvVars(envVars: Map<string, string>): void {
    const missing = this.requiredEnvVars().filter((v: string) => !envVars.has(v) || !envVars.get(v));
    this.missingEnvVars.set(missing);
  }

  /**
   * Updates env_file requirement based on mode and missing vars.
   */
  updateEnvFileRequirement(): void {
    const envCtrl = this.parameterForm.get('env_file');
    if (!envCtrl) return;

    // OCI Image + Compose: .env ist erlaubt NICHT vorhanden zu sein → niemals required
    if (this.isOciComposeMode()) {
      envCtrl.clearValidators();
      envCtrl.updateValueAndValidity({ emitEvent: false });
      return;
    }

    // docker-compose Framework: bestehende "required wenn missing vars" Logik beibehalten
    const shouldRequireEnvFile =
      this.isDockerComposeFramework() &&
      (this.requiredEnvVars()?.length ?? 0) > 0 &&
      (this.missingEnvVars()?.length ?? 0) > 0;

    if (shouldRequireEnvFile) envCtrl.setValidators([Validators.required]);
    else envCtrl.clearValidators();

    envCtrl.updateValueAndValidity({ emitEvent: false });
  }

  /**
   * Refreshes environment variable summary.
   */
  refreshEnvSummary(): void {
    this.updateRequiredEnvVars();
    this.updateEnvFileRequirement();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Reads a file as base64.
   */
  readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Checks if env file is configured.
   */
  envFileConfigured(): boolean {
    const envFileValue = this.parameterForm.get('env_file')?.value;
    return !!envFileValue && String(envFileValue).trim().length > 0;
  }

  /**
   * Returns sorted list of env var keys from env file.
   */
  envVarKeys(): string[] {
    const envFileValue = this.parameterForm.get('env_file')?.value;
    if (!envFileValue) return [];

    const envVarsMap = this.composeService.parseEnvFile(envFileValue);
    return Array.from(envVarsMap.keys()).sort();
  }

  /**
   * Returns env var keys as newline-separated text.
   */
  envVarKeysText(): string {
    return this.envVarKeys().join('\n');
  }

  /**
   * Loads tags configuration from backend.
   */
  loadTagsConfig(): void {
    this.configService.getTagsConfig().subscribe({
      next: (config) => {
        this.tagsConfig.set(config);
      },
      error: (err) => {
        console.error('Failed to load tags config', err);
      }
    });
  }

  /**
   * Loads stacktypes from backend.
   */
  loadStacktypes(): void {
    // Guard for test environments where configService might be mocked without this method
    if (typeof this.configService.getStacktypes !== 'function') {
      return;
    }
    this.configService.getStacktypes().subscribe({
      next: (res) => {
        this.stacktypes.set(res.stacktypes);
      },
      error: (err) => {
        console.error('Failed to load stacktypes', err);
      }
    });
  }

  /**
   * Sets up the parameter form from current parameters.
   * Groups parameters by template and adds form controls.
   */
  setupParameterForm(): void {
    const grouped: Record<string, IParameter[]> = {};

    for (const param of this.parameters()) {
      const group = param.templatename || 'General';
      if (!grouped[group]) {
        grouped[group] = [];
      }
      grouped[group].push(param);

      // Skip if control already exists (e.g., compose_file, env_file)
      if (this.parameterForm.get(param.id)) {
        continue;
      }

      // Don't set required validator if param has an 'if' condition and the control doesn't exist
      // (e.g., env_file with if: env_file_has_markers - that flag is a backend property, not a form control)
      const shouldBeRequired = param.required && !param.if;
      const validators = shouldBeRequired ? [Validators.required] : [];
      const defaultValue = this.resolveParameterDefault(param.default);
      this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
    }

    // Sort parameters in each group: required first, then optional
    for (const group in grouped) {
      grouped[group] = grouped[group].slice().sort(
        (a, b) => Number(!!b.required) - Number(!!a.required)
      );
    }

    this.groupedParameters.set(grouped);
  }

  /**
   * Loads parameters for a given framework.
   */
  /** Controls to preserve for docker-compose framework */
  private readonly DOCKER_COMPOSE_PRESERVED_CONTROLS = ['compose_file', 'env_file', 'volumes', 'envs'] as const;
  /** Controls to preserve for oci-image framework */
  private readonly OCI_IMAGE_PRESERVED_CONTROLS = ['oci_image', 'volumes', 'envs'] as const;

  loadParameters(frameworkId: string): void {
    this.loadingParameters.set(true);
    this.parameters.set([]);

    // Preserve ALL current form values (not just compose controls)
    // This handles going back from Step 3 to Step 2 and then forward again
    const preservedValues: Record<string, unknown> = {};
    for (const controlId of Object.keys(this.parameterForm.controls)) {
      const value = this.parameterForm.get(controlId)?.value;
      if (value !== null && value !== undefined && value !== '') {
        preservedValues[controlId] = value;
      }
    }

    this.parameterForm = this.fb.group({});
    this.groupedParameters.set({});

    if (this.isDockerComposeFramework()) {
      // re-create controls with preserved values for docker-compose
      for (const controlId of this.DOCKER_COMPOSE_PRESERVED_CONTROLS) {
        if (!this.parameterForm.get(controlId)) {
          const preservedValue = preservedValues[controlId] ?? '';
          this.parameterForm.addControl(controlId, new FormControl(preservedValue));
        }
      }
      this.setComposeFileRequired(true);
      this.updateEnvFileRequirement();
    } else if (this.isOciImageFramework()) {
      // re-create controls with preserved values for oci-image
      for (const controlId of this.OCI_IMAGE_PRESERVED_CONTROLS) {
        if (!this.parameterForm.get(controlId)) {
          const preservedValue = preservedValues[controlId] ?? '';
          this.parameterForm.addControl(controlId, new FormControl(preservedValue));
        }
      }
      // Also preserve compose controls when in OCI compose mode
      if (this.isOciComposeMode()) {
        for (const controlId of this.DOCKER_COMPOSE_PRESERVED_CONTROLS) {
          if (!this.parameterForm.get(controlId)) {
            const preservedValue = preservedValues[controlId] ?? '';
            this.parameterForm.addControl(controlId, new FormControl(preservedValue));
          }
        }
      }
    }

    this.configService.getFrameworkParameters(frameworkId).subscribe({
      next: (res) => {
        this.parameters.set(res.parameters);
        // Group parameters by template (or use 'General' as default)
        const grouped: Record<string, IParameter[]> = {};
        for (const param of res.parameters) {
          const group = param.templatename || 'General';
          if (!grouped[group]) {
            grouped[group] = [];
          }
          grouped[group].push(param);

          // Don't overwrite preserved controls if they already exist with a value
          const isDockerComposePreserved = this.isDockerComposeFramework() &&
            this.DOCKER_COMPOSE_PRESERVED_CONTROLS.includes(param.id as typeof this.DOCKER_COMPOSE_PRESERVED_CONTROLS[number]);
          const isOciImagePreserved = this.isOciImageFramework() &&
            this.OCI_IMAGE_PRESERVED_CONTROLS.includes(param.id as typeof this.OCI_IMAGE_PRESERVED_CONTROLS[number]);
          if (isDockerComposePreserved || isOciImagePreserved) {
            const existingControl = this.parameterForm.get(param.id);
            if (existingControl && existingControl.value) {
              continue;
            }
          }

          // NOTE: "Neue Property für Textfeld-Validierung" NICHT im Framework-Flow aktivieren.
          // Hier bewusst nur `required` berücksichtigen (Validation soll nur im ve-configuration-dialog laufen).
          // Don't set required validator if param has an 'if' condition (conditional visibility/requirement)
          const shouldBeRequired = param.required && !param.if;
          const validators = shouldBeRequired ? [Validators.required] : [];

          const defaultValue = this.resolveParameterDefault(param.default);
          this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
        }

        // Apply preserved values from previous form state (e.g., when going back from Step 3 to Step 2)
        for (const [controlId, value] of Object.entries(preservedValues)) {
          const ctrl = this.parameterForm.get(controlId);
          if (ctrl && value !== null && value !== undefined && value !== '') {
            ctrl.patchValue(value, { emitEvent: false });
          }
        }

        // Apply pending values (set before parameters were loaded)
        for (const [controlId, value] of Object.entries(this.pendingControlValues)) {
          const ctrl = this.parameterForm.get(controlId);
          if (ctrl && value) {
            ctrl.patchValue(value, { emitEvent: false });
          }
        }
        this.pendingControlValues = {};

        // Sort parameters in each group: required first, then optional
        for (const group in grouped) {
          grouped[group] = grouped[group].slice().sort(
            (a, b) => Number(!!b.required) - Number(!!a.required)
          );
        }
        this.groupedParameters.set(grouped);
        this.loadingParameters.set(false);

        this.updateEnvFileRequirement();

        // Sync hostname with applicationId for oci-image and docker-compose frameworks
        this.syncHostnameWithApplicationId();

        if (this.isDockerComposeFramework()) {
          setTimeout(() => this.hydrateComposeDataFromForm(), 0);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load framework parameters', err);
        this.loadingParameters.set(false);
      }
    });
  }

  /**
   * Hydrates compose data from form values (after framework switch).
   */
  hydrateComposeDataFromForm(): void {
    const composeFileValue = this.parameterForm.get('compose_file')?.value;
    if (composeFileValue && typeof composeFileValue === 'string' && composeFileValue.trim()) {
      const parsed = this.composeService.parseComposeFile(composeFileValue);
      if (parsed) {
        this.parsedComposeData.set(parsed);

        if (this.isOciComposeMode() && parsed.services.length > 0) {
          this.selectedServiceName.set(parsed.services[0].name);
          this.updateFieldsFromComposeService();
        }

        this.updateEnvFileRequirement();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Install Parameters Loading (moved from summary-step)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Loads install parameters preview (unresolved parameters + addons).
   * Called when entering Step 3.
   */
  loadInstallParameters(): void {
    this.loadingInstallParameters.set(true);
    this.installParametersError.set(null);

    const body = this.buildPreviewRequestBody();
    if (!body) {
      this.loadingInstallParameters.set(false);
      this.installParametersError.set('Missing framework selection');
      return;
    }

    this.configService.getPreviewUnresolvedParameters(body).subscribe({
      next: (res) => {
        this.installParameters.set(res.unresolvedParameters);
        this.frameworkProperties.set(res.frameworkProperties ?? []);

        // Set up form BEFORE setting grouped parameters to avoid
        // formControlName errors (controls must exist before template renders)
        this.setupInstallForm(res.unresolvedParameters);
        this.initDefaultClassifications(res.unresolvedParameters, res.frameworkProperties ?? []);

        // Sort and group: framework properties first, then required, then rest
        const sorted = this.sortInstallParameters(res.unresolvedParameters, res.frameworkProperties ?? []);
        this.installParametersGrouped.set(this.groupByTemplate(sorted));

        this.availableAddons.set((res.addons ?? []).filter(addon => {
          if (!addon.required_parameters?.length) return true;
          return addon.required_parameters.every(paramId =>
            res.unresolvedParameters.some(p => p.id === paramId),
          );
        }));

        // Populate addon entries for the supported_addons selector in Step 2
        this.availableAddonEntries.set(
          (res.addons ?? []).map(addon => ({ id: addon.id, name: addon.name })),
        );

        this.loadInstallStacks();
        this.loadingInstallParameters.set(false);
      },
      error: (err) => {
        this.installParametersError.set(
          err?.error?.error || err?.message || 'Failed to load install parameters'
        );
        this.loadingInstallParameters.set(false);
      }
    });
  }

  private buildPreviewRequestBody(): IFrameworkApplicationDataBody | null {
    const selectedFramework = this.selectedFramework();
    if (!selectedFramework) return null;

    return {
      frameworkId: selectedFramework.id,
      name: this.appPropertiesForm.get('name')?.value || '',
      description: this.appPropertiesForm.get('description')?.value || '',
      url: this.appPropertiesForm.get('url')?.value || undefined,
      documentation: this.appPropertiesForm.get('documentation')?.value || undefined,
      source: this.appPropertiesForm.get('source')?.value || undefined,
      vendor: this.appPropertiesForm.get('vendor')?.value || undefined,
      tags: this.selectedTags().length > 0 ? this.selectedTags() : undefined,
      stacktype: this.selectedStacktype() ?? undefined,
      supported_addons: this.selectedSupportedAddons().length > 0 ? this.selectedSupportedAddons() : undefined,
      parameterValues: this.collectParameterValues(),
      uploadfiles: this.getUploadFiles().length > 0 ? this.getUploadFiles() : undefined,
    };
  }

  collectParameterValues(): { id: string; value: IParameterValue }[] {
    const parameterValues: { id: string; value: IParameterValue }[] = [];
    const collected = new Set<string>();

    // Collect from parameterForm (framework parameters from Step 1/2)
    for (const param of this.parameters()) {
      let value = this.parameterForm.get(param.id)?.value;
      value = ParameterFormManager.extractBase64FromFileMetadata(value);
      if (value !== null && value !== undefined && value !== '') {
        parameterValues.push({ id: param.id, value });
        collected.add(param.id);
      }
    }

    // Override/add from installForm (user edits in Step 3)
    // installForm values take priority since they reflect the user's latest edits
    for (const param of this.installParameters()) {
      const ctrl = this.installForm.get(param.id);
      if (!ctrl) continue;
      let value = ctrl.value;
      value = ParameterFormManager.extractBase64FromFileMetadata(value);
      if (value !== null && value !== undefined && value !== '') {
        const idx = parameterValues.findIndex(p => p.id === param.id);
        if (idx >= 0) {
          parameterValues[idx] = { id: param.id, value };
        } else {
          parameterValues.push({ id: param.id, value });
        }
        collected.add(param.id);
      }
    }

    // Ensure docker-compose essentials are not dropped
    if (this.isDockerComposeFramework()) {
      const ensuredIds = ['compose_file', 'env_file', 'volumes'] as const;
      for (const id of ensuredIds) {
        if (collected.has(id)) continue;
        const v = this.parameterForm.get(id)?.value;
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          parameterValues.push({ id, value: v });
        }
      }
    }

    // Add SSL properties (Step 4)
    for (const sslProp of this.collectSslProperties()) {
      parameterValues.push(sslProp);
    }

    return parameterValues;
  }

  private setupInstallForm(params: IParameter[]): void {
    this.installFormManager = new ParameterFormManager(
      params,
      this.configService,
      this.router
    );
    this.installFormManager.enableHostnameTracking();
  }

  /** Stable empty form used when installFormManager is not yet initialized */
  private _emptyInstallForm = this.fb.group({});

  /** Getter for template - returns form from manager or stable empty FormGroup */
  get installForm(): FormGroup {
    return this.installFormManager?.form ?? this._emptyInstallForm;
  }

  get isInstallFormValid(): boolean {
    return this.installFormManager?.valid ?? false;
  }

  private sortInstallParameters(params: IParameter[], fwProps: IFrameworkPropertyInfo[]): IParameter[] {
    const fwPropIds = new Set(fwProps.map(p => p.id));

    const frameworkParams = params.filter(p => fwPropIds.has(p.id));
    const requiredParams = params.filter(p => !fwPropIds.has(p.id) && p.required);
    const otherParams = params.filter(p => !fwPropIds.has(p.id) && !p.required);

    return [...frameworkParams, ...requiredParams, ...otherParams];
  }

  private groupByTemplate(params: IParameter[]): Record<string, IParameter[]> {
    const grouped: Record<string, IParameter[]> = {};
    for (const param of params) {
      const group = param.templatename || 'General';
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(param);
    }
    return grouped;
  }

  /**
   * Initializes default classifications based on framework properties.
   */
  private initDefaultClassifications(params: IParameter[], fwProps: IFrameworkPropertyInfo[]): void {
    const classifications = new Map<string, ParameterTarget>();
    const fwPropMap = new Map(fwProps.map(p => [p.id, p]));

    for (const param of params) {
      const fwProp = fwPropMap.get(param.id);
      if (fwProp) {
        // Framework property: isDefault=true → 'default', isDefault=false → 'value'
        classifications.set(param.id, fwProp.isDefault ? 'default' : 'value');
      } else {
        // Not a framework property → install parameter
        classifications.set(param.id, 'install');
      }
    }

    this.parameterClassifications.set(classifications);
  }

  /**
   * Updates a single parameter's classification.
   */
  updateClassification(paramId: string, target: ParameterTarget): void {
    const classifications = new Map(this.parameterClassifications());
    classifications.set(paramId, target);
    this.parameterClassifications.set(classifications);
  }

  private loadInstallStacks(): void {
    const stacktype = this.selectedStacktype();
    if (!stacktype) {
      this.availableStacks.set([]);
      return;
    }
    this.configService.getStacks(stacktype).subscribe({
      next: (res) => this.availableStacks.set(res.stacks),
      error: () => this.availableStacks.set([])
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Addon management (moved from summary-step)
  // ─────────────────────────────────────────────────────────────────────────────

  onAddonToggle(event: { addonId: string; checked: boolean }): void {
    const addon = this.availableAddons().find(a => a.id === event.addonId);

    if (event.checked) {
      this.selectedAddons.update(addons => [...addons, event.addonId]);
      if (addon?.parameters && this.installFormManager) {
        this.installFormManager.addAddonControls(addon.parameters);
        if (addon.parameters.some(p => p.required)) {
          this.expandedAddons.update(addons => [...addons, event.addonId]);
        }
      }
    } else {
      this.selectedAddons.update(addons => addons.filter(id => id !== event.addonId));
      this.expandedAddons.update(addons => addons.filter(id => id !== event.addonId));
      if (addon?.parameters && this.installFormManager) {
        this.installFormManager.removeAddonControls(addon.parameters);
      }
    }
    this.installFormManager?.setSelectedAddons(this.selectedAddons());
  }

  onAddonExpandedToggle(addonId: string): void {
    this.expandedAddons.update(addons =>
      addons.includes(addonId)
        ? addons.filter(id => id !== addonId)
        : [...addons, addonId]
    );
  }

  onInstallStackSelected(stack: IStack): void {
    this.selectedInstallStack = stack;
    this.installFormManager?.setSelectedStack(stack);
  }
}
