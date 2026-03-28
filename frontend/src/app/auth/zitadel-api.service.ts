import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { ApiUri } from '../../shared/types';

/**
 * Direct ZITADEL Management API client.
 *
 * Makes calls to the ZITADEL Management API using the user's access token
 * (not proxied through the backend). ZITADEL enforces permissions server-side.
 *
 * Note: Button-disabling in the UI is purely UX — ZITADEL is the authority.
 */

export interface ZitadelProject {
  id: string;
  name: string;
}

export interface ZitadelApp {
  id: string;
  name: string;
  clientId?: string;
}

@Injectable({ providedIn: 'root' })
export class ZitadelApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private cachedToken: string | null = null;

  private async getToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    const resp = await firstValueFrom(
      this.http.get<{ accessToken: string }>(ApiUri.AuthToken, { withCredentials: true })
    );
    this.cachedToken = resp.accessToken;
    return this.cachedToken;
  }

  private async apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    const issuerUrl = this.auth.issuerUrl;
    if (!issuerUrl) throw new Error('ZITADEL issuer URL not available');

    const token = await this.getToken();
    const url = `${issuerUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    try {
      if (method === 'GET') {
        return await firstValueFrom(this.http.get<T>(url, { headers }));
      }
      return await firstValueFrom(this.http.request<T>(method, url, { headers, body }));
    } catch (err: unknown) {
      // Token expired — clear cache and redirect to login
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        this.cachedToken = null;
        this.auth.login();
      }
      throw err;
    }
  }

  /** Search for projects the user has access to */
  async searchProjects(): Promise<ZitadelProject[]> {
    const resp = await this.apiCall<{ result?: Array<{ id: string; name: string }> }>(
      'POST', '/management/v1/projects/_search', {}
    );
    return (resp.result ?? []).map(p => ({ id: p.id, name: p.name }));
  }

  /** Search for OIDC apps in a project */
  async searchApps(projectId: string): Promise<ZitadelApp[]> {
    const resp = await this.apiCall<{ result?: Array<{ id: string; name: string; oidcConfig?: { clientId: string } }> }>(
      'POST', `/management/v1/projects/${projectId}/apps/_search`, {}
    );
    return (resp.result ?? []).map(a => ({
      id: a.id,
      name: a.name,
      clientId: a.oidcConfig?.clientId,
    }));
  }

  /** Create an OIDC app in a project */
  async createOidcApp(projectId: string, name: string, redirectUris: string[], postLogoutRedirectUris: string[]): Promise<{ appId: string; clientId: string; clientSecret: string }> {
    return this.apiCall('POST', `/management/v1/projects/${projectId}/apps/oidc`, {
      name,
      redirectUris,
      responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
      grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
      appType: 'OIDC_APP_TYPE_WEB',
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
      postLogoutRedirectUris,
    });
  }

  /** Generate a new client secret for an existing OIDC app */
  async generateClientSecret(projectId: string, appId: string): Promise<{ clientSecret: string }> {
    return this.apiCall('POST', `/management/v1/projects/${projectId}/apps/${appId}/oidc_config/_generate_client_secret`, {});
  }

  /** Check if the ZITADEL API is available and the user has access */
  get isAvailable(): boolean {
    return !!this.auth.issuerUrl && this.auth.isAuthenticated;
  }
}
