import { Component, Input, Output, EventEmitter, signal, inject } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { IAddonWithParameters, IParameter, IStack } from '../../../../shared/types';
import { ParameterGroupComponent } from '../../../ve-configuration-dialog/parameter-group.component';
import { AddonNoticeDialogComponent } from '../addon-notice-dialog/addon-notice-dialog.component';
import { AuthService } from '../../../auth/auth.service';

type OidcMode = 'auto' | 'manual';

@Component({
  selector: 'app-addon-section',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatCheckboxModule,
    MatExpansionModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatTooltipModule,
    ParameterGroupComponent
  ],
  template: `
    @if (loading()) {
      <div class="addons-loading">
        <mat-spinner diameter="24"></mat-spinner>
        <span>Loading addons...</span>
      </div>
    } @else if (availableAddons.length > 0) {
      <div class="addons-section">
        <h3>{{ title }}</h3>
        <mat-accordion [multi]="true">
          @for (addon of availableAddons; track addon.id) {
            <mat-expansion-panel [expanded]="isAddonExpanded(addon.id)"
                                 [disabled]="!isAddonSelected(addon.id) || !hasAddonParameters(addon)"
                                 (opened)="onPanelOpened(addon.id)"
                                 (closed)="onPanelClosed(addon.id)"
                                 class="addon-panel">
              <mat-expansion-panel-header (click)="$event.stopPropagation()">
                <mat-panel-title>
                  <span [matTooltip]="getAddonDisabledReason(addon.id)">
                    <mat-checkbox
                      [checked]="isAddonSelected(addon.id)"
                      [disabled]="isAddonDisabled(addon.id)"
                      (change)="onAddonToggle(addon.id, $event.checked)"
                      (click)="$event.stopPropagation()">
                      {{ addon.name }}
                    </mat-checkbox>
                  </span>
                </mat-panel-title>
                <mat-panel-description>
                  @if (addon.description) {
                    {{ addon.description }}
                  }
                </mat-panel-description>
              </mat-expansion-panel-header>
              @if (isAddonSelected(addon.id) && hasAddonParameters(addon)) {
                <div class="addon-parameters">
                  @if (addon.id === 'addon-oidc' && canAutoProvisionOidc) {
                    <mat-radio-group class="oidc-mode-toggle"
                                     [value]="oidcMode()"
                                     (change)="setOidcMode($event.value)">
                      <mat-radio-button value="auto" matTooltip="Look up or auto-create the client in Zitadel using your session">
                        Auto (via Zitadel)
                      </mat-radio-button>
                      <mat-radio-button value="manual" matTooltip="Enter an existing Client ID, Secret and Issuer URL">
                        Manual
                      </mat-radio-button>
                    </mat-radio-group>
                  }
                  <app-parameter-group
                    [groupName]="addon.name"
                    [groupedParameters]="getAddonGroupedParametersAll(addon)"
                    [form]="getAddonFormGroup(addon.id)"
                    [showAdvanced]="showAdvanced"
                    [hideGroupName]="true"
                    [availableStacks]="availableStacks"
                    (stackSelected)="stackSelected.emit($event)"
                    (createStackRequested)="createStackRequested.emit()"
                  />
                </div>
              }
            </mat-expansion-panel>
          }
        </mat-accordion>
      </div>
    }
  `,
  styles: [`
    .addons-section {
      margin-bottom: 1rem;
    }

    .addons-section h3 {
      margin: 0 0 0.5rem 0;
      font-size: 1.1rem;
      font-weight: 500;
    }

    .addon-panel {
      margin-bottom: 0 !important;
    }

    .addon-parameters {
      max-width: 60%;
    }

    .oidc-mode-toggle {
      display: flex;
      gap: 1rem;
      padding: 0.5rem 0 0.75rem;
    }

    :host ::ng-deep .addon-panel .mat-expansion-panel-body {
      padding: 0 16px 0;
    }

    .addons-loading {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #666;
      padding: 1rem 0;
    }

    :host ::ng-deep .addon-panel .mat-expansion-panel-header {
      padding: 0 16px;
      height: 40px !important;
    }

    :host ::ng-deep .addon-panel .mat-expansion-panel-header.mat-expanded {
      height: 40px !important;
    }

    mat-panel-description {
      font-size: 0.85rem;
      color: #666;
    }
  `]
})
export class AddonSectionComponent {
  private dialog = inject(MatDialog);
  private auth = inject(AuthService);

  @Input() availableAddons: IAddonWithParameters[] = [];
  @Input() selectedAddons: string[] = [];
  @Input() expandedAddons: string[] = [];
  @Input() form!: FormGroup;
  @Input() addonFormGroups = new Map<string, FormGroup>();
  @Input() showAdvanced = false;
  @Input() availableStacks: IStack[] = [];
  @Input() requiredAddons: string[] = [];
  @Input() appParameterIds: string[] = [];
  @Input() title = 'Optional Addons';
  @Input() description = '';

  loading = signal(false);

  private oidcModeOverride = signal<OidcMode | null>(null);

  private static readonly OIDC_AUTO_PARAM_IDS = ['oidc_app_name', 'oidc_project_name'];
  private static readonly OIDC_MANUAL_PARAM_IDS = ['oidc_client_id', 'oidc_client_secret', 'oidc_issuer_url'];

  @Input() set isLoading(value: boolean) {
    this.loading.set(value);
  }

