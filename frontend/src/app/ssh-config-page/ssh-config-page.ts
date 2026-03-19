import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { VeConfigurationService } from '../ve-configuration.service';
import { ISsh } from '../../shared/types';


type SshWithDiagnostics = ISsh & { stderr?: string };
@Component({
  selector: 'app-ssh-config-page',
  standalone: true,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatRadioModule,
    MatIconModule,
  ],
  templateUrl: './ssh-config-page.html',
  styleUrl: './ssh-config-page.scss'
})
export class SshConfigPage implements OnInit {
  ssh: SshWithDiagnostics[] = [];
  loading = false;
  error = '';
  configService = inject(VeConfigurationService);
  newHost = '';
  newPort = 22;
  publicKeyCommand?: string;
  installSshServer?: string;

  ngOnInit() {
    this.loading = true;
    this.configService.getSshConfigs().subscribe({
      next: (res) => {
        this.ssh = (res.sshs && res.sshs.length > 0 ? res.sshs : []) as SshWithDiagnostics[];
        // publicKeyCommand: prefer from SSH configs, fallback to top-level response
        const currentSsh = this.ssh.find(s => s.current) ?? this.ssh[0];
        this.publicKeyCommand = currentSsh?.publicKeyCommand || res.publicKeyCommand;
        // installSshServer comes from the current SSH config (if port is not listening)
        this.installSshServer = currentSsh?.installSshServer;
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading SSH configuration.';
        this.loading = false;
      }
    });
  }

  setCurrent(index: number) {
    this.ssh.forEach((s, i) => s.current = i === index);
    const sel = this.ssh[index];
    if (sel?.host) {
      // Persist current selection immediately
      this.configService.setSshConfig({ host: sel.host, port: sel.port, current: true }).subscribe({
        next: () => { /* persisted current */ },
        error: () => { /* ignore persist error; UI remains */ }
      });
      // Refresh permission status and reload configs to get updated installSshServer
      this.configService.checkSsh(sel.host, sel.port).subscribe({
        next: (r) => { 
          sel.permissionOk = !!r?.permissionOk; 
          sel.stderr = r?.stderr;
          // Reload configs to get updated installSshServer based on port listening status
          this.configService.getSshConfigs().subscribe({
            next: (res) => {
              this.ssh = (res.sshs || []) as SshWithDiagnostics[];
              // publicKeyCommand: prefer from SSH configs, fallback to top-level response
              const currentSsh = this.ssh.find(s => s.current) ?? this.ssh[0];
              this.publicKeyCommand = currentSsh?.publicKeyCommand || res.publicKeyCommand;
              this.installSshServer = currentSsh?.installSshServer;
            }
          });
        },
        error: () => { sel.permissionOk = false; }
      });
    }
  }

  addSsh() {
    // Persist a new SSH config from input fields
    const host = String(this.newHost || '').trim();
    const port = Number(this.newPort || 22);
    if (!host || Number.isNaN(port)) {
      this.error = 'Please enter a valid host and port.';
      return;
    }
    // Prevent duplicate host names
    if (this.ssh.some((s) => s.host === host)) {
      this.error = 'Host already exists. Please choose a different host name.';
      return;
    }
    // Always mark new host as current
    const makeCurrent = true;
    this.configService.setSshConfig({ host, port, current: makeCurrent }).subscribe({
      next: () => {
        this.newHost = '';
        this.newPort = 22;
        // Reload list to reflect new entry
        this.loading = true;
        this.configService.getSshConfigs().subscribe({
          next: (res) => { 
            this.ssh = (res.sshs || []) as SshWithDiagnostics[]; 
            // publicKeyCommand: prefer from SSH configs, fallback to top-level response
            const currentSsh = this.ssh.find(s => s.current) ?? this.ssh[0];
            this.publicKeyCommand = currentSsh?.publicKeyCommand || res.publicKeyCommand;
            // installSshServer comes from the current SSH config (if port is not listening)
            this.installSshServer = currentSsh?.installSshServer;
            this.loading = false; 
          },
          error: () => { this.error = 'Error loading SSH configuration.'; this.loading = false; }
        });
      },
      error: () => {
        this.error = 'Error saving SSH configuration.';
      }
    });
  }

  removeSsh(index: number) {
    const removed = this.ssh[index];
    const wasCurrent = removed.current;
    if (removed?.host) {
      this.configService.deleteSshConfig(removed.host).subscribe({
        next: () => { /* deleted */ },
        error: () => { /* ignore */ }
      });
    }
    this.ssh.splice(index, 1);
    if (wasCurrent && this.ssh.length > 0) {
      this.ssh[0].current = true;
      const first = this.ssh[0];
      if (first?.host) {
        this.configService.setSshConfig({ host: first.host, port: first.port, current: true }).subscribe({
          next: () => { /* persisted reassignment */ },
          error: () => { /* ignore */ }
        });
      }
    }
  }


  get permissionOk(): boolean {
    const cur = this.ssh.find(s => s.current) ?? this.ssh[0];
    return !!cur?.permissionOk;
  }

  get hostUnreachable(): boolean {
    const cur = this.ssh.find(s => s.current) ?? this.ssh[0];
    if (!cur || cur.permissionOk) return false;
    const stderr = (cur.stderr || '').toLowerCase();
    return stderr.includes('connection refused') ||
      stderr.includes('no route to host') ||
      stderr.includes('operation timed out') ||
      stderr.includes('timed out') ||
      stderr.includes('network is unreachable');
  }

  refreshPermission(index: number) {
    const sel = this.ssh[index];
    if (sel?.host) {
      this.configService.checkSsh(sel.host, sel.port).subscribe({
        next: (r) => { sel.permissionOk = !!r?.permissionOk; sel.stderr = r?.stderr; },
        error: () => { sel.permissionOk = false; }
      });
    }
  }

  refreshCurrentPermission() {
    const currentSsh = this.ssh.find(s => s.current) ?? this.ssh[0];
    if (currentSsh?.host) {
      this.loading = true;
      this.configService.checkSsh(currentSsh.host, currentSsh.port).subscribe({
        next: (r) => {
          currentSsh.permissionOk = !!r?.permissionOk;
          currentSsh.stderr = r?.stderr;
          // Reload configs to get updated installSshServer based on port listening status
          this.configService.getSshConfigs().subscribe({
            next: (res) => {
              this.ssh = (res.sshs || []) as SshWithDiagnostics[];
              // publicKeyCommand: prefer from SSH configs, fallback to top-level response
              const updatedCurrentSsh = this.ssh.find(s => s.current) ?? this.ssh[0];
              this.publicKeyCommand = updatedCurrentSsh?.publicKeyCommand || res.publicKeyCommand;
              this.installSshServer = updatedCurrentSsh?.installSshServer;
              this.loading = false;
            },
            error: () => {
              this.loading = false;
            }
          });
        },
        error: () => {
          currentSsh.permissionOk = false;
          this.loading = false;
        }
      });
    }
  }

  copy(text: string | undefined) {
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => { /* ignore clipboard errors */ });
  }
}
