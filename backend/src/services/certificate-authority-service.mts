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

  // --- Server SSL certificate signing ---
  //
  // Server certificates are NOT persisted by the backend. The on-disk cert
  // in the container's certs volume is the source of truth — see
  // `conf-generate-certificates.sh` + `cert_should_skip_write` in cert-common.sh
  // which decide whether a freshly-signed candidate is committed to disk.
  //
  // Each call to generateSelfSignedCert / ensureServerCert signs new material
  // from the persistent CA. The container-side script keeps the existing
  // key+cert pair when the candidate's identity (CN+SAN) matches what is
  // already deployed, so callers do not pay a TLS-rotation penalty for
  // unchanged identities.

  /**
   * Generate a CA-signed server certificate. Cert validity: 825 days,
   * RSA 2048-bit, includes SAN for the hostname.
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
        "extendedKeyUsage = serverAuth, clientAuth",
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

      logger.info("Server certificate signed (CA-signed)", {
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
   * Sign a server cert for the given hostname. Always produces fresh material;
   * the container-side script (`conf-generate-certificates.sh`) decides whether
   * to commit it to disk by comparing identity against the existing cert.pem.
   *
   * Kept as a thin wrapper around `generateSelfSignedCert` for ICaProvider
   * symmetry with the Spoke `RemoteCaProvider`, where the implementations
   * legitimately differ (the Hub-fetch path uses an in-process cache to avoid
   * redundant network round-trips inside one Reconfigure flow).
   */
  ensureServerCert(veContextKey: string, hostName?: string, extraSans?: string[]): { key: string; cert: string } {
    return this.generateSelfSignedCert(veContextKey, hostName, extraSans);
  }

  /**
   * Sign a client certificate for a single Common Name (mTLS user identity).
   * CN-only — no SAN — `basicConstraints=CA:FALSE`,
   * `extendedKeyUsage=clientAuth`. Cert validity 825 days, RSA 2048-bit.
   *
   * The CN is also embedded directly in the `-subj` string passed to openssl,
   * so it is strictly validated against `[A-Za-z0-9._-]+` to prevent subject
   * injection / shell breakout. Invalid names throw.
   */
  signClientCert(veContextKey: string, cn: string): { key: string; cert: string } {
    if (!/^[A-Za-z0-9._-]+$/.test(cn)) {
      throw new Error(`Invalid client certificate CN: ${JSON.stringify(cn)}`);
    }
    const ca = this.ensureCA(veContextKey);

    const tmpDir = mkdtempSync(path.join(tmpdir(), "cli-cert-gen-"));
    try {
      const keyPath = path.join(tmpDir, "client.key");
      const certPath = path.join(tmpDir, "client.crt");
      const csrPath = path.join(tmpDir, "client.csr");
      const extPath = path.join(tmpDir, "client.ext");
      const caKeyPath = path.join(tmpDir, "ca.key");
      const caCertPath = path.join(tmpDir, "ca.crt");

      writeFileSync(caKeyPath, Buffer.from(ca.key, "base64"), "utf-8");
      writeFileSync(caCertPath, Buffer.from(ca.cert, "base64"), "utf-8");

      const extContent = [
        "[v3_req]",
        "basicConstraints = CA:FALSE",
        "keyUsage = digitalSignature",
        "extendedKeyUsage = clientAuth",
      ].join("\n");
      writeFileSync(extPath, extContent, "utf-8");

      execSync(
        `openssl req -newkey rsa:2048 -keyout "${keyPath}" -out "${csrPath}" ` +
        `-nodes -subj "/CN=${cn}/O=proxvex"`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      execSync(
        `openssl x509 -req -in "${csrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
        `-CAcreateserial -out "${certPath}" -days 825 -extensions v3_req -extfile "${extPath}"`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      const keyB64 = Buffer.from(readFileSync(keyPath, "utf-8")).toString("base64");
      const certB64 = Buffer.from(readFileSync(certPath, "utf-8")).toString("base64");

      logger.info("Client certificate signed (CA-signed)", { cn, veContextKey });

      return { key: keyB64, cert: certB64 };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
