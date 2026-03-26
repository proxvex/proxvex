import { Component, OnInit, OnDestroy, inject, signal, Input } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';

import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IApplicationWeb, IParameter, IParameterValue, IEnumValuesResponse, IAddonWithParameters, IStack, IStacktypeEntry, IDependencyStatus } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
import { ParameterGroupComponent } from './parameter-group.component';
import { TemplateTraceDialog } from './template-trace-dialog';
import { CreateStackDialog, CreateStackDialogData, CreateStackDialogResult } from '../stacks-page/create-stack-dialog';
import { ParameterFormManager } from '../shared/utils/parameter-form.utils';
import { StackSelectorComponent } from '../shared/components/stack-selector/stack-selector.component';
import { AddonSectionComponent } from '../shared/components/addon-section/addon-section.component';
import { CertificateManagementDialog } from '../certificate-management/certificate-management-dialog';
import { Router } from '@angular/router';
import JSZip from 'jszip';

/**
 * Data passed to the VeConfigurationDialog.
 * - app: The application to configure
 * - task: The task type (installation, addon, etc.)
 * - presetValues: Optional preset values for parameters (e.g., from existing container)
 */
export interface VeConfigurationDialogData {
  app: IApplicationWeb;
  task?: string;
  presetValues?: Record<string, string | number>;
  existingMountPoints?: { source: string; target: string }[];
  installedAddons?: string[];
}
@Component({
  selector: 'app-ve-configuration-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatTooltipModule,
    ParameterGroupComponent,
    StackSelectorComponent,
    AddonSectionComponent
],
  templateUrl: './ve-configuration-dialog.html',
  styleUrl: './ve-configuration-dialog.scss',
})
export class VeConfigurationDialog implements OnInit, OnDestroy {
  form: FormGroup;
  unresolvedParameters: IParameter[] = [];
  groupedParameters: Record<string, IParameter[]> = {};
  loading = signal(true);
  hasError = signal(false);
  showAdvanced = signal(false);
  availableAddons: IAddonWithParameters[] = [];
  selectedAddons = signal<string[]>([]);
  expandedAddons = signal<string[]>([]);
  /** Pre-created FormGroups per addon (initialized when addons load) */
  addonFormGroups = new Map<string, FormGroup>();
  addonsLoading = signal(false);

  // Dependency check state
  dependencyErrors = signal<IDependencyStatus[]>([]);

  // Stack selection state
  availableStacks = signal<IStack[]>([]);
  availableStacktypes = signal<IStacktypeEntry[]>([]);
  stacksLoading = signal(false);
  private formManager!: ParameterFormManager;
  private enumRefreshAttempted = false;
  private visibilityHandler = () => this.onVisibilityChange();
  private configService: VeConfigurationService = inject(VeConfigurationService);
  private router: Router = inject(Router);
  public dialogRef: MatDialogRef<VeConfigurationDialog> = inject(MatDialogRef<VeConfigurationDialog>);
  private errorHandler: ErrorHandlerService = inject(ErrorHandlerService);
  private fb: FormBuilder = inject(FormBuilder);
  private dialog = inject(MatDialog);
  private composeService = inject(DockerComposeService);
  public data = inject(MAT_DIALOG_DATA) as VeConfigurationDialogData;
  private task = this.data.task ?? 'installation';
  private presetValues = this.data.presetValues ?? {};
  existingMountPoints: { source: string; target: string }[] = this.data.existingMountPoints ?? [];
  private installedAddons: string[] = this.data.installedAddons ?? [];

  /** Stacktypes required by this application (from application.json) */
  appStacktypes: string[] = [];
  /** Selected stack per stacktype */
  selectedStacks = new Map<string, IStack>();
  /** Stacktypes that the app requires but have no stacks available */
  missingStacktypes: string[] = [];
  /** Backwards-compatible single selected stack (first one) */
  get selectedStack(): IStack | null {
    return this.selectedStacks.size > 0 ? this.selectedStacks.values().next().value ?? null : null;
  }
  caConfigured = signal(false);

