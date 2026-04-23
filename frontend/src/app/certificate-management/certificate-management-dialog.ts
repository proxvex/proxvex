import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { FormsModule } from '@angular/forms';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { ICertificateStatus, ICaInfoResponse, IGenerateCertResponse, IAutoRenewalStatus, ILogRotationStatus } from '../../shared/types';

@Component({
  selector: 'app-certificate-management-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatTableModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
    MatTabsModule,
    MatCardModule,
    MatSlideToggleModule,
    FormsModule,
  ],
  template: `
    <h2 mat-dialog-title>
      Certificate Management
      @if (spokeStatus()?.active) {
        <span class="spoke-badge" matTooltip="This deployer is a Spoke. Certificates and the CA are managed by the Hub.">
          <mat-icon>hub</mat-icon> Spoke
        </span>
      }
    </h2>
    <mat-dialog-content>
      <mat-tab-group animationDuration="200ms">

        <!-- Tab 1: Certificate Authority -->
        <mat-tab label="Certificate Authority">
          <div class="tab-content">
            <mat-card appearance="outlined">
              <mat-card-header>
                <mat-card-title>CA Status</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                @if (loadingCa()) {
                  <mat-spinner diameter="24"></mat-spinner>
                } @else if (caInfo()?.exists) {
                  @if (spokeStatus()?.active) {
                    <p class="ca-origin-note">
                      <mat-icon class="inline-icon">hub</mat-icon>
                      Synced from Hub:
                      <span class="ca-origin-hub">{{ spokeStatus()?.hubUrl }}</span>
                    </p>
                  }
                  <div class="info-grid">
                    <span class="label">Subject:</span>
                    <span>{{ caInfo()?.subject }}</span>
                    @if (caInfo()?.issued_date) {
                      <span class="label">Issued:</span>
                      <span>{{ caInfo()?.issued_date | date:'mediumDate' }}</span>
                    }
                    <span class="label">Expires:</span>
                    <span>{{ caInfo()?.expiry_date | date:'mediumDate' }}</span>
                    <span class="label">Days remaining:</span>
                    <span>
                      {{ caInfo()?.days_remaining }}
                      @if (caInfo()!.days_remaining! <= 30) {
                        <mat-icon class="status-icon status-warning inline-icon">warning</mat-icon>
                      }
                    </span>
                  </div>
                } @else {
                  <p class="hint-text">No CA configured. Generate or import a CA to get started.</p>
                }
              </mat-card-content>
              <mat-card-actions>
                <button mat-stroked-button (click)="generateCa()"
                  [disabled]="loadingCa() || spokeStatus()?.active"
                  [matTooltip]="spokeStatus()?.active ? 'CA is managed by the Hub in Spoke mode — generate it there.' : ''">
                  <mat-icon>add_circle</mat-icon>
                  Generate CA
                </button>
                <button mat-stroked-button (click)="importCa()"
                  [disabled]="loadingCa() || spokeStatus()?.active"
                  [matTooltip]="spokeStatus()?.active ? 'CA is managed by the Hub in Spoke mode.' : ''">
                  <mat-icon>upload_file</mat-icon>
                  Import CA
                </button>
                @if (caInfo()?.exists) {
                  <button mat-stroked-button (click)="downloadCaCert()" matTooltip="Download CA certificate PEM for client trust">
                    <mat-icon>download</mat-icon>
                    Download CA Cert
                  </button>
                }
              </mat-card-actions>
            </mat-card>

            @if (!spokeStatus()?.active) {
              <mat-card appearance="outlined">
                <mat-card-header>
                  <mat-card-title>Domain Suffix</mat-card-title>
                </mat-card-header>
                <mat-card-content>
                  <mat-form-field class="domain-suffix-field" appearance="outline">
                    <mat-label>Domain Suffix</mat-label>
                    <input matInput [ngModel]="domainSuffix()" (ngModelChange)="domainSuffix.set($event)"
                      (blur)="saveDomainSuffix()" placeholder=".local">
                    <mat-hint>FQDN = hostname + suffix (e.g. myhost{{ domainSuffix() }})</mat-hint>
                  </mat-form-field>
                </mat-card-content>
              </mat-card>
            }
          </div>
        </mat-tab>

        <!-- Tab 2: Server Certificates -->
        <mat-tab label="Server Certificates">
          <div class="tab-content">

            <!-- Generate Certificate -->
            <mat-card appearance="outlined">
              <mat-card-header>
                <mat-card-title>Generate Certificate</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="hint-text">Generate a CA-signed server certificate for any hostname.</p>
                <div class="generate-form">
                  <mat-form-field appearance="outline" class="hostname-field">
                    <mat-label>Hostname</mat-label>
                    <input matInput [ngModel]="generateHostname()" (ngModelChange)="generateHostname.set($event)"
                      placeholder="external-host">
                    <mat-hint>FQDN: {{ generateHostname() || 'hostname' }}{{ domainSuffix() }}</mat-hint>
                  </mat-form-field>
                  <button mat-flat-button color="primary" (click)="generateCert()"
                    [disabled]="!generateHostname() || !caInfo()?.exists || generatingCert()">
                    @if (generatingCert()) {
                      <mat-spinner diameter="18"></mat-spinner>
                    } @else {
                      <ng-container>
                        <mat-icon>verified</mat-icon>
                        Generate & Download
                      </ng-container>
                    }
                  </button>
                </div>
                @if (!caInfo()?.exists) {
                  <p class="hint-text warn">A Certificate Authority must be configured first.</p>
                }
              </mat-card-content>
            </mat-card>

            <!-- PVE Host Certificate -->
            <mat-card appearance="outlined">
              <mat-card-header>
                <mat-card-title>PVE Host Certificate</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                @if (loadingPve()) {
                  <mat-spinner diameter="24"></mat-spinner>
                } @else if (pveStatus()) {
                  <div class="info-grid">
                    <span class="label">Subject:</span>
                    <span>{{ pveStatus()?.subject || 'N/A' }}</span>
                    <span class="label">Expires:</span>
                    <span>{{ pveStatus()?.expiry_date | date:'mediumDate' }}</span>
                    <span class="label">Status:</span>
                    <span>
                      @if (pveStatus()?.status === 'expired') {
                        <mat-icon class="status-icon status-expired inline-icon">error</mat-icon> Expired
                      } @else if (pveStatus()?.status === 'warning') {
                        <mat-icon class="status-icon status-warning inline-icon">warning</mat-icon> Expiring
                      } @else {
                        OK
                      }
                    </span>
                  </div>
                } @else {
                  <p class="hint-text">No PVE certificate status available.</p>
                }
              </mat-card-content>
              <mat-card-actions>
                <button mat-stroked-button color="warn" (click)="provisionPve()"
                  [disabled]="!caInfo()?.exists || loadingPve()"
                  matTooltip="Generates server cert for PVE host and restarts pveproxy">
                  <mat-icon>security</mat-icon>
                  Provision PVE Certificate
                </button>
              </mat-card-actions>
            </mat-card>

            <!-- Auto-Renewal -->
            <mat-card appearance="outlined">
              <mat-card-content>
                <div class="auto-renewal-row">
                  <mat-slide-toggle [checked]="autoRenewalEnabled()" (change)="toggleAutoRenewal($event.checked)">
                    Auto-renew expiring certificates
                  </mat-slide-toggle>
                  <span class="auto-renewal-info">
                    @if (autoRenewalStatus()?.last_check) {
                      <span class="hint-text">Last check: {{ autoRenewalStatus()?.last_check | date:'medium' }}</span>
                    }
                    @if (autoRenewalStatus()?.last_renewed_date) {
                      <span class="hint-text">Last renewal: {{ autoRenewalStatus()?.last_renewed_date | date:'medium' }}</span>
                    }
                    @if (autoRenewalStatus()?.last_error) {
                      <span class="hint-text warn">{{ autoRenewalStatus()?.last_error }}</span>
                    }
                  </span>
                </div>
              </mat-card-content>
            </mat-card>

            <!-- Deployed Certificates -->
            <mat-card appearance="outlined">
              <mat-card-header>
                <mat-card-title>Deployed Certificates</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                @if (loadingCerts()) {
                  <mat-spinner diameter="24"></mat-spinner>
                } @else if (certificates().length === 0) {
                  <p class="hint-text">No certificates found.</p>
                } @else {
                  @for (group of certificatesByHostIssuer(); track group.host + '|' + group.issuer) {
                    <div class="host-group">
                      <h4 class="host-header">
                        <mat-icon class="host-icon">dns</mat-icon>
                        <span>{{ group.host }}</span>
                        <span class="host-sep">·</span>
                        <span [matTooltip]="group.issuer">Signed by {{ group.issuerCn }}</span>
                        <span class="host-count">({{ group.certs.length }})</span>
                      </h4>
                      @if (group.caIssuedDate || group.caExpiryDate) {
                        <div class="host-subheader">
                          @if (group.caIssuedDate) {
                            <span>CA issued {{ group.caIssuedDate | date:'mediumDate' }}</span>
                          }
                          @if (group.caIssuedDate && group.caExpiryDate) {
                            <span class="host-sep">·</span>
                          }
                          @if (group.caExpiryDate) {
                            <span>expires {{ group.caExpiryDate | date:'mediumDate' }}</span>
                          }
                        </div>
                      }
                      <table mat-table [dataSource]="group.certs" class="cert-table">
                        <ng-container matColumnDef="subject">
                          <th mat-header-cell *matHeaderCellDef>Subject</th>
                          <td mat-cell *matCellDef="let cert">{{ cert.subject }}</td>
                        </ng-container>

                        <ng-container matColumnDef="expiry">
                          <th mat-header-cell *matHeaderCellDef>Expires</th>
                          <td mat-cell *matCellDef="let cert">{{ cert.expiry_date | date:'mediumDate' }}</td>
                        </ng-container>

                        <ng-container matColumnDef="status">
                          <th mat-header-cell *matHeaderCellDef></th>
                          <td mat-cell *matCellDef="let cert">
                            @if (cert.status === 'expired') {
                              <mat-icon class="status-icon status-expired" matTooltip="Expired">error</mat-icon>
                            } @else if (cert.status === 'warning') {
                              <mat-icon class="status-icon status-warning" matTooltip="Expires within 30 days">warning</mat-icon>
                            }
                          </td>
                        </ng-container>

                        <ng-container matColumnDef="actions">
                          <th mat-header-cell *matHeaderCellDef></th>
                          <td mat-cell *matCellDef="let cert">
                            @if (canRenewCert(cert)) {
                              <button mat-icon-button color="warn"
                                [disabled]="isRenewing(cert) || renewingAll()"
                                (click)="renewOne(cert)"
                                [matTooltip]="'Re-issue this certificate with current CA'">
                                @if (isRenewing(cert)) {
                                  <mat-spinner diameter="16"></mat-spinner>
                                } @else {
                                  <mat-icon>autorenew</mat-icon>
                                }
                              </button>
                            }
                          </td>
                        </ng-container>

                        <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
                        <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
                      </table>
                    </div>
                  }
                }
              </mat-card-content>
              <mat-card-actions class="renew-actions">
                <div class="renew-hint">
                  Re-issues every certificate in the list above that was signed by your <strong>current</strong> CA
                  (<em>{{ caInfo()?.subject ? shortIssuer(caInfo()!.subject) : '—' }}</em>).
                  New validity period, same subjects. Certificates from other CAs stay untouched.
                </div>
                <button mat-stroked-button color="warn" (click)="renewAll()"
                  [disabled]="renewingAll() || certificates().length === 0 || !caInfo()?.exists"
                  matTooltip="Re-sign all server certificates using the current CA. Useful after the CA was regenerated or on a fresh deployer install.">
                  @if (renewingAll()) {
                    <mat-spinner diameter="18"></mat-spinner>
                  } @else {
                    <ng-container><mat-icon>autorenew</mat-icon> Renew certificates with current CA</ng-container>
                  }
                </button>
              </mat-card-actions>
            </mat-card>

          </div>
        </mat-tab>

        <!-- Tab 3: Maintenance -->
        <mat-tab label="Maintenance">
          <div class="tab-content">
            <mat-card appearance="outlined">
              <mat-card-header>
                <mat-card-title>Log Rotation</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="hint-text">Automatically rotate and clean up LXC console logs in /var/log/lxc/ on all PVE hosts. Rotated logs are deleted after 7 days.</p>
                @if (spokeStatus()?.active) {
                  <p class="hint-text warn">Log rotation runs on the Hub — this Spoke doesn't manage PVE host logs.</p>
                }
                <div class="auto-renewal-row">
                  <mat-slide-toggle
                    [checked]="logRotationEnabled()"
                    [disabled]="spokeStatus()?.active"
                    (change)="toggleLogRotation($event.checked)"
                    [matTooltip]="spokeStatus()?.active ? 'Log rotation is managed on the Hub in Spoke mode.' : ''">
                    Enable daily log rotation
                  </mat-slide-toggle>
                  <span class="auto-renewal-info">
                    @if (logRotationStatus()?.last_check) {
                      <span class="hint-text">Last check: {{ logRotationStatus()?.last_check | date:'medium' }}</span>
                    }
                    @if (logRotationStatus()?.last_rotated_count !== undefined && logRotationStatus()?.last_rotated_count! > 0) {
                      <span class="hint-text">Rotated: {{ logRotationStatus()?.last_rotated_count }}</span>
                    }
                    @if (logRotationStatus()?.last_deleted_count !== undefined && logRotationStatus()?.last_deleted_count! > 0) {
                      <span class="hint-text">Deleted: {{ logRotationStatus()?.last_deleted_count }}</span>
                    }
                    @if (logRotationStatus()?.last_error) {
                      <span class="hint-text warn">{{ logRotationStatus()?.last_error }}</span>
                    }
                  </span>
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-stroked-button (click)="triggerLogRotation()"
                  [disabled]="runningLogRotation() || spokeStatus()?.active"
                  [matTooltip]="spokeStatus()?.active ? 'Log rotation is managed on the Hub in Spoke mode.' : ''">
                  @if (runningLogRotation()) {
                    <mat-spinner diameter="18"></mat-spinner>
                  } @else {
                    <ng-container><mat-icon>rotate_right</mat-icon> Run Now</ng-container>
                  }
                </button>
              </mat-card-actions>
            </mat-card>
          </div>
        </mat-tab>
      </mat-tab-group>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 650px;
      max-height: 70vh;
      overflow-y: auto;
    }

    .tab-content {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding-top: 1rem;
    }

    mat-card {
      mat-card-actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        padding: 0 16px 16px;
      }
    }

    .info-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.25rem 1rem;
      font-size: 0.9rem;

      .label {
        font-weight: 500;
        color: #555;
      }
    }

    .domain-suffix-field, .hostname-field {
      width: 300px;
    }

    .generate-form {
      display: flex;
      align-items: flex-start;
      gap: 1rem;

      button {
        margin-top: 4px;
      }
    }

    .hint-text {
      color: #999;
      font-size: 0.875rem;
      margin: 0.25rem 0;

      &.warn {
        color: #e65100;
      }
    }

    .status-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;

      &.status-warning {
        color: #e65100;
      }
      &.status-expired {
        color: #c62828;
      }
      &.inline-icon {
        vertical-align: middle;
        margin-right: 2px;
      }
    }

    .cert-table {
      width: 100%;
      margin-bottom: 0.75rem;
    }

    .host-group {
      margin-bottom: 1rem;
    }

    .host-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0.75rem 0 0.25rem;
      font-size: 0.95rem;
      font-weight: 500;
      color: #444;
    }

    .host-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: #888;
    }

    .host-count {
      color: #888;
      font-weight: 400;
      font-size: 0.85rem;
    }

    .host-sep {
      color: #bbb;
    }

    .host-subheader {
      display: flex;
      gap: 0.5rem;
      margin: 0 0 0.5rem 1.75rem;
      font-size: 0.8rem;
      color: #666;
    }

    .renew-actions {
      flex-direction: column;
      align-items: flex-start !important;
      gap: 0.5rem;
    }

    .renew-hint {
      font-size: 0.85rem;
      color: #555;
      max-width: 60ch;
    }

    .renew-hint em {
      font-style: normal;
      font-weight: 500;
    }

    .ca-origin-note {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin: 0 0 0.5rem 0;
      padding: 0.4rem 0.6rem;
      background: #e3f2fd;
      border-left: 3px solid #1976d2;
      color: #0d47a1;
      font-size: 0.85rem;
    }

    .ca-origin-hub {
      font-family: monospace;
      font-weight: 500;
    }

    .spoke-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      margin-left: 0.75rem;
      padding: 0.1rem 0.5rem;
      background: #e3f2fd;
      border: 1px solid #90caf9;
      border-radius: 10px;
      color: #1565c0;
      font-size: 0.75rem;
      font-weight: 500;
      vertical-align: middle;
    }

    .spoke-badge mat-icon {
      font-size: 14px;
      width: 14px;
      height: 14px;
    }

    .auto-renewal-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .auto-renewal-info {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .renewal-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-top: 0.5rem;
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

  caInfo = signal<ICaInfoResponse | null>(null);
  domainSuffix = signal('.local');
  pveStatus = signal<ICertificateStatus | null>(null);
  certificates = signal<ICertificateStatus[]>([]);

  autoRenewalStatus = signal<IAutoRenewalStatus | null>(null);
  autoRenewalEnabled = signal(false);

  logRotationStatus = signal<ILogRotationStatus | null>(null);
  logRotationEnabled = signal(false);
  runningLogRotation = signal(false);

  generateHostname = signal('');
  generatingCert = signal(false);

  loadingCa = signal(false);
  loadingPve = signal(false);
  loadingCerts = signal(false);
  renewingAll = signal(false);
  spokeStatus = signal<{ active: boolean; hubUrl?: string; synced?: boolean } | null>(null);

  displayedColumns = ['subject', 'expiry', 'status', 'actions'];
  /** Hostnames currently being renewed (per-row spinner state). */
  renewingHostnames = signal<Set<string>>(new Set());

  /** Group certificates by (host, issuer) so the group header can show CA info. */
  certificatesByHostIssuer = computed(() => {
    const ca = this.caInfo();
    const activeCaCn = ca?.subject ? this.shortIssuer(ca.subject) : undefined;

    const groups = new Map<string, { host: string; issuer: string; certs: ICertificateStatus[] }>();
    for (const c of this.certificates()) {
      const host = c.host || '(unknown)';
      const issuer = c.issuer || '(unknown)';
      const key = `${host}|||${issuer}`;
      if (!groups.has(key)) groups.set(key, { host, issuer, certs: [] });
      groups.get(key)!.certs.push(c);
    }

    return Array.from(groups.values())
      .sort((a, b) => a.host.localeCompare(b.host) || a.issuer.localeCompare(b.issuer))
      .map((g) => {
        const issuerCn = this.shortIssuer(g.issuer);
        const isActiveCa = !!activeCaCn && issuerCn === activeCaCn;
        return {
          ...g,
          issuerCn,
          // Only attach CA dates when issuer matches the active deployer CA;
          // older/foreign CAs have the same CN but different expiry we don't know.
          caIssuedDate: isActiveCa ? ca?.issued_date : undefined,
          caExpiryDate: isActiveCa ? ca?.expiry_date : undefined,
        };
      });
  });

  /** Extract the CN of an X.509 issuer DN for compact display. */
  shortIssuer(issuer: string | undefined): string {
    if (!issuer) return '—';
    const match = /CN\s*=\s*([^,/]+)/i.exec(issuer);
    return match ? match[1].trim() : issuer;
  }

  ngOnInit(): void {
    this.loadCaInfo();
    this.loadPveStatus();
    this.loadCertificates();
    this.loadAutoRenewalStatus();
    this.loadLogRotationStatus();
    this.loadSpokeStatus();
  }

  private loadSpokeStatus(): void {
    this.configService.getSpokeSyncStatus().subscribe({
      next: (s) => this.spokeStatus.set(s),
      error: () => this.spokeStatus.set(null),
    });
  }

  private loadCaInfo(): void {
    this.loadingCa.set(true);
    this.configService.getCaInfo().subscribe({
      next: (info) => {
        this.caInfo.set(info);
        if (info.domain_suffix) {
          this.domainSuffix.set(info.domain_suffix);
        }
        this.loadingCa.set(false);
      },
      error: () => { this.loadingCa.set(false); }
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
    this.configService.getAllCertificates().subscribe({
      next: (res) => {
        const serverCerts = res.certificates.filter(c =>
          c.certtype === 'server' || (c.certtype === 'ca' && c.status !== 'ok')
        );
        const statusOrder: Record<string, number> = { expired: 0, warning: 1, ok: 2 };
        const sorted = serverCerts.sort((a, b) =>
          (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)
        );
        this.certificates.set(sorted);
        this.loadingCerts.set(false);
      },
      error: () => { this.loadingCerts.set(false); }
    });
  }

  private loadAutoRenewalStatus(): void {
    this.configService.getAutoRenewalStatus().subscribe({
      next: (status) => {
        this.autoRenewalStatus.set(status);
        this.autoRenewalEnabled.set(status.enabled);
      },
      error: () => { /* ignore if not available */ }
    });
  }

  toggleAutoRenewal(enabled: boolean): void {
    this.configService.setAutoRenewalEnabled(enabled).subscribe({
      next: (status) => {
        this.autoRenewalStatus.set(status);
        this.autoRenewalEnabled.set(status.enabled);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to toggle auto-renewal', err);
        this.autoRenewalEnabled.set(!enabled);
      }
    });
  }

  private loadLogRotationStatus(): void {
    this.configService.getLogRotationStatus().subscribe({
      next: (status) => {
        this.logRotationStatus.set(status);
        this.logRotationEnabled.set(status.enabled);
      },
      error: () => { /* ignore if not available */ }
    });
  }

  toggleLogRotation(enabled: boolean): void {
    this.configService.setLogRotationEnabled(enabled).subscribe({
      next: (status) => {
        this.logRotationStatus.set(status);
        this.logRotationEnabled.set(status.enabled);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to toggle log rotation', err);
        this.logRotationEnabled.set(!enabled);
      }
    });
  }

  triggerLogRotation(): void {
    this.runningLogRotation.set(true);
    this.configService.triggerLogRotationCheck().subscribe({
      next: (status) => {
        this.logRotationStatus.set(status);
        this.runningLogRotation.set(false);
      },
      error: (err) => {
        this.errorHandler.handleError('Log rotation failed', err);
        this.runningLogRotation.set(false);
      }
    });
  }

  importCa(): void {
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

      certInput.click();
    });

    keyInput.click();
  }

  saveDomainSuffix(): void {
    const suffix = this.domainSuffix();
    if (!suffix) return;
    this.configService.postDomainSuffix(suffix).subscribe({
      error: (err) => this.errorHandler.handleError('Failed to save domain suffix', err)
    });
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
    this.configService.downloadCaCert().subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ca.pem';
        a.click();
        URL.revokeObjectURL(url);
      },
      error: (err) => this.errorHandler.handleError('Failed to download CA certificate', err)
    });
  }

  generateCert(): void {
    const hostname = this.generateHostname().trim();
    if (!hostname) return;

    this.generatingCert.set(true);
    this.configService.postGenerateCert(hostname).subscribe({
      next: (res) => {
        this.downloadGeneratedCert(res);
        this.generatingCert.set(false);
        this.generateHostname.set('');
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to generate certificate', err);
        this.generatingCert.set(false);
      }
    });
  }

  private downloadGeneratedCert(res: IGenerateCertResponse): void {
    const files: { name: string; content: string }[] = [
      { name: 'fullchain.pem', content: atob(res.fullchain) },
      { name: 'privkey.pem', content: atob(res.key) },
    ];

    for (const file of files) {
      const blob = new Blob([file.content], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${res.fqdn}-${file.name}`;
      a.click();
      URL.revokeObjectURL(url);
    }
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

  renewAll(): void {
    if (!confirm('Force-renew every self-signed server certificate. Existing leaf certs will be re-signed with the current CA, regardless of remaining validity. Continue?')) return;

    this.renewingAll.set(true);
    this.configService.renewAllCertificates().subscribe({
      next: (status) => {
        this.renewingAll.set(false);
        this.autoRenewalStatus.set(status);
        this.loadCertificates();
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to renew certificates', err);
        this.renewingAll.set(false);
      }
    });
  }

  /** A cert is renewable if its issuer matches the current CA (only then we
   *  have the key to re-sign it). */
  canRenewCert(cert: ICertificateStatus): boolean {
    const ca = this.caInfo();
    if (!ca?.exists || !ca.subject) return false;
    const activeCn = this.shortIssuer(ca.subject);
    return !!cert?.issuer && this.shortIssuer(cert.issuer) === activeCn;
  }

  isRenewing(cert: ICertificateStatus): boolean {
    const hn = (cert as { hostname?: string }).hostname;
    return !!hn && this.renewingHostnames().has(hn);
  }

  renewOne(cert: ICertificateStatus): void {
    const hn = (cert as { hostname?: string }).hostname;
    if (!hn) return;
    if (!confirm(`Re-issue the certificate for "${hn}" using the current CA? The leaf cert will be replaced with the same subject but a fresh validity period.`)) return;

    const next = new Set(this.renewingHostnames());
    next.add(hn);
    this.renewingHostnames.set(next);

    this.configService.renewAllCertificates([hn]).subscribe({
      next: (status) => {
        const done = new Set(this.renewingHostnames());
        done.delete(hn);
        this.renewingHostnames.set(done);
        this.autoRenewalStatus.set(status);
        this.loadCertificates();
      },
      error: (err) => {
        this.errorHandler.handleError(`Failed to renew certificate for ${hn}`, err);
        const done = new Set(this.renewingHostnames());
        done.delete(hn);
        this.renewingHostnames.set(done);
      }
    });
  }
}
