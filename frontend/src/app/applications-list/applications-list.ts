import { Component, inject, OnInit, ViewChild } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { ErrorDialog } from './error-dialog';
import { VeConfigurationDialog, VeConfigurationDialogData } from '../ve-configuration-dialog/ve-configuration-dialog';
import { IApplicationWeb, ITagsConfig } from '../../shared/types';
import { CardGridComponent } from '../shared/components/card-grid/card-grid';

interface IApplicationWebIntern extends IApplicationWeb {
  showErrors?: boolean;
}

@Component({
  selector: 'app-applications-list',
  standalone: true,
  imports: [CommonModule, MatDialogModule, RouterModule, CardGridComponent],
  templateUrl: './applications-list.html',
  styleUrl: './applications-list.scss',
})
export class ApplicationsList implements OnInit {
  @ViewChild(CardGridComponent) cardGrid!: CardGridComponent<IApplicationWebIntern>;

  applications: IApplicationWebIntern[] = [];
  loading = true;
  error?: string;

  private proxmoxService = inject(VeConfigurationService);
  private dialog = inject(MatDialog);
  private cacheService = inject(CacheService);
  private route = inject(ActivatedRoute);
  private location = inject(Location);

  // Filter function for internal apps
  filterApp = (app: IApplicationWebIntern, tagsConfig: ITagsConfig, showInternal: boolean): boolean => {
    if (showInternal) return true;
    return !tagsConfig.internal.includes(app.id);
  };

  // Get app ID for internal check
  getAppId = (app: IApplicationWebIntern): string => app.id;

  // Track by function
  trackByApp = (_: number, app: IApplicationWebIntern): string => app.id;

  // Get tags for grouping
  getAppTags = (app: IApplicationWebIntern): string[] | undefined => app.tags;

  openProxmoxConfigDialog(app: IApplicationWebIntern) {
    const dialogData: VeConfigurationDialogData = { app, task: 'installation' };
    this.dialog.open(VeConfigurationDialog, { data: dialogData });
  }

  showErrors(app: IApplicationWebIntern) {
    if (app.errors && app.errors.length > 0) {
      this.dialog.open(ErrorDialog, { data: { errors: app.errors }, panelClass: 'error-dialog-panel' });
    }
  }

  ngOnInit(): void {
    this.proxmoxService.getApplications().subscribe({
      next: (apps) => {
        this.applications = apps.map((app) => ({ ...app, showErrors: false }));
        // Update cache with application IDs for validation in create-application
        const applicationIds = apps.map(app => app.id);
        this.cacheService.setApplicationIds(applicationIds);
        this.loading = false;

        // Check for addon mode from query params
        this.route.queryParams.subscribe(params => {
          if (params['mode'] === 'addon' && params['application_id']) {
            this.openAddonDialog(params);
          }
        });
      },
      error: () => {
        this.error = 'Error loading applications';
        this.loading = false;
      }
    });
  }

  private openAddonDialog(params: Record<string, string>): void {
    const applicationId = params['application_id'];
    const app = this.applications.find(a => a.id === applicationId);
    if (!app) {
      this.error = `Application '${applicationId}' not found`;
      return;
    }

    // Build preset values from query params
    const presetValues: Record<string, string | number> = {};
    const paramKeys = ['vm_id', 'hostname', 'oci_image', 'application_id', 'application_name', 'username', 'uid', 'gid',
                       'memory', 'cores', 'rootfs_storage', 'disk_size', 'bridge'];
    for (const key of paramKeys) {
      if (params[key] !== undefined) {
        // Convert numeric values
        if (['vm_id', 'memory', 'cores'].includes(key)) {
          presetValues[key] = parseInt(params[key], 10);
        } else {
          presetValues[key] = params[key];
        }
      }
    }

    // Parse existing mount points from JSON string
    let existingMountPoints: { source: string; target: string }[] | undefined;
    if (params['mount_points']) {
      try {
        existingMountPoints = JSON.parse(params['mount_points']);
      } catch {
        // Ignore parse errors - mount points are optional info
      }
    }

    // Parse installed addons from comma-separated string
    const installedAddons = params['installed_addons']?.split(',').filter(Boolean) || [];

    // Open dialog in addon-reconfigure mode with preset values
    const dialogData: VeConfigurationDialogData = {
      app,
      task: 'addon-reconfigure',
      presetValues,
      existingMountPoints,
      installedAddons,
    };
    const dialogRef = this.dialog.open(VeConfigurationDialog, { data: dialogData });

    // Navigate back when dialog is closed without submission
    dialogRef.afterClosed().subscribe(result => {
      if (!result) {
        this.location.back();
      }
    });
  }

  get showFramework(): boolean {
    return this.cardGrid?.showFramework ?? false;
  }
}
