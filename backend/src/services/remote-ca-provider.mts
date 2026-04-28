import https from "node:https";
import http from "node:http";
import { ICaInfoResponse } from "../types.mjs";
import { ICaProvider } from "./ca-provider.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("remote-ca-provider");

/**
 * Remote CA provider: delegates CA operations to the Hub deployer via HTTP(S).
 *
 * Auth: If a bearer token getter is provided and returns a token, it's sent
 * as `Authorization: Bearer <token>`. Otherwise the request goes unauthenticated
 * (Hub without OIDC accepts this).
 *
 * TLS trust: During TOFU (Trust On First Use) the HTTPS agent accepts any
 * certificate. Once a trusted CA PEM is known, it is pinned via `ca:`. For
 * plain http:// hub URLs TLS is not used.
 */
export class RemoteCaProvider implements ICaProvider {
  private hubUrl: string;
  private agent: https.Agent | http.Agent;
  private isHttps: boolean;

  constructor(
    hubUrl: string,
    private getBearerToken?: () => string | undefined,
    trustedHubCa?: string,
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.isHttps = this.hubUrl.startsWith("https://");
    if (this.isHttps) {
      this.agent = new https.Agent(
        trustedHubCa
          ? { ca: trustedHubCa, rejectUnauthorized: true }
          : { rejectUnauthorized: false },
      );
    } else {
      this.agent = new http.Agent();
    }
    logger.info("Remote CA provider initialized", {
      hubUrl: this.hubUrl,
      tls: this.isHttps ? (trustedHubCa ? "pinned-ca" : "TOFU-insecure") : "http",
    });
  }

  private async fetchJson<T>(
    path: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.hubUrl);
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";
      const token = this.getBearerToken?.();
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: this.agent,
        headers,
      };

      const lib = this.isHttps ? https : http;
      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Hub API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from Hub: ${data}`));
          }
        });
      });

      req.on("error", (err) =>
        reject(new Error(`Hub connection failed: ${err.message}`)),
      );
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // --- CA lifecycle (delegated to Hub) ---

  ensureCA(_veContextKey: string): { key: string; cert: string } {
    const cert = this.getCACertSync();
    if (!cert) throw new Error("Hub CA not available — is the Hub reachable?");
    return { key: "", cert };
  }

  getCA(_veContextKey: string): { key: string; cert: string } | null {
    const cert = this.getCACertSync();
    if (!cert) return null;
    return { key: "", cert };
  }

  hasCA(_veContextKey: string): boolean {
    return this.getCACertSync() !== null;
  }

  generateCA(_veContextKey: string): { key: string; cert: string } {
    throw new Error("Cannot generate CA on Spoke — CA is managed by Hub");
  }

  setCA(_veContextKey: string, _key: string, _cert: string): void {
    throw new Error("Cannot set CA on Spoke — CA is managed by Hub");
  }

  getCaInfo(_veContextKey: string): ICaInfoResponse {
    return { exists: this.hasCA(_veContextKey) };
  }

  validateCaPem(_key: string, _cert: string): { valid: boolean; subject?: string; error?: string } {
    throw new Error("Cannot validate CA PEM on Spoke — CA is managed by Hub");
  }

  // --- Domain suffix (stored locally for now) ---

  private domainSuffix: string = ".local";

  getDomainSuffix(_veContextKey: string): string {
    return this.domainSuffix;
  }

  setDomainSuffix(_veContextKey: string, suffix: string): void {
    this.domainSuffix = suffix;
  }

  // --- Shared volume path (stored locally) ---

  private sharedVolpath: string | null = null;

  getSharedVolpath(_veContextKey: string): string | null {
    return this.sharedVolpath;
  }

  setSharedVolpath(_veContextKey: string, path: string): void {
    this.sharedVolpath = path;
  }

  // --- Server certificates (signed by Hub) ---

  generateSelfSignedCert(_veContextKey: string, _hostname?: string): { key: string; cert: string } {
    throw new Error("Use Hub API POST /api/hub/ca/sign for certificate signing");
  }

  ensureServerCert(_veContextKey: string, hostname?: string): { key: string; cert: string } {
    const existing = this.getServerCert(hostname || "localhost");
    if (existing) return existing;
    throw new Error("Server cert not found — use Hub API to sign a new one");
  }

  getServerCert(_hostname: string): { key: string; cert: string } | null {
    return null;
  }

  hasServerCert(hostname: string): boolean {
    return this.getServerCert(hostname) !== null;
  }

  setServerCert(_hostname: string, _key: string, _cert: string): void {
    // Spoke doesn't store server certs in context
  }

  getServerCertInfo(_hostname: string): ICaInfoResponse {
    return { exists: false };
  }

  // --- Internal helpers ---

  private cachedCaCert: string | null = null;

  private getCACertSync(): string | null {
    // Public CA cert is fetched from the Hub. Because ICaProvider.getCA is sync
    // but Hub calls are async, we return whatever was fetched previously (via
    // the async warm-up path triggered during spoke-sync).
    return this.cachedCaCert;
  }

  /**
   * Warm the cached CA cert — called during spoke-sync or on demand.
   */
  async warmCaCacheAsync(): Promise<void> {
    const resp = await this.fetchJson<{ cert: string }>("/api/hub/ca/cert");
    this.cachedCaCert = resp.cert;
  }

  /**
   * Async method to sign a certificate via Hub API.
   */
  async signCertificateAsync(hostname: string): Promise<{ key: string; cert: string }> {
    const result = await this.fetchJson<{ cert: string; key: string }>(
      "/api/hub/ca/sign",
      "POST",
      { hostname },
    );
    logger.info("Certificate signed by Hub", { hostname });
    return result;
  }
}
