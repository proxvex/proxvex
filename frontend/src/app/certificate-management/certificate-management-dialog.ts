import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { ICertificateStatus, ICaInfoResponse } from '../../shared/types';

@Component({
  selector: 'app-certificate-management-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    MatTableModule,
    MatSlideToggleModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title>Certificate Management</h2>
    <mat-dialog-content>
      <!-- Section 1: CA Management -->
      <section class="ca-section">
        <h3>Certificate Authority</h3>
        @if (loadingCa()) {
          <mat-spinner diameter="24"></mat-spinner>
        } @else if (caInfo()?.exists) {
          <div class="ca-info">
            <p><strong>Subject:</strong> {{ caInfo()?.subject }}</p>
            <p><strong>Expires:</strong> {{ caInfo()?.expiry_date | date:'mediumDate' }}</p>
            <p><strong>Days remaining:</strong> {{ caInfo()?.days_remaining }}</p>
          </div>
        } @else {
          <p class="no-ca-hint">No CA configured</p>
        }
        @if (caInfo()?.exists) {
          <div class="ssl-toggle">
            <mat-slide-toggle [checked]="sslEnabled()" (change)="onSslToggle($event.checked)">
              Enable SSL for new installations
            </mat-slide-toggle>
            <p class="ssl-hint">When enabled, certificates are auto-generated for apps that support SSL.</p>
          </div>
        }
        <div class="ca-actions">
          <button mat-stroked-button (click)="importCa()" [disabled]="loadingCa()">
            <mat-icon>upload_file</mat-icon>
            Import CA
          </button>
          <button mat-stroked-button (click)="generateCa()" [disabled]="loadingCa()">
            <mat-icon>add_circle</mat-icon>
            Generate CA
          </button>
          @if (caInfo()?.exists) {
            <button mat-stroked-button (click)="downloadCaCert()" matTooltip="Download CA cert for client trust">
              <mat-icon>download</mat-icon>
              Download CA Cert
            </button>
          }
        </div>
      </section>

      <!-- Section 2: Deployer HTTPS Status -->
      <section class="https-section">
        <h3>Deployer HTTPS</h3>
        <div class="https-status">
          @if (httpsActive) {
            <span class="status-chip status-ok">ACTIVE</span>
            <span class="https-label">This page is served over HTTPS</span>
          } @else {
            <span class="status-chip status-warning">INACTIVE</span>
            <span class="https-label">HTTPS not active. Set <code>DEPLOYER_SSL_GENERATE=true</code> and restart.</span>
          }
        </div>
      </section>

      <!-- Section 3: PVE Host Certificate -->
      <section class="pve-section">
        <h3>PVE Host Certificate</h3>
        @if (loadingPve()) {
          <mat-spinner diameter="24"></mat-spinner>
        } @else if (pveStatus()) {
          <div class="pve-info">
            <p><strong>Subject:</strong> {{ pveStatus()?.subject || 'N/A' }}</p>
            <p><strong>Expires:</strong> {{ pveStatus()?.expiry_date | date:'mediumDate' }}</p>
            <span class="status-chip" [class]="'status-' + pveStatus()?.status">
              {{ pveStatus()?.status | uppercase }}
            </span>
          </div>
        }
        <div class="pve-actions">
          <button mat-stroked-button color="warn" (click)="provisionPve()" [disabled]="!caInfo()?.exists || loadingPve()"
            matTooltip="Generates server cert for PVE host and restarts pveproxy">
            <mat-icon>security</mat-icon>
            Provision PVE Certificate
          </button>
        </div>
      </section>

      <!-- Section 4: Certificate Status & Renewal -->
      <section class="certs-section">
        <h3>Deployed Certificates</h3>
        @if (loadingCerts()) {
          <mat-spinner diameter="24"></mat-spinner>
        } @else if (certificates().length === 0) {
          <p class="no-certs-hint">No certificates found</p>
        } @else {
          <table mat-table [dataSource]="certificates()" class="cert-table">
            <ng-container matColumnDef="select">
              <th mat-header-cell *matHeaderCellDef>
                <mat-checkbox (change)="toggleAllSelection($event.checked)" [checked]="allSelected()"></mat-checkbox>
              </th>
              <td mat-cell *matCellDef="let cert">
                <mat-checkbox [checked]="isSelected(cert)" (change)="toggleSelection(cert)"></mat-checkbox>
              </td>
            </ng-container>

            <ng-container matColumnDef="hostname">
              <th mat-header-cell *matHeaderCellDef>Hostname</th>
              <td mat-cell *matCellDef="let cert">{{ cert.hostname }}</td>
            </ng-container>

            <ng-container matColumnDef="certtype">
              <th mat-header-cell *matHeaderCellDef>Type</th>
              <td mat-cell *matCellDef="let cert">{{ cert.certtype }}</td>
            </ng-container>

            <ng-container matColumnDef="subject">
              <th mat-header-cell *matHeaderCellDef>Subject</th>
              <td mat-cell *matCellDef="let cert">{{ cert.subject }}</td>
            </ng-container>

            <ng-container matColumnDef="expiry">
              <th mat-header-cell *matHeaderCellDef>Expires</th>
              <td mat-cell *matCellDef="let cert">{{ cert.expiry_date | date:'mediumDate' }}</td>
            </ng-container>

            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>Status</th>
              <td mat-cell *matCellDef="let cert">
                <span class="status-chip" [class]="'status-' + cert.status">
                  {{ cert.status | uppercase }}
                </span>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
          </table>

          <div class="renewal-actions">
            <button mat-stroked-button (click)="renewSelected()" [disabled]="selectedCerts().length === 0 || !caInfo()?.exists">
              <mat-icon>autorenew</mat-icon>
              Renew Selected ({{ selectedCerts().length }})
            </button>
            <button mat-stroked-button (click)="renewExpiring()" [disabled]="!caInfo()?.exists"
              matTooltip="Renew all certificates expiring within 30 days">
              <mat-icon>warning</mat-icon>
              Renew All Expiring
            </button>
          </div>
        }
      </section>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 600px;
      max-height: 70vh;
      overflow-y: auto;
    }

    section {
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #e0e0e0;

      &:last-child {
        border-bottom: none;
      }
    }

    h3 {
      margin: 0 0 0.75rem 0;
      font-weight: 500;
      color: #333;
    }

    .ca-info, .pve-info {
      background: #f5f5f5;
      padding: 0.75rem;
      border-radius: 4px;
      margin-bottom: 0.75rem;

      p {
        margin: 0.25rem 0;
        font-size: 0.9rem;
      }
    }

    .https-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;

      .https-label {
        font-size: 0.9rem;
        color: #555;

        code {
          background: #f0f0f0;
          padding: 1px 4px;
          border-radius: 3px;
          font-size: 0.85rem;
        }
      }
    }

    .ssl-toggle {
      margin: 0.75rem 0;

      .ssl-hint {
        margin: 0.25rem 0 0 0;
        font-size: 0.8rem;
        color: #666;
      }
    }

    .ca-actions, .pve-actions, .renewal-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-top: 0.5rem;
    }

    .no-ca-hint, .no-certs-hint {
      color: #999;
      font-style: italic;
      margin: 0.5rem 0;
    }

    .status-chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;

      &.status-ok {
        background: #e8f5e9;
        color: #2e7d32;
      }
      &.status-warning {
        background: #fff3e0;
        color: #e65100;
      }
      &.status-expired {
        background: #ffebee;
        color: #c62828;
      }
    }

    .cert-table {
      width: 100%;
      margin-bottom: 0.75rem;
    }

    mat-spinner {
      margin: 0.5rem 0;
    }
  `]
})
export class CertificateManagementDialog implements OnInit {
  dialogRef = inject(MatDialogRef<CertificateManagementDialog>);
  private configService = inject(VeConfigurationService);
  private errorHandler = inject(ErrorHandlerService);

  httpsActive = location.protocol === 'https:';

  caInfo = signal<ICaInfoResponse | null>(null);
  sslEnabled = signal(false);
  pveStatus = signal<ICertificateStatus | null>(null);
  certificates = signal<ICertificateStatus[]>([]);
  selectedCerts = signal<ICertificateStatus[]>([]);

  loadingCa = signal(false);
  loadingPve = signal(false);
  loadingCerts = signal(false);

  displayedColumns = ['select', 'hostname', 'certtype', 'subject', 'expiry', 'status'];

  ngOnInit(): void {
    this.loadCaInfo();
    this.loadPveStatus();
    this.loadCertificates();
  }

  private loadCaInfo(): void {
    this.loadingCa.set(true);
    this.configService.getCaInfo().subscribe({
      next: (info) => {
        this.caInfo.set(info);
        this.sslEnabled.set(info.ssl_enabled ?? false);
        this.loadingCa.set(false);
      },
      error: () => { this.loadingCa.set(false); }
    });
  }

  onSslToggle(checked: boolean): void {
    this.configService.postSslToggle({ ssl_enabled: checked }).subscribe({
      next: (info) => {
        this.sslEnabled.set(info.ssl_enabled ?? checked);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to toggle SSL', err);
        this.sslEnabled.set(!checked);
      }
    });
  }

  private loadPveStatus(): void {
    this.loadingPve.set(true);
    this.configService.getPveStatus().subscribe({
      next: (status) => { this.pveStatus.set(status); this.loadingPve.set(false); },
      error: () => { this.loadingPve.set(false); }
    });
  }

  private loadCertificates(): void {
    this.loadingCerts.set(true);
    this.configService.getCertificateStatus().subscribe({
      next: (res) => { this.certificates.set(res.certificates); this.loadingCerts.set(false); },
      error: () => { this.loadingCerts.set(false); }
    });
  }

  importCa(): void {
    // Create file inputs for key and cert
    const keyInput = document.createElement('input');
    keyInput.type = 'file';
    keyInput.accept = '.key,.pem';

    keyInput.addEventListener('change', () => {
      const keyFile = keyInput.files?.[0];
      if (!keyFile) return;

      const certInput = document.createElement('input');
      certInput.type = 'file';
      certInput.accept = '.crt,.pem';

      certInput.addEventListener('change', () => {
        const certFile = certInput.files?.[0];
        if (!certFile) return;

        const keyReader = new FileReader();
        keyReader.onload = () => {
          const certReader = new FileReader();
          certReader.onload = () => {
            const keyB64 = btoa(keyReader.result as string);
            const certB64 = btoa(certReader.result as string);
            this.loadingCa.set(true);
            this.configService.postCaImport({ key: keyB64, cert: certB64 }).subscribe({
              next: (info) => { this.caInfo.set(info); this.loadingCa.set(false); },
              error: (err) => {
                this.errorHandler.handleError('Failed to import CA', err);
                this.loadingCa.set(false);
              }
            });
          };
          certReader.readAsText(certFile);
        };
        keyReader.readAsText(keyFile);
      });

      // Prompt user to select cert file
      certInput.click();
    });

    keyInput.click();
  }

  generateCa(): void {
    this.loadingCa.set(true);
    this.configService.postCaGenerate().subscribe({
      next: (info) => { this.caInfo.set(info); this.loadingCa.set(false); },
      error: (err) => {
        this.errorHandler.handleError('Failed to generate CA', err);
        this.loadingCa.set(false);
      }
    });
  }

  downloadCaCert(): void {
    // The CA cert is available via getCaInfo, but we need the actual PEM content
    // For now, we'll re-fetch via the status endpoint which includes CA info
    this.configService.getCertificateStatus().subscribe({
      next: (res) => {
        if (res.ca) {
          // Create a simple info text since we don't expose the PEM via the info endpoint
          // The actual download would require a dedicated endpoint - for now show info
          const blob = new Blob([`CA Subject: ${res.ca.subject}\nExpiry: ${res.ca.expiry_date}\n\nTo get the CA certificate file, check the encrypted storagecontext.`], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'ca-info.txt';
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    });
  }

  provisionPve(): void {
    if (!confirm('This will overwrite the PVE host certificate and restart pveproxy. Continue?')) return;

    this.loadingPve.set(true);
    this.configService.postPveProvision().subscribe({
      next: () => {
        this.loadingPve.set(false);
        this.loadPveStatus();
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to provision PVE certificate', err);
        this.loadingPve.set(false);
      }
    });
  }

  isSelected(cert: ICertificateStatus): boolean {
    return this.selectedCerts().some(c => c.hostname === cert.hostname && c.file === cert.file);
  }

  allSelected(): boolean {
    return this.certificates().length > 0 && this.selectedCerts().length === this.certificates().length;
  }

  toggleSelection(cert: ICertificateStatus): void {
    const current = this.selectedCerts();
    if (this.isSelected(cert)) {
      this.selectedCerts.set(current.filter(c => !(c.hostname === cert.hostname && c.file === cert.file)));
    } else {
      this.selectedCerts.set([...current, cert]);
    }
  }

  toggleAllSelection(checked: boolean): void {
    this.selectedCerts.set(checked ? [...this.certificates()] : []);
  }

  renewSelected(): void {
    const hostnames = [...new Set(this.selectedCerts().map(c => c.hostname))];
    this.doRenew(hostnames);
  }

  renewExpiring(): void {
    const hostnames = [...new Set(
      this.certificates()
        .filter(c => c.status === 'warning' || c.status === 'expired')
        .map(c => c.hostname)
    )];
    if (hostnames.length === 0) {
      this.errorHandler.handleError('No expiring certificates found', new Error('Nothing to renew'));
      return;
    }
    this.doRenew(hostnames);
  }

  private doRenew(hostnames: string[]): void {
    this.loadingCerts.set(true);
    this.configService.postCertificateRenew({ hostnames }).subscribe({
      next: () => {
        this.loadingCerts.set(false);
        this.selectedCerts.set([]);
        this.loadCertificates();
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to renew certificates', err);
        this.loadingCerts.set(false);
      }
    });
  }
}