  /** True when the current session can talk to the Zitadel Management API. */
  get canAutoProvisionOidc(): boolean {
    return this.auth.isOidcEnabled && this.auth.isAuthenticated;
  }

  /** Effective OIDC credential input mode. Forced to 'manual' when no OIDC session is available. */
  oidcMode = (): OidcMode => {
    if (!this.canAutoProvisionOidc) return 'manual';
    return this.oidcModeOverride() ?? 'auto';
  };

  setOidcMode(mode: OidcMode): void {
    this.oidcModeOverride.set(mode);
    const fg = this.addonFormGroups.get('addon-oidc');
    if (!fg) return;
    const fieldsToClear = mode === 'auto'
      ? AddonSectionComponent.OIDC_MANUAL_PARAM_IDS
      : AddonSectionComponent.OIDC_AUTO_PARAM_IDS;
    for (const id of fieldsToClear) {
      const ctrl = fg.get(id);
      if (ctrl) ctrl.setValue('');
    }
  }

  @Output() addonToggled = new EventEmitter<{ addonId: string; checked: boolean }>();
  @Output() addonExpandedChanged = new EventEmitter<string>();
  @Output() stackSelected = new EventEmitter<IStack>();
  @Output() createStackRequested = new EventEmitter<void>();

  /** Check if an addon is disabled (required, exclusive conflict, or insufficient permissions) */
  isAddonDisabled(addonId: string): boolean {
    if (this.requiredAddons.includes(addonId)) return true;
    // Disabled if a mutually exclusive addon is selected
    for (const group of AddonSectionComponent.EXCLUSIVE_GROUPS) {
      if (group.includes(addonId)) {
        for (const other of group) {
          if (other !== addonId && this.isAddonSelected(other)) return true;
        }
      }
    }
    if (addonId !== 'addon-oidc') return false;
    if (!this.auth.isOidcEnabled) return false;
    return !this.auth.canConfigureOidc;
  }

  /** Tooltip reason when an addon is disabled */
  getAddonDisabledReason(addonId: string): string {
    if (this.requiredAddons.includes(addonId)) return 'Required by this application';
    for (const group of AddonSectionComponent.EXCLUSIVE_GROUPS) {
      if (group.includes(addonId)) {
        const active = group.find(other => other !== addonId && this.isAddonSelected(other));
        if (active) {
          const activeAddon = this.availableAddons.find(a => a.id === active);
          return `Mutually exclusive with ${activeAddon?.name ?? active}`;
        }
      }
    }
    if (!this.isAddonDisabled(addonId)) return '';
    return 'Insufficient permissions: requires ORG_OWNER or PROJECT_OWNER role in ZITADEL';
  }

  isAddonSelected(addonId: string): boolean {
    return this.selectedAddons.includes(addonId);
  }

  isAddonExpanded(addonId: string): boolean {
    return this.expandedAddons.includes(addonId);
  }

  hasAddonParameters(addon: IAddonWithParameters): boolean {
    return !!addon.parameters && addon.parameters.length > 0;
  }

  // Mutually exclusive addon groups: enabling one disables the others
  private static readonly EXCLUSIVE_GROUPS: string[][] = [
    ['addon-ssl', 'addon-acme'],
  ];

  onAddonToggle(addonId: string, checked: boolean): void {
    const addon = this.availableAddons.find(a => a.id === addonId);

    if (checked && addon?.notice) {
      this.dialog.open(AddonNoticeDialogComponent, {
        data: { addonName: addon.name, notice: addon.notice },
        width: '500px',
      }).afterClosed().subscribe(confirmed => {
        if (confirmed) {
          this.emitWithExclusivity(addonId, true);
        } else {
          this.addonToggled.emit({ addonId, checked: false });
        }
      });
      return;
    }

    this.emitWithExclusivity(addonId, checked);
  }

  /** When enabling an addon, disable mutually exclusive addons */
  private emitWithExclusivity(addonId: string, checked: boolean): void {
    if (checked) {
      for (const group of AddonSectionComponent.EXCLUSIVE_GROUPS) {
        if (group.includes(addonId)) {
          for (const other of group) {
            if (other !== addonId && this.isAddonSelected(other)) {
              this.addonToggled.emit({ addonId: other, checked: false });
            }
          }
        }
      }
    }
    this.addonToggled.emit({ addonId, checked });
  }

  onPanelOpened(addonId: string): void {
    if (!this.isAddonExpanded(addonId)) {
      this.addonExpandedChanged.emit(addonId);
    }
  }

  onPanelClosed(addonId: string): void {
    if (this.isAddonExpanded(addonId)) {
      this.addonExpandedChanged.emit(addonId);
    }
  }

  getAddonFormGroup(addonId: string): FormGroup {
    return this.addonFormGroups.get(addonId) ?? this.form;
  }

  getAddonGroupedParametersAll(addon: IAddonWithParameters): Record<string, IParameter[]> {
    const appIds = new Set(this.appParameterIds);
    let params = (addon.parameters ?? []).filter(p =>
      (!p.advanced || this.showAdvanced) && !appIds.has(p.id)
    );
    if (addon.id === 'addon-oidc') {
      const hiddenIds = this.oidcMode() === 'auto'
        ? AddonSectionComponent.OIDC_MANUAL_PARAM_IDS
        : AddonSectionComponent.OIDC_AUTO_PARAM_IDS;
      const hidden = new Set(hiddenIds);
      params = params.filter(p => !hidden.has(p.id));
    }
    return { [addon.name]: params };
  }
}
