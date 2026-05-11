import https from "node:https";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { ICaInfoResponse } from "../types.mjs";
import { ICaProvider } from "./ca-provider.mjs";
import { normalizeExtraSans as normalizeSans } from "./certificate-authority-service.mjs";
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

  private projectDomainSuffix: string = ".local";

  getDomainSuffix(_veContextKey: string): string {
    return this.projectDomainSuffix;
  }

  setDomainSuffix(_veContextKey: string, suffix: string): void {
    this.projectDomainSuffix = suffix;
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

  /** Cache of server certs keyed by hostname+SAN-set so SAN changes invalidate. */
  private serverCertCache = new Map<string, { key: string; cert: string }>();

  private cacheKey(hostname: string, sans: string[]): string {
    return sans.length === 0 ? hostname : `${hostname}|${sans.join(",")}`;
  }

  generateSelfSignedCert(veContextKey: string, hostname?: string, extraSans?: string[]): { key: string; cert: string } {
    return this.ensureServerCert(veContextKey, hostname, extraSans);
  }

  ensureServerCert(_veContextKey: string, hostname?: string, extraSans?: string[]): { key: string; cert: string } {
    const host = hostname || "localhost";
    const sans = normalizeSans(extraSans);
    const key = this.cacheKey(host, sans);
    const cached = this.serverCertCache.get(key);
    if (cached) return cached;

    // Synchronous Hub call via spawnSync("curl"), analogous to RemoteStackProvider.
    // ICaProvider is sync because it's called from sync template-resolution paths.
    const url = `${this.hubUrl}/api/hub/ca/sign`;
    const args: string[] = ["-sS", "--max-time", "15"];
    if (this.isHttps) args.push("-k");
    args.push("-X", "POST");
    const token = this.getBearerToken?.();
    if (token) args.push("-H", `Authorization: Bearer ${token}`);
    args.push("-H", "Content-Type: application/json");
    const body: { hostname: string; extraSans?: string[] } = { hostname: host };
    if (sans.length > 0) body.extraSans = sans;
    args.push("-d", JSON.stringify(body));
    args.push(url);

    const result = spawnSync("curl", args, { encoding: "utf-8", timeout: 20000 });
    if (result.error) {
      throw new Error(`Hub /api/hub/ca/sign failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Hub /api/hub/ca/sign curl failed (rc=${result.status}): ${result.stderr}`);
    }
    let parsed: { cert?: string; key?: string };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Hub /api/hub/ca/sign returned non-JSON: ${result.stdout.slice(0, 200)}`);
    }
    if (!parsed.cert || !parsed.key) {
      throw new Error(`Hub /api/hub/ca/sign returned empty cert/key for ${host}`);
    }
    const signed = { cert: parsed.cert, key: parsed.key };
    this.serverCertCache.set(key, signed);
    logger.info("Server cert signed by Hub", { hostname: host, extraSans: sans });
    return signed;
  }

  // --- Internal helpers ---

  private cachedCaCert: string | null = null;

  private getCACertSync(): string | null {
    // Public CA cert is fetched from the Hub. ICaProvider.getCA is sync, so
    // we use spawnSync("curl") just like ensureServerCert above. Cached after
    // first successful fetch.
    if (this.cachedCaCert) return this.cachedCaCert;

    const url = `${this.hubUrl}/api/hub/ca/cert`;
    const args: string[] = ["-sS", "--max-time", "10"];
    if (this.isHttps) args.push("-k");
    const token = this.getBearerToken?.();
    if (token) args.push("-H", `Authorization: Bearer ${token}`);
    args.push(url);

    const result = spawnSync("curl", args, { encoding: "utf-8", timeout: 15000 });
    if (result.error || result.status !== 0) {
      logger.warn("Hub /api/hub/ca/cert fetch failed", {
        error: result.error?.message ?? `rc=${result.status}: ${result.stderr}`,
      });
      return null;
    }
    try {
      const parsed = JSON.parse(result.stdout) as { cert?: string };
      if (parsed.cert) {
        this.cachedCaCert = parsed.cert;
        return this.cachedCaCert;
      }
    } catch {
      logger.warn("Hub /api/hub/ca/cert returned non-JSON", {
        body: result.stdout.slice(0, 200),
      });
    }
    return null;
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
