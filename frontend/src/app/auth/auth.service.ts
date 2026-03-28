import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { ApiUri } from '../../shared/types';

export interface AuthConfig {
  oidcEnabled: boolean;
  authenticated: boolean;
  user?: { name?: string; email?: string };
  roles?: Record<string, Record<string, unknown>>;
  issuerUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  private authConfig$ = new BehaviorSubject<AuthConfig>({
    oidcEnabled: false,
    authenticated: false,
  });

  get config(): AuthConfig {
    return this.authConfig$.value;
  }

  get isOidcEnabled(): boolean {
    return this.authConfig$.value.oidcEnabled;
  }

  get isAuthenticated(): boolean {
    return this.authConfig$.value.authenticated;
  }

  get user(): AuthConfig['user'] {
    return this.authConfig$.value.user;
  }

  get config$(): Observable<AuthConfig> {
    return this.authConfig$.asObservable();
  }

  /** User has ORG_OWNER role (full ZITADEL config access, any project) */
  get isOrgOwner(): boolean {
    return !!this.authConfig$.value.roles?.['ORG_OWNER'];
  }

  /** User has PROJECT_OWNER on at least one project */
  get isProjectOwner(): boolean {
    const roles = this.authConfig$.value.roles;
    if (!roles) return false;
    return Object.keys(roles).some(k => k.startsWith('PROJECT_OWNER'));
  }

  /** User can configure OIDC (has ORG_OWNER or PROJECT_OWNER) */
  get canConfigureOidc(): boolean {
    return this.isOrgOwner || this.isProjectOwner;
  }

  /** Project IDs the user has PROJECT_OWNER access to */
  get allowedProjectIds(): string[] {
    const roles = this.authConfig$.value.roles;
    if (!roles) return [];
    if (this.isOrgOwner) return []; // empty means all projects allowed
    return Object.keys(roles)
      .filter(k => k.startsWith('PROJECT_OWNER:'))
      .map(k => k.split(':')[1]);
  }

  /** ZITADEL issuer URL (for direct Management API calls from frontend) */
  get issuerUrl(): string | undefined {
    return this.authConfig$.value.issuerUrl;
  }

  async loadAuthConfig(): Promise<void> {
    try {
      const config = await firstValueFrom(
        this.http.get<AuthConfig>(ApiUri.AuthConfig, { withCredentials: true })
      );
      this.authConfig$.next(config);
    } catch {
      // If auth endpoint not available, OIDC is not enabled
      this.authConfig$.next({ oidcEnabled: false, authenticated: false });
    }
  }

  login(): void {
    window.location.href = ApiUri.AuthLogin;
  }

  async logout(): Promise<void> {
    try {
      const result = await firstValueFrom(
        this.http.post<{ redirectUrl: string }>(ApiUri.AuthLogout, {}, { withCredentials: true })
      );
      if (result.redirectUrl) {
        window.location.href = result.redirectUrl;
      } else {
        window.location.href = '/';
      }
    } catch {
      window.location.href = '/';
    }
  }
}
