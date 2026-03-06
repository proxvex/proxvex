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
} from "../types.mjs";
import type { ValidationResult } from "../parameter-validator.mjs";
import {
  ConnectionError,
  AuthenticationError,
  NotFoundError,
  ApiError,
} from "./cli-types.mjs";

export class CliApiClient {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string, token?: string, insecure?: boolean) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (token) this.token = token;
    if (insecure) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
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

    return (await response.json()) as T;
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
      `/api/${veCtx}/unresolved-parameters/${encodeURIComponent(app)}/${encodeURIComponent(task)}`,
    );
  }

  async postEnumValues(
    veCtx: string,
    app: string,
    task: string,
    body: IPostEnumValuesBody,
  ): Promise<IEnumValuesResponse> {
    return this.request(
      "POST",
      `/api/${veCtx}/enum-values/${encodeURIComponent(app)}/${encodeURIComponent(task)}`,
      body,
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
      stackId?: string;
    },
  ): Promise<ValidationResult> {
    return this.request(
      "POST",
      `/api/${veCtx}/validate-parameters/${encodeURIComponent(app)}/${encodeURIComponent(task)}`,
      body,
    );
  }

  async postVeConfiguration(
    veCtx: string,
    app: string,
    task: string,
    body: IPostVeConfigurationBody,
  ): Promise<IPostVeConfigurationResponse> {
    return this.request(
      "POST",
      `/api/${veCtx}/ve-configuration/${encodeURIComponent(app)}/${encodeURIComponent(task)}`,
      body,
    );
  }

  async getExecuteMessages(
    veCtx: string,
  ): Promise<IVeExecuteMessagesResponse> {
    return this.request("GET", `/api/${veCtx}/ve/execute`);
  }
}
