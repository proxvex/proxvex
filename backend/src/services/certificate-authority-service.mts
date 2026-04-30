import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { ContextManager } from "../context-manager.mjs";
import { ICaInfoResponse } from "../types.mjs";
import { ICaProvider } from "./ca-provider.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("certificate-authority");

interface StoredCA {
  key: string;   // Base64 PEM
  cert: string;  // Base64 PEM
  created: string;
}

interface StoredServerCert {
  key: string;    // Base64 PEM
  cert: string;   // Base64 PEM
  hostname: string;
  created: string;
  /** Sorted, normalized list of extra SANs the cert was signed with. */
  extraSans?: string[];
}

/**
 * Normalize an extra-SAN list to a sorted, deduped, lowercase array.
 * Accepts either the parsed array form or the raw `ssl_additional_san` string
 * (`DNS:foo.example,DNS:bar.example`). Empty entries and the `DNS:` prefix
 * are stripped so callers can pass either format.
 */
export function normalizeExtraSans(input: string | string[] | undefined | null): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : input.split(",");
  const cleaned = raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.toLowerCase().startsWith("dns:") ? s.slice(4) : s))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return Array.from(new Set(cleaned)).sort();
}

/**
 * Local CA provider: manages Certificate Authority lifecycle in encrypted storagecontext.
 * CA private key is never stored unencrypted on disk.
 * Uses openssl via child_process for certificate operations.
 *
 * Implements ICaProvider — used as the Hub/Standalone CA provider.
 */
export class CertificateAuthorityService implements ICaProvider {
  constructor(private contextManager: ContextManager) {}

  private contextKey(_veContextKey: string): string {
    return "ca_global";
  }

  getCA(veContextKey: string): { key: string; cert: string } | null {
    const stored = this.contextManager.get<StoredCA>(this.contextKey(veContextKey));
    if (!stored || !stored.key || !stored.cert) return null;
    return { key: stored.key, cert: stored.cert };
  }

  hasCA(veContextKey: string): boolean {
    return this.getCA(veContextKey) !== null;
  }

  setCA(veContextKey: string, key: string, cert: string): void {
    const stored: StoredCA = {
      key,
      cert,
      created: new Date().toISOString(),
    };
    this.contextManager.set(this.contextKey(veContextKey), stored);
    logger.info("CA stored for context", { veContextKey });
  }