  /** For each stacktype, the stacks that match it */
  getStacksForType(type: string): IStack[] {
    const toArray = (st: string | string[]) => Array.isArray(st) ? st : [st];
    return this.availableStacks().filter(s => toArray(s.stacktype).includes(type));
  }

  /** All stacks matching any of the app's stacktypes (deduplicated) */
  get filteredStacks(): IStack[] {
    const all: IStack[] = [];
    for (const type of this.appStacktypes) {
      for (const s of this.getStacksForType(type)) {
        if (!all.some(existing => existing.id === s.id)) all.push(s);
      }
    }
    return all;
  }
  constructor(  ) {
    this.form = this.fb.group({});
  }
  ngOnInit(): void {
    // Listen for tab focus to reload stacks after editing in new tab
    document.addEventListener('visibilitychange', this.visibilityHandler);

    // Check dependencies (initial load)
    this.checkDependencies();

    // Load compatible addons and stacks in parallel with parameters
    this.loadCompatibleAddons();
    this.loadStacks();

    // For demo purposes: use 'installation' as the default task, can be extended
    this.configService.getUnresolvedParameters(this.data.app.id, this.task).subscribe({
      next: (res) => {
        this.unresolvedParameters = res.unresolvedParameters;
        // Group parameters by template (filter out addon_ parameters - they are set by addons only)
        this.groupedParameters = {};
        for (const param of this.unresolvedParameters) {
          // Skip addon_ parameters - they are internal and set by addon templates
          if (param.id.startsWith('addon_')) {
            continue;
          }
          const group = param.templatename || 'General';
          if (!this.groupedParameters[group]) this.groupedParameters[group] = [];
          this.groupedParameters[group].push(param);
          const validators = param.required ? [Validators.required] : [];
          // Use preset value if available, otherwise use parameter default
          const presetValue = this.presetValues[param.id];
          if (presetValue !== undefined) {
            param.default = presetValue;
          }
          const defaultValue = param.default !== undefined ? param.default : '';
          this.form.addControl(param.id, new FormControl(defaultValue, validators));
          // Initial values will be captured by ParameterFormManager.fromExistingForm()
        }

        // Add hidden controls for presetValues not in unresolved parameters
        // (e.g., vm_id is resolved by output but needed at runtime for reconfigure)
        for (const [key, value] of Object.entries(this.presetValues)) {
          if (!this.form.contains(key)) {
            this.form.addControl(key, new FormControl(value));
          }
        }

        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort((a, b) => Number(!!b.required) - Number(!!a.required));
        }

        // Reorder groups: groups with unfilled required (non-advanced) params first
        const sorted: Record<string, IParameter[]> = {};
        const groupKeys = Object.keys(this.groupedParameters);
        groupKeys.sort((a, b) => {
          const aScore = this.groupedParameters[a].some(p =>
            p.required && !p.advanced && (p.default === undefined || p.default === null || p.default === '')
          ) ? 1 : 0;
          const bScore = this.groupedParameters[b].some(p =>
            p.required && !p.advanced && (p.default === undefined || p.default === null || p.default === '')
          ) ? 1 : 0;
          return bScore - aScore;
        });
        for (const key of groupKeys) {
          sorted[key] = this.groupedParameters[key];
        }
        this.groupedParameters = sorted;

        this.form.markAllAsTouched();
        this.loading.set(false);
        this.loadEnumValues();

        // Re-apply addon filtering now that parameters are loaded
        this.applyRequiredParametersFilter();

        // Check CA status (needed to gate SSL addon selection)
        this.configService.getCaInfo().subscribe({
          next: (info) => {
            this.caConfigured.set(info.exists);
          }
        });

        // Create ParameterFormManager from existing form
        this.formManager = ParameterFormManager.fromExistingForm(
          this.form,
          this.configService,
          this.router
        );
        this.formManager.enableHostnameTracking();

        // Sync pre-selected addons that were loaded before formManager existed
        // (loadCompatibleAddons may complete before getUnresolvedParameters)
        if (this.selectedAddons().length > 0) {
          for (const addonId of this.selectedAddons()) {
            const addon = this.availableAddons.find(a => a.id === addonId);
            if (addon?.parameters) {
              this.formManager.addAddonControls(addon.parameters);
            }
          }
          this.formManager.setSelectedAddons(this.selectedAddons());
        }
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load parameters', err);
        this.loading.set(false);
        this.hasError.set(true);
        // Note: Dialog remains open so user can see the error and close manually
      }
    });
  }

  private loadEnumValues(): void {
    const enumParams = this.unresolvedParameters.filter((p) => p.type === 'enum');
    if (enumParams.length === 0) return;
    const allEnumsPresent = enumParams.every(
      (p) => Array.isArray(p.enumValues) && p.enumValues.length > 0,
    );
    if (allEnumsPresent) return;

    const params = enumParams
      .map((p) => ({
        id: p.id,
        value: this.form.get(p.id)?.value as IParameterValue,
      }))
      .filter((p) => p.value !== null && p.value !== undefined && p.value !== '');

    this.configService.postEnumValues(this.data.app.id, this.task, params).subscribe({
      next: (res: IEnumValuesResponse) => {
        for (const entry of res.enumValues) {
          const param = this.unresolvedParameters.find((p) => p.id === entry.id);
          if (!param) continue;
          param.enumValues = entry.enumValues;
          if (entry.default !== undefined) {
            param.default = entry.default;
            const control = this.form.get(entry.id);
            if (control && (control.value === '' || control.value === null || control.value === undefined)) {
              control.setValue(entry.default);
              this.formManager.updateInitialValue(entry.id, entry.default as IParameterValue);
            }
          }
        }
        const missingEnums = this.unresolvedParameters.filter(
          (p) => p.type === 'enum' && (!p.enumValues || p.enumValues.length === 0),
        );
        if (missingEnums.length > 0 && !this.enumRefreshAttempted) {
          this.enumRefreshAttempted = true;
          this.configService.postEnumValues(this.data.app.id, this.task, params, true).subscribe({
            next: (retryRes: IEnumValuesResponse) => {
              for (const entry of retryRes.enumValues) {
                const param = this.unresolvedParameters.find((p) => p.id === entry.id);
                if (!param) continue;
                param.enumValues = entry.enumValues;
                if (entry.default !== undefined) {
                  param.default = entry.default;
                  const control = this.form.get(entry.id);
                  if (control && (control.value === '' || control.value === null || control.value === undefined)) {
                    control.setValue(entry.default);
                    this.formManager.updateInitialValue(entry.id, entry.default as IParameterValue);
                  }
                }
              }
            },
            error: (err: unknown) => {
              this.errorHandler.handleError('Failed to refresh enum values', err);
            }
          });
        }
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load enum values', err);
      }
    });
  }

  private loadCompatibleAddons(): void {
    this.addonsLoading.set(true);
    this.configService.getCompatibleAddons(this.data.app.id, this.installedAddons).subscribe({
      next: (res) => {
        this._allCompatibleAddons = res.addons;
        this.initAddonFormGroups(res.addons);
        this.applyRequiredParametersFilter();
        this.addonsLoading.set(false);

        // Pre-select installed addons (for reconfigure mode)
        if (this.installedAddons.length > 0) {
          for (const addonId of this.installedAddons) {
            const addon = this.availableAddons.find(a => a.id === addonId);
            if (addon) {
              try {
                this.applyAddonToggle(addonId, true, addon);
              } catch (err) {
                console.error(`Failed to pre-select addon ${addonId}(error ignored, works anyhow):`, err);
              }
            }
          }
        }
      },
      error: () => {
        // Don't show error for addons - they're optional
        // Just set loading to false and continue without addons
        this.addonsLoading.set(false);
      }
    });
  }

  /** All addons from backend before required_parameters filtering */
  private _allCompatibleAddons: IAddonWithParameters[] = [];

  /** Pre-create a flat FormGroup for each addon with all its parameter controls.
   *  Project-level defaults from unresolvedParameters take precedence over addon defaults. */
  private initAddonFormGroups(addons: IAddonWithParameters[]): void {
    for (const addon of addons) {
      if (!addon.parameters?.length) continue;
      const controls: Record<string, FormControl> = {};
      for (const param of addon.parameters) {
        const validators = param.required ? [Validators.required] : [];
        // Project default (from template 106) takes precedence over addon default
        const projectParam = this.unresolvedParameters.find(p => p.id === param.id);
        const defaultValue = projectParam?.default ?? param.default ?? '';
        controls[param.id] = new FormControl(defaultValue, validators);
      }
      this.addonFormGroups.set(addon.id, new FormGroup(controls));
    }
  }

  /** Apply addon filtering. required_parameters is checked by the backend.
   *  Also removes addon-owned parameters from groupedParameters to avoid
   *  duplicate/invisible form controls blocking the install button. */
  applyRequiredParametersFilter(): void {
    this.availableAddons = this._allCompatibleAddons;

    // Re-initialize addon FormGroups with project defaults from unresolvedParameters
    if (this._allCompatibleAddons.length > 0 && this.unresolvedParameters.length > 0) {
      this.initAddonFormGroups(this._allCompatibleAddons);
    }

    // Collect all parameter IDs owned by addons
    const addonParamIds = new Set<string>();
    for (const addon of this._allCompatibleAddons) {
      if (addon.parameters) {
        for (const p of addon.parameters) {
          addonParamIds.add(p.id);
        }
      }
    }

    // Remove addon-owned parameters from groupedParameters and form
    if (addonParamIds.size > 0) {
      for (const group in this.groupedParameters) {
        this.groupedParameters[group] = this.groupedParameters[group].filter(p => {
          if (addonParamIds.has(p.id)) {
            this.form.removeControl(p.id);
            return false;
          }
          return true;
        });
        if (this.groupedParameters[group].length === 0) {
          delete this.groupedParameters[group];
        }
      }
    }
  }

  private loadStacks(): void {
    this.stacksLoading.set(true);
    // Load stacktypes first, then load all stacks
    this.configService.getStacktypes().subscribe({
      next: (res) => {
        this.availableStacktypes.set(res.stacktypes);
        // Load all stacks (no filter - show all available)
        this.configService.getStacks().subscribe({
          next: (stacksRes) => {
            this.availableStacks.set(stacksRes.stacks);
            this.stacksLoading.set(false);
            this.refreshStacktypes();
          },
          error: () => {
            // Don't show error for stacks - they're optional
            this.stacksLoading.set(false);
          }
        });
      },
      error: () => {
        // Don't show error for stacktypes - they're optional
        this.stacksLoading.set(false);
      }
    });
  }

  onStackSelected(stack: IStack, stacktype?: string): void {
    if (stacktype) {
      this.selectedStacks.set(stacktype, stack);
    } else {
      // Legacy: set for all app stacktypes
      this.selectedStacks.clear();
      for (const st of this.appStacktypes) {
        this.selectedStacks.set(st, stack);
      }
    }
    // First selected stack is used for install (stackId in API call)
    this.formManager.setSelectedStacks(this.selectedStacks);
    this.formManager.updateHostnameFromStacks(this.selectedStacks);
    // Re-check dependencies (stack_name affects container matching)
    this.checkDependencies();
  }

  onStackSelectChange(stackId: string): void {
    const stack = this.filteredStacks.find(s => s.id === stackId);
    if (stack) {
      this.onStackSelected(stack);
    }
  }

  getSelectedStackForType(stacktype: string): IStack | null {
    return this.selectedStacks.get(stacktype) ?? null;
  }

  getStacktypeLabel(stacktype: string): string {
    const entry = this.availableStacktypes().find(e => e.name === stacktype);
    return entry?.displayName ?? stacktype;
  }

  get missingStacktypeLabels(): string {
    return this.missingStacktypes.map(t => this.getStacktypeLabel(t)).join(', ');
  }

  onCreateStackRequested(): void {
    // Get markers that need to be filled
    const envMarkers = this.composeService.extractMarkers(this.form.get('envs')?.value || '');
    const envFileMarkers = this.composeService.extractMarkersFromBase64(this.form.get('env_file')?.value || '');
    const suggestedEntries = [...new Set([...envMarkers, ...envFileMarkers])];

    const dialogData: CreateStackDialogData = {
      stacktypes: this.availableStacktypes(),
      suggestedEntries
    };

    const dialogRef = this.dialog.open(CreateStackDialog, {
      width: '600px',
      data: dialogData
    });

    dialogRef.afterClosed().subscribe((result: CreateStackDialogResult | undefined) => {
      if (result?.stack) {
        // Add to available stacks and apply it
        this.availableStacks.set([...this.availableStacks(), result.stack]);
        this.onStackSelected(result.stack);
      }
    });
  }

  toggleAddon(addonId: string, checked: boolean): void {
    const addon = this.availableAddons.find(a => a.id === addonId);

    // Gate: CA must be configured before enabling an addon with certtype parameters
    if (checked && addon?.parameters?.some(p => p.certtype) && !this.caConfigured()) {
      this.showCaRequiredDialog(addonId);
      return;
    }

    this.applyAddonToggle(addonId, checked, addon);
  }

  private applyAddonToggle(addonId: string, checked: boolean, addon?: IAddonWithParameters): void {
    if (checked) {
      this.selectedAddons.update(addons => [...addons, addonId]);
      // Add pre-created addon FormGroup to main form
      const addonFg = this.addonFormGroups.get(addonId);
      if (addonFg) {
        this.form.addControl(addonId, addonFg);
      }
      // Auto-expand if addon has required parameters
      if (addon?.parameters?.some(p => p.required)) {
        this.expandedAddons.update(addons => [...addons, addonId]);
      }
    } else {
      this.selectedAddons.update(addons => addons.filter(id => id !== addonId));
      // Collapse addon when deselected
      this.expandedAddons.update(addons => addons.filter(id => id !== addonId));
      // Remove addon FormGroup from main form
      if (this.form.contains(addonId)) {
        this.form.removeControl(addonId);
      }
    }
    // Update manager's addon list for install()
    this.formManager.setSelectedAddons(this.selectedAddons());
    // Re-check dependencies (addons may add/remove dependencies)
    this.checkDependencies();
    // Recompute effective stacktypes (addons may add/remove stacktype requirements)
    this.refreshStacktypes();
  }

  /** Compute effective stacktypes = app stacktypes + selected addon stacktypes (deduplicated) */
  private computeEffectiveStacktypes(): string[] {
    const st = this.data.app.stacktype;
    const types = !st ? [] : Array.isArray(st) ? [...st] : [st];
    for (const addonId of this.selectedAddons()) {
      const addon = this.availableAddons.find(a => a.id === addonId);
      if (addon?.stacktype) {
        const addonTypes = Array.isArray(addon.stacktype) ? addon.stacktype : [addon.stacktype];
        for (const t of addonTypes) {
          if (!types.includes(t)) types.push(t);
        }
      }
    }
    return types;
  }

  /** Recompute appStacktypes and missingStacktypes based on app + selected addons */
  private refreshStacktypes(): void {
    this.appStacktypes = this.computeEffectiveStacktypes();
    this.missingStacktypes = this.appStacktypes.filter(type => this.getStacksForType(type).length === 0);
    // Remove stack selections for stacktypes no longer needed
    for (const type of this.selectedStacks.keys()) {
      if (!this.appStacktypes.includes(type)) {
        this.selectedStacks.delete(type);
      }
    }
    // Auto-select per stacktype if only one stack matches
    for (const type of this.appStacktypes) {
      if (!this.selectedStacks.has(type)) {
        const typeStacks = this.getStacksForType(type);
        if (typeStacks.length === 1) {
          this.onStackSelected(typeStacks[0], type);
        }
      }
    }
    // Update formManager with all selected stacks
    this.formManager?.setSelectedStacks(this.selectedStacks);
  }

  private showCaRequiredDialog(addonId: string): void {
    const ref = this.dialog.open(CertificateManagementDialog, {
      width: '800px',
      maxHeight: '90vh',
    });
    ref.afterClosed().subscribe(() => {
      // Re-check CA status after dialog closes
      this.configService.getCaInfo().subscribe({
        next: (info) => {
          this.caConfigured.set(info.exists);
          if (info.exists) {
            const addon = this.availableAddons.find(a => a.id === addonId);
            this.applyAddonToggle(addonId, true, addon);
          }
        }
      });
    });
  }

  isAddonSelected(addonId: string): boolean {
    return this.selectedAddons().includes(addonId);
  }

  isAddonExpanded(addonId: string): boolean {
    return this.expandedAddons().includes(addonId);
  }

  toggleAddonExpanded(addonId: string, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.toggleAddonExpandedById(addonId);
  }

  /** Toggle addon expanded state by ID only (used by AddonSectionComponent) */
  toggleAddonExpandedById(addonId: string): void {
    this.expandedAddons.update(addons =>
      addons.includes(addonId)
        ? addons.filter(id => id !== addonId)
        : [...addons, addonId]
    );
  }

  hasAddonParameters(addon: IAddonWithParameters): boolean {
    return (addon.parameters?.length ?? 0) > 0;
  }

  getSelectedAddonParameters(): { addon: IAddonWithParameters; parameters: IParameter[] }[] {
    return this.selectedAddons()
      .map(addonId => this.availableAddons.find(a => a.id === addonId))
      .filter((addon): addon is IAddonWithParameters => addon !== undefined && (addon.parameters?.length ?? 0) > 0)
      .map(addon => ({ addon, parameters: addon.parameters! }));
  }

  getAddonGroupedParameters(addonName: string, param: IParameter): Record<string, IParameter[]> {
    const result: Record<string, IParameter[]> = {};
    result[addonName] = [param];
    return result;
  }

  @Input() customActions?: boolean;

  save() {
    if (this.form.invalid) return;
    this.loading.set(true);

    // Compute disabled addons: installed but no longer selected
    const currentlySelected = this.selectedAddons();
    const disabled = this.installedAddons.filter(id => !currentlySelected.includes(id));
    this.formManager.setDisabledAddons(disabled);
    this.formManager.setInstalledAddons(this.installedAddons);

    // Addons are already set in formManager via toggleAddon() -> setSelectedAddons()
    this.formManager.install(this.data.app.id, this.task).subscribe({
      next: () => {
        this.loading.set(false);
        this.dialogRef.close(this.form.value);
        // Navigation is handled by formManager.install()
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to install configuration', err);
        this.loading.set(false);
      }
    });
  }

  close(): void {
    this.dialogRef.close();
  }

  /** Extract params and upload files from the current form state */
  private collectInstallationData(): {
    params: { name: string; value: string | number | boolean }[];
    uploads: { name: string; content: string }[];
    addons?: string[];
    stackIds?: string[];
  } {
    const { changedParams } = this.formManager.extractParamsWithChanges();
    const uploads: { name: string; content: string }[] = [];
    const uploadParams = this.unresolvedParameters.filter(p => p.upload);

    for (const param of uploadParams) {
      const rawValue = this.form.get(param.id)?.value;
      if (!rawValue || typeof rawValue !== 'string') continue;

      const fileName = ParameterFormManager.extractFilenameFromFileMetadata(rawValue);
      const base64 = ParameterFormManager.extractBase64FromFileMetadata(rawValue);
      if (!fileName || typeof base64 !== 'string') continue;

      uploads.push({ name: fileName, content: base64 });

      // In params, replace base64 content with file reference
      const paramEntry = changedParams.find(p => p.name === param.id);
      if (paramEntry) {
        paramEntry.value = `file:${fileName}`;
      }
    }

    const result: {
      params: { name: string; value: string | number | boolean }[];
      uploads: { name: string; content: string }[];
      addons?: string[];
      stackIds?: string[];
    } = { params: changedParams, uploads };

    if (this.selectedAddons().length > 0) {
      result.addons = this.selectedAddons();
    }
    const stackIds = [...new Set(
      Array.from(this.selectedStacks.values()).map(s => s.id)
    )];
    if (stackIds.length > 0) {
      result.stackIds = stackIds;
    }
    return result;
  }

  async downloadInstallationFiles(): Promise<void> {
    const data = this.collectInstallationData();

    const output: Record<string, unknown> = { task: this.task, params: data.params };
    if (data.addons) output['selectedAddons'] = data.addons;
    if (data.stackIds) output['stackIds'] = data.stackIds;

    const zip = new JSZip();
    zip.file('default.json', JSON.stringify(output, null, 2));

    for (const file of data.uploads) {
      const binary = atob(file.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      zip.file(`uploads/${file.name}`, bytes);
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.data.app.id}-installation.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  loadParameterFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string);
          if (!Array.isArray(json.params)) {
            window.alert('Invalid parameter file: missing "params" array.');
            return;
          }
          this.applyParameterFile(json);
        } catch {
          window.alert('Failed to parse JSON file.');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  private applyParameterFile(json: { task?: string; params: { name: string; value: string | number | boolean }[]; selectedAddons?: string[]; stackIds?: string[] }): void {
    const applyValues = () => {
      for (const p of json.params) {
        const control = this.form.get(p.name);
        if (control) {
          control.setValue(p.value);
        }
      }
      // Select addons if specified
      if (json.selectedAddons) {
        for (const addonId of json.selectedAddons) {
          if (!this.selectedAddons().includes(addonId)) {
            this.toggleAddon(addonId, true);
          }
        }
      }
      // Select stacks if specified
      if (json.stackIds) {
        for (const stackId of json.stackIds) {
          const stack = this.availableStacks().find(s => s.id === stackId);
          if (stack) {
            this.onStackSelected(stack);
          }
        }
      }
    };

    // If task changed, reload parameters with new task first
    if (json.task && json.task !== this.task) {
      this.task = json.task;
      this.loading.set(true);
      this.configService.getUnresolvedParameters(this.data.app.id, this.task).subscribe({
        next: (res) => {
          this.unresolvedParameters = res.unresolvedParameters;
          this.groupedParameters = {};
          // Remove old controls
          for (const key of Object.keys(this.form.controls)) {
            this.form.removeControl(key);
          }
          for (const param of this.unresolvedParameters) {
            if (param.id.startsWith('addon_')) continue;
            const group = param.templatename || 'General';
            if (!this.groupedParameters[group]) this.groupedParameters[group] = [];
            this.groupedParameters[group].push(param);
            const validators = param.required ? [Validators.required] : [];
            const defaultValue = param.default !== undefined ? param.default : '';
            this.form.addControl(param.id, new FormControl(defaultValue, validators));
          }
          this.form.markAllAsTouched();
          this.loading.set(false);
          this.loadEnumValues();
          applyValues();
        },
        error: (err: unknown) => {
          this.errorHandler.handleError('Failed to reload parameters for task', err);
          this.loading.set(false);
        }
      });
    } else {
      applyValues();
    }
  }

  get taskLabel(): string {
    const labels: Record<string, string> = {
      installation: 'Install',
      reconfigure: 'Reconfigure',
      upgrade: 'Upgrade',
      update: 'Update',
      backup: 'Backup',
      restore: 'Restore',
      uninstall: 'Uninstall',
    };
    return labels[this.task] ?? 'Execute';
  }

  saveAsTestData(): void {
    const scenarioName = window.prompt('Scenario name:', 'default')?.trim();
    if (!scenarioName) return;

    const data = this.collectInstallationData();
    this.configService.saveTestData(this.data.app.id, { scenarioName, ...data }).subscribe({
      next: (res) => {
        window.alert(`Test data saved to ${res.testsDir}/${scenarioName}.json`);
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to save test data', err);
      }
    });
  }

  /** Check if dependency containers are running. Re-called on addon/stack changes. */
  private checkDependencies(): void {
    const stackId = this.selectedStack?.id;
    this.configService.checkDependencies(
      this.data.app.id,
      this.selectedAddons(),
      stackId ?? undefined,
    ).subscribe({
      next: (res) => {
        const errors = res.dependencies.filter(d => d.status !== 'running');
        this.dependencyErrors.set(errors);
      },
      error: () => {
        // Don't block UI on dependency check failure - clear errors
        this.dependencyErrors.set([]);
      }
    });
  }

  /** Whether the install button should be disabled */
  get installDisabled(): boolean {
    return this.hasVisibleInvalidControls || this.loading() || this.dependencyErrors().length > 0;
  }

  /** Check if any visible (non-hidden) form control is invalid */
  private get hasVisibleInvalidControls(): boolean {
    for (const [name, control] of Object.entries(this.form.controls)) {
      if (!control.invalid) continue;
      // Check if this parameter has an 'if' condition that hides it
      const param = this.unresolvedParameters.find(p => p.id === name);
      if (param?.if && !this.evaluateCondition(param.if)) continue;
      return true;
    }
    return false;
  }

  /** Returns names of invalid visible form controls (for debugging) */
  get invalidControls(): string[] {
    const invalid: string[] = [];
    for (const [name, control] of Object.entries(this.form.controls)) {
      if (!control.invalid) continue;
      const param = this.unresolvedParameters.find(p => p.id === name);
      if (param?.if && !this.evaluateCondition(param.if)) continue;
      invalid.push(name);
    }
    return invalid;
  }

  toggleAdvanced(): void {
    this.showAdvanced.set(!this.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.unresolvedParameters.some(p => p.advanced);
  }

  get missingRequiredParams(): IParameter[] {
    return this.unresolvedParameters.filter((p) => {
      // Skip if not required or has a default value
      if (p.required !== true || (p.default !== undefined && p.default !== null && p.default !== '')) {
        return false;
      }
      // Skip if param has an 'if' condition and the condition is not met
      if (p.if && !this.evaluateCondition(p.if)) {
        return false;
      }
      // Skip if user has already provided a value via the form
      const control = this.form.get(p.id);
      if (control && control.value) {
        return false;
      }
      return true;
    });
  }

  /**
   * Evaluates a condition for param.if.
   * Special conditions like 'env_file_has_markers' are computed from other controls.
   */
  private evaluateCondition(condition: string): boolean {
    // Special: env_file_has_markers - check if envs or env_file contains {{ }} markers
    if (condition === 'env_file_has_markers') {
      // Check envs for markers (oci-image case)
      const envsValue = this.form.get('envs')?.value;
      if (this.composeService.hasMarkers(envsValue)) {
        return true;
      }
      // Check env_file for markers (docker-compose case)
      const envFileValue = this.form.get('env_file')?.value;
      if (envFileValue && this.composeService.hasMarkersInBase64(envFileValue)) {
        return true;
      }
      return false;
    }
    // Default: check form control value
    return !!this.form.get(condition)?.value;
  }

  get showMissingRequiredHint(): boolean {
    return this.missingRequiredParams.length > 0;
  }

  get missingRequiredParamsLabel(): string {
    return this.missingRequiredParams.map((p) => p.id).join(', ');
  }

  get taskKey(): string {
    return this.task;
  }


  openTemplateTrace(): void {
    this.configService.getTemplateTrace(this.data.app.id, this.task).subscribe({
      next: (trace) => {
        this.dialog.open(TemplateTraceDialog, {
          width: '900px',
          data: {
            applicationName: this.data.app.name,
            task: this.task,
            trace,
            missingRequiredIds: this.missingRequiredParams.map((param) => param.id),
          },
        });
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load template trace', err);
      }
    });
  }


  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  private onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      // Reload stacks when tab becomes visible again
      this.reloadStacks();
    }
  }

  private reloadStacks(): void {
    const previousSelections = new Map(this.selectedStacks);
    this.configService.getStacks().subscribe({
      next: (res) => {
        this.availableStacks.set(res.stacks);
        this.appStacktypes = this.computeEffectiveStacktypes();
        this.missingStacktypes = this.appStacktypes.filter(type => this.getStacksForType(type).length === 0);
        // Re-select previously selected stacks per stacktype
        this.selectedStacks.clear();
        for (const type of this.appStacktypes) {
          const typeStacks = this.getStacksForType(type);
          const prevStack = previousSelections.get(type);
          if (prevStack) {
            const found = typeStacks.find(s => s.id === prevStack.id);
            if (found) {
              this.selectedStacks.set(type, found);
            } else if (typeStacks.length === 1) {
              this.selectedStacks.set(type, typeStacks[0]);
            }
          } else if (typeStacks.length === 1) {
            this.selectedStacks.set(type, typeStacks[0]);
          }
        }
      }
    });
  }
}
