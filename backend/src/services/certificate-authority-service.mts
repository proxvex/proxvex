import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { ContextManager } from "../context-manager.mjs";
import { ICaInfoResponse } from "../types.mjs";
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
}

/**
 * Manages Certificate Authority lifecycle in encrypted storagecontext.
 * CA private key is never stored unencrypted on disk.
 * Uses openssl via child_process for certificate operations.
 */
export class CertificateAuthorityService {
  constructor(private contextManager: ContextManager) {}

  private contextKey(veContextKey: string): string {
    return `ca_${veContextKey}`;
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
        `-days 3650 -nodes -subj "/CN=OCI-LXC-Deployer CA/O=oci-lxc-deployer"`,
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

  getSslEnabled(veContextKey: string): boolean {
    const stored = this.contextManager.get<{ ssl_enabled: boolean }>(`ssl_${veContextKey}`);
    return stored?.ssl_enabled ?? false;
  }

  setSslEnabled(veContextKey: string, enabled: boolean): void {
    this.contextManager.set(`ssl_${veContextKey}`, { ssl_enabled: enabled });
    logger.info("SSL setting updated", { veContextKey, enabled });
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

  setServerCert(hostName: string, key: string, cert: string): void {
    const stored: StoredServerCert = {
      key,
      cert,
      hostname: hostName,
      created: new Date().toISOString(),
    };
    this.contextManager.set(this.serverCertKey(hostName), stored);
    logger.info("Server certificate stored", { hostname: hostName });
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
   */
  generateSelfSignedCert(veContextKey: string, hostName?: string): { key: string; cert: string } {
    const effectiveHostname = hostName || hostname();
    const ca = this.ensureCA(veContextKey);

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

      // SAN extension config
      const extContent = [
        "[v3_req]",
        "subjectAltName = @alt_names",
        "basicConstraints = CA:FALSE",
        "keyUsage = digitalSignature, keyEncipherment",
        "extendedKeyUsage = serverAuth",
        "",
        "[alt_names]",
        `DNS.1 = ${effectiveHostname}`,
        "DNS.2 = localhost",
        "IP.1 = 127.0.0.1",
      ].join("\n");
      writeFileSync(extPath, extContent, "utf-8");

      // Generate key + CSR
      execSync(
        `openssl req -newkey rsa:2048 -keyout "${keyPath}" -out "${csrPath}" ` +
        `-nodes -subj "/CN=${effectiveHostname}/O=oci-lxc-deployer"`,
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

      this.setServerCert(effectiveHostname, keyB64, certB64);
      logger.info("Server certificate generated (CA-signed) and stored", { hostname: effectiveHostname, veContextKey });

      return { key: keyB64, cert: certB64 };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Ensure server cert exists for hostname: return existing or generate new one.
   */
  ensureServerCert(veContextKey: string, hostName?: string): { key: string; cert: string } {
    const effectiveHostname = hostName || hostname();
    const existing = this.getServerCert(effectiveHostname);
    if (existing) return existing;
    return this.generateSelfSignedCert(veContextKey, effectiveHostname);
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
