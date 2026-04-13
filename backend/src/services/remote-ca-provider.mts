import https from "node:https";
import fs from "node:fs";
import { ICaInfoResponse } from "../types.mjs";
import { ICaProvider } from "./ca-provider.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("remote-ca-provider");

/**
 * Remote CA provider: delegates CA operations to the Hub deployer via HTTPS/mTLS.
 * Uses the local server cert as client cert for mTLS authentication.
 */
export class RemoteCaProvider implements ICaProvider {
  private hubUrl: string;
  private agent: https.Agent;

  constructor(
    hubUrl: string,
    private certPath: string,
    private keyPath: string,
    private caPath: string,
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.agent = new https.Agent({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      ca: fs.readFileSync(caPath),
      rejectUnauthorized: true,
    });
    logger.info("Remote CA provider initialized", { hubUrl: this.hubUrl });
  }

  private async fetchJson<T>(path: string, method: string = "GET", body?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.hubUrl);
      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: this.agent,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      };

      const req = https.request(options, (res) => {
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

      req.on("error", (err) => reject(new Error(`Hub connection failed: ${err.message}`)));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // --- CA lifecycle (delegated to Hub) ---

  ensureCA(veContextKey: string): { key: string; cert: string } {
    // In Spoke mode, we don't have the CA private key locally.
    // Return the cached CA cert (public only) — signing happens on Hub.
    const cert = this.getCACertSync();
    if (!cert) throw new Error("Hub CA not available — is the Hub reachable?");
    // Return cert without key — Spoke should never have the CA private key
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
    // Would need async to call Hub — for now return basic info
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

  generateSelfSignedCert(veContextKey: string, hostname?: string): { key: string; cert: string } {
    // This needs to be synchronous but Hub call is async — use sync HTTP workaround
    // For now, throw; the async version should be used via the Hub API directly
    throw new Error("Use Hub API POST /api/hub/ca/sign for certificate signing");
  }

  ensureServerCert(veContextKey: string, hostname?: string): { key: string; cert: string } {
    const existing = this.getServerCert(hostname || "localhost");
    if (existing) return existing;
    throw new Error("Server cert not found — use Hub API to sign a new one");
  }

  getServerCert(_hostname: string): { key: string; cert: string } | null {
    // Spoke doesn't store server certs in context — they're in the secure volume
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
    if (this.cachedCaCert) return this.cachedCaCert;
    // Read CA cert from the ca file provided at construction
    try {
      const pem = fs.readFileSync(this.caPath, "utf-8");
      this.cachedCaCert = Buffer.from(pem).toString("base64");
      return this.cachedCaCert;
    } catch {
      return null;
    }
  }

  /**
   * Async method to sign a certificate via Hub API.
   * Called by spoke-aware code paths.
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
