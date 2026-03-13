import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet, RouterLink, Router, NavigationEnd } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from './ve-configuration.service';
import { AuthService } from './auth/auth.service';
import { take, filter } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { CacheService } from './shared/services/cache.service';
import { ISsh } from '../shared/types';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, MatTooltipModule, MatSelectModule, MatFormFieldModule, MatIconModule, FormsModule, CommonModule, MatButtonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  private cfg = inject(VeConfigurationService);
  private router = inject(Router);
  private cacheService = inject(CacheService);
  auth = inject(AuthService);
  private routerSub?: Subscription;
  private previousUrl = '';

  sshConfigs: ISsh[] = [];
  currentHost = '';

  ngOnInit(): void {
    // Preload cache in background for faster UI loading
    this.cacheService.preloadAll();

    // Reload SSH configs when navigating away from /ssh-config
    this.routerSub = this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd)
    ).subscribe(e => {
      if (this.previousUrl.startsWith('/ssh-config') && !e.urlAfterRedirects.startsWith('/ssh-config')) {
        this.loadSshConfigs();
      }
      this.previousUrl = e.urlAfterRedirects;
    });

    // Single call to fetch SSH configs (sets VE context key via service tap)
    this.cfg.getSshConfigs().pipe(take(1)).subscribe({
      next: (res) => {
        const sshs = res.sshs || [];
        this.sshConfigs = sshs;
        this.updateCurrentHost();
        // Navigate to ssh-config when none or no current selection exists
        if (sshs.length === 0 || !sshs.some(ssh => ssh.current === true)) {
          const currentUrl = this.router.url;
          if (!currentUrl.startsWith('/ssh-config')) {
            this.router.navigate(['/ssh-config']);
          }
        }
      },
      error: (err) => {
        console.warn('Failed to load SSH configs', err);
        const currentUrl = this.router.url;
        if (!currentUrl.startsWith('/ssh-config')) {
          this.router.navigate(['/ssh-config']);
        }
      }
    });

    }
  
  loadSshConfigs(): void {
    this.cfg.getSshConfigs().subscribe({
      next: (res) => {
        this.sshConfigs = res.sshs || [];
        this.updateCurrentHost();
      },
      error: () => {
        this.sshConfigs = [];
        this.currentHost = '';
      }
    });
  }
  
  updateCurrentHost(): void {
    const current = this.sshConfigs.find(ssh => ssh.current === true);
    if (current) {
      this.currentHost = current.host;
    } else if (this.sshConfigs.length > 0) {
      this.currentHost = this.sshConfigs[0].host;
    } else {
      this.currentHost = '';
    }
  }
  
  onHostChange(host: string): void {
    const selected = this.sshConfigs.find(ssh => ssh.host === host);
    if (selected) {
      // Non-blocking quick check of the target SSH host
      this.cfg.checkSsh(selected.host, selected.port).pipe(take(1)).subscribe({
        next: (res) => {
          if (!res.permissionOk) {
            console.warn('SSH host not reachable or permission denied', res);
          }
        },
        error: (err) => {
          console.warn('SSH check failed', err);
        }
      });
      this.cfg.setSshConfig({ host: selected.host, port: selected.port, current: true }).subscribe({
        next: () => {
          this.currentHost = host;
          // Reload SSH configs to update current status (single call)
          this.cfg.getSshConfigs().pipe(take(1)).subscribe({
            next: (res) => {
              this.sshConfigs = res.sshs || [];
              this.updateCurrentHost();
            },
            error: () => {
              this.sshConfigs = [];
              this.currentHost = '';
            }
          });
        },
        error: (err) => {
          console.error('Failed to set current host', err);
          // Revert selection on error
          this.updateCurrentHost();
        }
      });
    }
  }
  
  ngOnDestroy(): void {
    this.routerSub?.unsubscribe();
  }

  getHostDisplay(ssh: ISsh): string {
    if (ssh.port && ssh.port !== 22) {
      return `${ssh.host}:${ssh.port}`;
    }
    return ssh.host;
  }
}