  getCaInfo(veContextKey: string): ICaInfoResponse {
    const ca = this.getCA(veContextKey);
    if (!ca) return { exists: false };

    const tmpDir = mkdtempSync(path.join(tmpdir(), "ca-info-"));
    try {
      const certPath = path.join(tmpDir, "ca.crt");
      writeFileSync(certPath, Buffer.from(ca.cert, "base64"), "utf-8");

      const subjectOut = execSync(`openssl x509 -in "${certPath}" -noout -subject`, { encoding: "utf-8" }).trim();
      const startDateOut = execSync(`openssl x509 -in "${certPath}" -noout -startdate`, { encoding: "utf-8" }).trim();
      const endDateOut = execSync(`openssl x509 -in "${certPath}" -noout -enddate`, { encoding: "utf-8" }).trim();

      const subject = subjectOut.replace(/^subject\s*=\s*/, "");
      const startDateStr = startDateOut.replace(/^notBefore\s*=\s*/, "");
      const endDateStr = endDateOut.replace(/^notAfter\s*=\s*/, "");
      const startDate = new Date(startDateStr);
      const endDate = new Date(endDateStr);
      const daysRemaining = Math.floor((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

      return {
        exists: true,
        subject,
        issued_date: startDate.toISOString(),
        expiry_date: endDate.toISOString(),
        days_remaining: daysRemaining,
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Generate a new self-signed CA locally (on the backend, NOT on PVE host).
   * CA validity: 3650 days (~10 years), RSA 2048-bit.
   */
  generateCA(veContextKey: string): { key: string; cert: string } {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "ca-gen-"));
    try {
      const keyPath = path.join(tmpDir, "ca.key");
      const certPath = path.join(tmpDir, "ca.crt");

      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
        `-days 3650 -nodes -subj "/CN=Proxvex CA/O=proxvex"`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      const keyPem = readFileSync(keyPath, "utf-8");
      const certPem = readFileSync(certPath, "utf-8");

      const keyB64 = Buffer.from(keyPem).toString("base64");
      const certB64 = Buffer.from(certPem).toString("base64");

      this.setCA(veContextKey, keyB64, certB64);
      logger.info("CA generated and stored", { veContextKey });

      return { key: keyB64, cert: certB64 };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Ensure CA exists: return existing or generate new one.
   */
  ensureCA(veContextKey: string): { key: string; cert: string } {
    const existing = this.getCA(veContextKey);
    if (existing) return existing;
    return this.generateCA(veContextKey);
  }

  // --- Domain suffix management (stored per VE context) ---

  private domainSuffixKey(veContextKey: string): string {
    return `domain_suffix_${veContextKey}`;
  }

  getDomainSuffix(veContextKey: string): string {
    const stored = this.contextManager.get<string>(this.domainSuffixKey(veContextKey));
    return stored || ".local";
  }

  setDomainSuffix(veContextKey: string, suffix: string): void {
    this.contextManager.set(this.domainSuffixKey(veContextKey), suffix);
    logger.info("Domain suffix stored", { veContextKey, suffix });
  }

  // --- Shared volume path management (stored per VE context) ---

  private sharedVolpathKey(veContextKey: string): string {
    return `shared_volpath_${veContextKey}`;
  }

  getSharedVolpath(veContextKey: string): string | null {
    return this.contextManager.get<string>(this.sharedVolpathKey(veContextKey)) || null;
  }

  setSharedVolpath(veContextKey: string, path: string): void {
    this.contextManager.set(this.sharedVolpathKey(veContextKey), path);
    logger.info("Shared volpath stored", { veContextKey, path });
  }

  // --- Server SSL certificate management (stored by hostname) ---

  private serverCertKey(hostName: string): string {
    return `ssl_${hostName}`;
  }

  getServerCert(hostName: string): { key: string; cert: string } | null {
    const stored = this.contextManager.get<StoredServerCert>(this.serverCertKey(hostName));
    if (!stored || !stored.key || !stored.cert) return null;
    return { key: stored.key, cert: stored.cert };
  }

  hasServerCert(hostName: string): boolean {
    return this.getServerCert(hostName) !== null;
  }

  setServerCert(hostName: string, key: string, cert: string, extraSans?: string[]): void {
    const stored: StoredServerCert = {
      key,
      cert,
      hostname: hostName,
      created: new Date().toISOString(),
      extraSans: normalizeExtraSans(extraSans),
    };
    this.contextManager.set(this.serverCertKey(hostName), stored);
    logger.info("Server certificate stored", { hostname: hostName });
  }

  /** Read the stored cert plus the SAN list it was signed with. */
  private getStoredServerCert(hostName: string): StoredServerCert | null {
    const stored = this.contextManager.get<StoredServerCert>(this.serverCertKey(hostName));
    if (!stored || !stored.key || !stored.cert) return null;
    return stored;
  }

  getServerCertInfo(hostName: string): ICaInfoResponse {
    const cert = this.getServerCert(hostName);
    if (!cert) return { exists: false };

    const tmpDir = mkdtempSync(path.join(tmpdir(), "srv-cert-info-"));
    try {
      const certPath = path.join(tmpDir, "server.crt");
      writeFileSync(certPath, Buffer.from(cert.cert, "base64"), "utf-8");

      const subjectOut = execSync(`openssl x509 -in "${certPath}" -noout -subject`, { encoding: "utf-8" }).trim();
      const endDateOut = execSync(`openssl x509 -in "${certPath}" -noout -enddate`, { encoding: "utf-8" }).trim();

      const subject = subjectOut.replace(/^subject\s*=\s*/, "");
      const endDateStr = endDateOut.replace(/^notAfter\s*=\s*/, "");
      const endDate = new Date(endDateStr);
      const daysRemaining = Math.floor((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

      return {
        exists: true,
        subject,
        expiry_date: endDate.toISOString(),
        days_remaining: daysRemaining,
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Generate a CA-signed server certificate and store it in StorageContext.
   * Cert validity: 825 days, RSA 2048-bit, includes SAN for the hostname.
   *
   * `extraSans` adds extra DNS names to the SAN extension. Used by apps that
   * are reached via a redirected hostname (e.g. docker-registry-mirror is
   * accessed as `registry-1.docker.io` via `/etc/hosts` rewriting, so the
   * cert must validate for that name too).
   */
  generateSelfSignedCert(veContextKey: string, hostName?: string, extraSans?: string[]): { key: string; cert: string } {
    const effectiveHostname = hostName || hostname();
    const ca = this.ensureCA(veContextKey);
    const sans = normalizeExtraSans(extraSans);

    const tmpDir = mkdtempSync(path.join(tmpdir(), "srv-cert-gen-"));
    try {
      const keyPath = path.join(tmpDir, "server.key");
      const certPath = path.join(tmpDir, "server.crt");
      const csrPath = path.join(tmpDir, "server.csr");
      const extPath = path.join(tmpDir, "server.ext");
      const caKeyPath = path.join(tmpDir, "ca.key");
      const caCertPath = path.join(tmpDir, "ca.crt");

      // Write CA key+cert to tmp for signing
      writeFileSync(caKeyPath, Buffer.from(ca.key, "base64"), "utf-8");
      writeFileSync(caCertPath, Buffer.from(ca.cert, "base64"), "utf-8");

      // SAN extension config. Include both the FQDN ("zitadel-ssl.local")
      // and the bare hostname ("zitadel-ssl"). Other containers on the same
      // bridge connect via the bare hostname (Docker's default short name),
      // so without this DNS entry Traefik / nginx etc. can't match the cert
      // by SNI and fall back to a self-signed default cert. We also keep
      // localhost + 127.0.0.1 for in-container probes. `extraSans` adds
      // app-declared aliases (e.g. registry-1.docker.io for the mirror).
      const dnsEntries = [effectiveHostname];
      const bareHost = effectiveHostname.includes(".")
        ? effectiveHostname.split(".")[0]
        : undefined;
      if (bareHost && bareHost !== effectiveHostname && !dnsEntries.includes(bareHost)) {
        dnsEntries.push(bareHost);
      }
      dnsEntries.push("localhost");
      for (const s of sans) {
        if (!dnsEntries.includes(s)) dnsEntries.push(s);
      }

      const extContent = [
        "[v3_req]",
        "subjectAltName = @alt_names",
        "basicConstraints = CA:FALSE",
        "keyUsage = digitalSignature, keyEncipherment",
        "extendedKeyUsage = serverAuth",
        "",
        "[alt_names]",
        ...dnsEntries.map((d, i) => `DNS.${i + 1} = ${d}`),
        "IP.1 = 127.0.0.1",
      ].join("\n");
      writeFileSync(extPath, extContent, "utf-8");

      // Generate key + CSR
      execSync(
        `openssl req -newkey rsa:2048 -keyout "${keyPath}" -out "${csrPath}" ` +
        `-nodes -subj "/CN=${effectiveHostname}/O=proxvex"`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      // Sign with CA
      execSync(
        `openssl x509 -req -in "${csrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
        `-CAcreateserial -out "${certPath}" -days 825 -extensions v3_req -extfile "${extPath}"`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      const keyPem = readFileSync(keyPath, "utf-8");
      const certPem = readFileSync(certPath, "utf-8");

      const keyB64 = Buffer.from(keyPem).toString("base64");
      const certB64 = Buffer.from(certPem).toString("base64");

      this.setServerCert(effectiveHostname, keyB64, certB64, sans);
      logger.info("Server certificate generated (CA-signed) and stored", {
        hostname: effectiveHostname,
        veContextKey,
        extraSans: sans,
      });

      return { key: keyB64, cert: certB64 };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Ensure server cert exists for hostname: return existing or generate new one.
   * If `extraSans` differs from the SAN list the stored cert was signed with,
   * the cert is regenerated so app-declared aliases (e.g. registry-1.docker.io)
   * stay in sync with `ssl_additional_san` changes.
   */
  ensureServerCert(veContextKey: string, hostName?: string, extraSans?: string[]): { key: string; cert: string } {
    const effectiveHostname = hostName || hostname();
    const wanted = normalizeExtraSans(extraSans);
    const stored = this.getStoredServerCert(effectiveHostname);
    if (stored) {
      const have = normalizeExtraSans(stored.extraSans);
      if (have.length === wanted.length && have.every((v, i) => v === wanted[i])) {
        return { key: stored.key, cert: stored.cert };
      }
      logger.info("Regenerating server cert: SAN list changed", {
        hostname: effectiveHostname,
        had: have,
        wants: wanted,
      });
    }
    return this.generateSelfSignedCert(veContextKey, effectiveHostname, wanted);
  }

  /**
   * Validate PEM format and check that key matches cert.
   */
  validateCaPem(key: string, cert: string): { valid: boolean; subject?: string; error?: string } {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "ca-val-"));
    try {
      const keyPath = path.join(tmpDir, "ca.key");
      const certPath = path.join(tmpDir, "ca.crt");

      writeFileSync(keyPath, Buffer.from(key, "base64"), "utf-8");
      writeFileSync(certPath, Buffer.from(cert, "base64"), "utf-8");

      // Verify key format
      try {
        execSync(`openssl rsa -in "${keyPath}" -check -noout`, { encoding: "utf-8", stdio: "pipe" });
      } catch {
        return { valid: false, error: "Invalid private key PEM format" };
      }

      // Verify cert format
      try {
        execSync(`openssl x509 -in "${certPath}" -noout`, { encoding: "utf-8", stdio: "pipe" });
      } catch {
        return { valid: false, error: "Invalid certificate PEM format" };
      }

      // Verify key matches cert (compare modulus)
      const keyModulus = execSync(`openssl rsa -in "${keyPath}" -modulus -noout`, { encoding: "utf-8", stdio: "pipe" }).trim();
      const certModulus = execSync(`openssl x509 -in "${certPath}" -modulus -noout`, { encoding: "utf-8", stdio: "pipe" }).trim();

      if (keyModulus !== certModulus) {
        return { valid: false, error: "Private key does not match certificate" };
      }

      const subjectOut = execSync(`openssl x509 -in "${certPath}" -noout -subject`, { encoding: "utf-8" }).trim();
      const subject = subjectOut.replace(/^subject\s*=\s*/, "");

      return { valid: true, subject };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
