import type {
  ISshConfigsResponse,
  IApplicationsResponse,
  IUnresolvedParametersResponse,
  IEnumValuesResponse,
  IPostEnumValuesBody,
  ICompatibleAddonsResponse,
  IStacktypesResponse,
  IStacksResponse,
  IPostVeConfigurationBody,
  IPostVeConfigurationResponse,
  IVeExecuteMessagesResponse,
} from "@shared/types.mjs";
import type { ValidationResult } from "@shared/parameter-validator.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ConnectionError,
  AuthenticationError,
  NotFoundError,
  ApiError,
} from "./cli-types.mjs";

export interface OidcCredentials {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

export class CliApiClient {
  private baseUrl: string;
  private token?: string;
  private oidcCredentials?: OidcCredentials;
  private fixtureDir?: string;
  private fixtureIndex = 0;

  constructor(baseUrl: string, token?: string, insecure?: boolean, fixturePath?: string, oidcCredentials?: OidcCredentials) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (token) this.token = token;
    if (oidcCredentials) this.oidcCredentials = oidcCredentials;
    if (insecure) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    if (fixturePath) {
      this.fixtureDir = fixturePath;
      mkdirSync(fixturePath, { recursive: true });
    }
  }

  /**
   * Fetch a JWT via OIDC Client Credentials Grant.
   * Called once before the first API request if oidcCredentials are set.
   */
  async authenticateOidc(): Promise<void> {
    if (!this.oidcCredentials) return;
    if (this.token) return; // Already have a token

    const tokenUrl = `${this.oidcCredentials.issuerUrl}/oauth/v2/token`;
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "openid",
    });

    const credentials = Buffer.from(
      `${this.oidcCredentials.clientId}:${this.oidcCredentials.clientSecret}`,
    ).toString("base64");

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${credentials}`,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new AuthenticationError(
        `OIDC token request failed (${response.status}): ${detail}`,
      );
    }

    const data = (await response.json()) as { access_token: string };
    this.token = data.access_token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const fetchOptions: RequestInit = { method, headers };
    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err: any) {
      throw new ConnectionError(
        `Cannot connect to ${this.baseUrl}: ${err?.message || err}`,
      );
    }

    if (response.status === 401) {
      throw new AuthenticationError("Authentication required. Use --token.");
    }
    if (response.status === 403) {
      throw new AuthenticationError("Invalid token.");
    }
    if (response.status === 404) {
      throw new NotFoundError(`Not found: ${method} ${path}`);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const errBody = await response.json();
        detail = (errBody as any)?.error || JSON.stringify(errBody);
      } catch {
        detail = await response.text();
      }
      throw new ApiError(
        `API error ${response.status} on ${method} ${path}: ${detail}`,
      );
    }

    const data = (await response.json()) as T;

    if (this.fixtureDir) {
      this.saveFixture(method, path, body, data);
    }

    return data;
  }

  private pollingFixtureFile?: string;

  private saveFixture(method: string, path: string, requestBody: unknown, responseBody: unknown): void {
    // Polling endpoint: only save first and overwrite with latest (keeps first + last)
    if (path.endsWith("/ve/execute")) {
      if (!this.pollingFixtureFile) {
        // First poll — save as "first"
        const idx = String(++this.fixtureIndex).padStart(3, "0");
        const slug = path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
        this.pollingFixtureFile = `${idx}-${method}-${slug}`;
        writeFileSync(join(this.fixtureDir!, `${this.pollingFixtureFile}-first.json`), JSON.stringify({
          method, path, request: null, response: responseBody,
        }, null, 2) + "\n");
      }
      // Always overwrite "last" — final file will be the last poll
      writeFileSync(join(this.fixtureDir!, `${this.pollingFixtureFile}-last.json`), JSON.stringify({
        method, path, request: null, response: responseBody,
      }, null, 2) + "\n");
      return;
    }

    const idx = String(++this.fixtureIndex).padStart(3, "0");
    const slug = path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
    const filename = `${idx}-${method}-${slug}.json`;
    writeFileSync(join(this.fixtureDir!, filename), JSON.stringify({
      method, path, request: requestBody ?? null, response: responseBody,
    }, null, 2) + "\n");
  }

  async getSshConfigs(): Promise<ISshConfigsResponse> {
    return this.request("GET", "/api/sshconfigs");
  }

  async getSshConfigKey(host: string): Promise<{ key: string }> {
    return this.request("GET", `/api/ssh/config/${encodeURIComponent(host)}`);
  }

  async getApplications(): Promise<IApplicationsResponse> {
    return this.request("GET", "/api/applications");
  }

  async getUnresolvedParameters(
    veCtx: string,
    app: string,
    task: string,
  ): Promise<IUnresolvedParametersResponse> {
    return this.request(
      "GET",
      `/api/${veCtx}/unresolved-parameters/${encodeURIComponent(app)}?task=${encodeURIComponent(task)}`,
    );
  }

  async postEnumValues(
    veCtx: string,
    app: string,
    task: string,
  ): Promise<IEnumValuesResponse> {
    return this.request(
      "POST",
      `/api/${veCtx}/enum-values/${encodeURIComponent(app)}`,
      { task } as IPostEnumValuesBody,
    );
  }

  async getCompatibleAddons(app: string): Promise<ICompatibleAddonsResponse> {
    return this.request(
      "GET",
      `/api/addons/compatible/${encodeURIComponent(app)}`,
    );
  }

  async getStacktypes(): Promise<IStacktypesResponse> {
    return this.request("GET", "/api/stacktypes");
  }

  async getStacks(stacktype?: string): Promise<IStacksResponse> {
    const query = stacktype
      ? `?stacktype=${encodeURIComponent(stacktype)}`
      : "";
    return this.request("GET", `/api/stacks${query}`);
  }

  async postValidateParameters(
    veCtx: string,
    app: string,
    task: string,
    body: {
      params: { name: string; value: any }[];
      selectedAddons?: string[];
      disabledAddons?: string[];
      stackId?: string;
    },
  ): Promise<ValidationResult> {
    return this.request(
      "POST",
      `/api/${veCtx}/validate-parameters/${encodeURIComponent(app)}`,
      { task, ...body },
    );
  }

  async postVeConfiguration(
    veCtx: string,
    app: string,
    task: string,
    body: Omit<IPostVeConfigurationBody, "task">,
  ): Promise<IPostVeConfigurationResponse> {
    return this.request(
      "POST",
      `/api/${veCtx}/ve-configuration/${encodeURIComponent(app)}`,
      { task, ...body } as IPostVeConfigurationBody,
    );
  }

  async postCreateStack(body: {
    name: string;
    stacktype: string;
    entries?: { name: string; value: string | number | boolean }[];
  }): Promise<{ success: boolean; key: string }> {
    return this.request("POST", "/api/stacks", {
      ...body,
      entries: body.entries ?? [],
    });
  }

  async getContainerConfig(
    veCtx: string,
    vmId: number,
  ): Promise<Record<string, any>> {
    return this.request("GET", `/api/${veCtx}/container-config/${vmId}`);
  }

  async getExecuteMessages(
    veCtx: string,
    since?: number,
  ): Promise<IVeExecuteMessagesResponse> {
    const query = since !== undefined ? `?since=${since}` : "";
    return this.request("GET", `/api/${veCtx}/ve/execute${query}`);
  }

  async getValidation(): Promise<{ valid: boolean; [key: string]: any }> {
    return this.request("GET", "/api/validate");
  }
}
