import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { IManagedOciContainer } from '../../shared/types';
import { CardGridComponent } from '../shared/components/card-grid/card-grid';
import { CertificateManagementDialog } from '../certificate-management/certificate-management-dialog';

@Component({
  selector: 'app-installed-list',
  standalone: true,
  imports: [CommonModule, RouterModule, CardGridComponent, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './installed-list.html',
  styleUrl: './installed-list.scss',
})
export class InstalledList implements OnInit {
  installations: IManagedOciContainer[] = [];
  loading = true;
  error?: string;

  private svc = inject(VeConfigurationService);
  private cacheService = inject(CacheService);
  private router = inject(Router);
  private dialog = inject(MatDialog);

  // Track by function — use hostname for host entries (vm_id=0)
  trackByInstallation = (_: number, item: IManagedOciContainer): string | number =>
    item.is_host ? `host:${item.hostname}` : item.vm_id;

  ngOnInit(): void {
    this.cacheService.getInstallations().subscribe({
      next: (items) => {
        this.installations = items;
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading installations';
        this.loading = false;
      }
    });
  }

  startUpgrade(installation: IManagedOciContainer) {
    const application = installation.application_id || 'oci-lxc-deployer';
    this.svc.postVeUpgrade(application, {
      previouse_vm_id: installation.vm_id,
      oci_image: installation.oci_image,
      application_id: installation.application_id,
      application_name: installation.application_name,
      version: installation.version,
      addons: installation.addons,
    }).subscribe({
      next: () => {
        this.router.navigate(['/monitor']);
      },
      error: () => {
        this.error = 'Error starting upgrade';
      },
    });
  }

  editAddons(installation: IManagedOciContainer) {

    // Build query params
    const queryParams: Record<string, string | number | undefined> = {
      mode: 'addon',
      application_id: installation.application_id,
      application_name: installation.application_name,
      oci_image: installation.oci_image,
      installed_addons: installation.addons?.join(',') || undefined,
      // Host entries (e.g. Proxmox) have no vm_id
      ...(installation.is_host
        ? { is_host: 'true', hostname: installation.hostname }
        : { previouse_vm_id: installation.vm_id }),
    };

    // Filter out undefined values
    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined)
    );
    this.router.navigate(['/applications'], { queryParams: filteredParams });
  }

  openCertificateManagement(): void {
    this.dialog.open(CertificateManagementDialog, {
      width: '800px',
      maxHeight: '90vh',
    });
  }
}
