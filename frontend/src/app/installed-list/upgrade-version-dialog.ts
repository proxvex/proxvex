import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { VeConfigurationService } from '../ve-configuration.service';
import { IManagedOciContainer, IServiceVersion } from '../../shared/types';

export interface UpgradeVersionDialogData {
  installation: IManagedOciContainer;
}

export interface UpgradeVersionDialogResult {
  target_versions: string;
}

@Component({
  selector: 'app-upgrade-version-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    FormsModule,
  ],
  template: `
    <h2 mat-dialog-title>Upgrade {{ data.installation.application_name || data.installation.application_id || 'Container' }}</h2>
    <mat-dialog-content>
      @if (loading()) {
        <div class="loading-container">
          <mat-spinner diameter="32"></mat-spinner>
          <span>Loading service versions...</span>
        </div>
      } @else if (error()) {
        <div class="error-message">{{ error() }}</div>
      } @else {
        <p class="info-text">Set target versions for each service. Use "latest" for the newest available version.</p>
        <div class="version-fields">
          @for (svc of serviceVersions(); track svc.service) {
            <mat-form-field appearance="outline" class="version-field">
              <mat-label>{{ svc.image || svc.service }}</mat-label>
              <input matInput [(ngModel)]="svc.targetVersion" placeholder="latest">
              <mat-hint>Current: {{ svc.currentVersion }}</mat-hint>
            </mat-form-field>
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary"
        [disabled]="loading() || !!error()"
        (click)="submit()">
        Upgrade
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .loading-container {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px 0;
    }
    .error-message {
      color: var(--mat-warn-color, #f44336);
      padding: 16px 0;
    }
    .info-text {
      margin-bottom: 16px;
      color: rgba(255, 255, 255, 0.7);
    }
    .version-fields {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .version-field {
      width: 100%;
    }
  `],
})
export class UpgradeVersionDialog implements OnInit {
  data = inject<UpgradeVersionDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<UpgradeVersionDialog>);
  private svc = inject(VeConfigurationService);

  loading = signal(true);
  error = signal<string | null>(null);
  serviceVersions = signal<(IServiceVersion & { targetVersion: string })[]>([]);

  ngOnInit(): void {
    const vmId = this.data.installation.vm_id;
    this.svc.getInstallationVersions(vmId).subscribe({
      next: (res) => {
        const versions = res.services.map(svc => ({
          ...svc,
          targetVersion: 'latest',
        }));
        this.serviceVersions.set(versions);
        this.loading.set(false);
      },
      error: (err) => {
        // Fallback: if version info unavailable, allow upgrade without version selection
        this.error.set(null);
        this.loading.set(false);
      },
    });
  }

  submit(): void {
    const versions = this.serviceVersions();
    // Build target_versions string: "service1=version1,service2=version2"
    const targetVersions = versions
      .map(svc => `${svc.service}=${svc.targetVersion || 'latest'}`)
      .join(',');
    this.dialogRef.close({ target_versions: targetVersions } as UpgradeVersionDialogResult);
  }
}
