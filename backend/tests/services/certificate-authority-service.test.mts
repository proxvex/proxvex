import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mts";
import {
  CertificateAuthorityService,
  normalizeExtraSans,
} from "@src/services/certificate-authority-service.mjs";
import type { ContextManager } from "@src/context-manager.mjs";

/** Read the SAN extension from a base64-encoded PEM cert. */
function readSanExtension(certB64: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ca-test-san-"));
  try {
    const certPath = path.join(dir, "cert.pem");
    writeFileSync(certPath, Buffer.from(certB64, "base64"), "utf-8");
    return execSync(
      `openssl x509 -in "${certPath}" -noout -ext subjectAltName`,
      { encoding: "utf-8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the subject line from a base64-encoded PEM cert. */
function readCertSubject(certB64: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ca-test-subj-"));
  try {
    const certPath = path.join(dir, "cert.pem");
    writeFileSync(certPath, Buffer.from(certB64, "base64"), "utf-8");
    return execSync(
      `openssl x509 -in "${certPath}" -noout -subject`,
      { encoding: "utf-8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CertificateAuthorityService", () => {
  let env: TestEnvironment;
  let ctx: ContextManager;
  let service: CertificateAuthorityService;
  const veContextKey = "ve_testhost";

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    const init = env.initPersistence({ enableCache: false });
    ctx = init.ctx;
    service = new CertificateAuthorityService(ctx);
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("generateCA()", () => {
    it("should generate valid CA key and cert", () => {
      const ca = service.generateCA(veContextKey);
      expect(ca.key).toBeTruthy();
      expect(ca.cert).toBeTruthy();
      // Verify base64 encoded PEM content
      const keyPem = Buffer.from(ca.key, "base64").toString("utf-8");
      const certPem = Buffer.from(ca.cert, "base64").toString("utf-8");
      expect(keyPem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(certPem).toContain("-----BEGIN CERTIFICATE-----");
    });

    it("should store CA encrypted in context", () => {
      service.generateCA(veContextKey);
      expect(service.hasCA(veContextKey)).toBe(true);
    });

    it("CA cert should be self-signed", () => {
      service.generateCA(veContextKey);
      const info = service.getCaInfo(veContextKey);
      expect(info.exists).toBe(true);
      expect(info.subject).toContain("Proxvex CA");
    });
  });

  describe("ensureCA()", () => {
    it("should generate CA if not exists", () => {
      expect(service.hasCA(veContextKey)).toBe(false);
      const ca = service.ensureCA(veContextKey);
      expect(ca.key).toBeTruthy();
      expect(ca.cert).toBeTruthy();
      expect(service.hasCA(veContextKey)).toBe(true);
    });

    it("should return existing CA if already exists", () => {
      const ca1 = service.generateCA(veContextKey);
      const ca2 = service.ensureCA(veContextKey);
      expect(ca1.key).toBe(ca2.key);
      expect(ca1.cert).toBe(ca2.cert);
    });

    it("should return same CA on repeated calls", () => {
      const ca1 = service.ensureCA(veContextKey);
      const ca2 = service.ensureCA(veContextKey);
      expect(ca1.key).toBe(ca2.key);
      expect(ca1.cert).toBe(ca2.cert);
    });
  });

  describe("setCA() / getCA()", () => {
    it("should store and retrieve CA", () => {
      // First generate a CA to get valid key+cert
      const generated = service.generateCA("ve_temp");
      service.setCA(veContextKey, generated.key, generated.cert);

      const retrieved = service.getCA(veContextKey);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.key).toBe(generated.key);
      expect(retrieved!.cert).toBe(generated.cert);
    });

    it("should return null for non-existent VE key", () => {
      const ca = service.getCA("ve_nonexistent");
      expect(ca).toBeNull();
    });
  });

  describe("validateCaPem()", () => {
    it("should accept valid PEM key+cert", () => {
      const ca = service.generateCA(veContextKey);
      const result = service.validateCaPem(ca.key, ca.cert);
      expect(result.valid).toBe(true);
      expect(result.subject).toBeTruthy();
    });

    it("should reject invalid PEM format", () => {
      const invalidKey = Buffer.from("not a pem key").toString("base64");
      const invalidCert = Buffer.from("not a pem cert").toString("base64");
      const result = service.validateCaPem(invalidKey, invalidCert);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("should reject mismatched key+cert pair", () => {
      // Generate two different CAs
      const ca1 = service.generateCA("ve_host1");
      const ca2 = service.generateCA("ve_host2");
      const result = service.validateCaPem(ca1.key, ca2.cert);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not match");
    });
  });

  describe("getCaInfo()", () => {
    it("should return exists=false when no CA", () => {
      const info = service.getCaInfo(veContextKey);
      expect(info.exists).toBe(false);
      expect(info.subject).toBeUndefined();
    });

    it("should return subject and expiry when CA exists", () => {
      service.generateCA(veContextKey);
      const info = service.getCaInfo(veContextKey);
      expect(info.exists).toBe(true);
      expect(info.subject).toBeTruthy();
      expect(info.expiry_date).toBeTruthy();
      expect(info.days_remaining).toBeGreaterThan(3600); // ~10 years
    });
  });

  describe("generateSelfSignedCert()", () => {
    it("should generate CA-signed server cert", () => {
      const cert = service.generateSelfSignedCert(veContextKey, "myhost");
      expect(cert.key).toBeTruthy();
      expect(cert.cert).toBeTruthy();

      const keyPem = Buffer.from(cert.key, "base64").toString("utf-8");
      const certPem = Buffer.from(cert.cert, "base64").toString("utf-8");
      expect(keyPem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(certPem).toContain("-----BEGIN CERTIFICATE-----");
    });

    it("should auto-generate CA if none exists", () => {
      expect(service.hasCA(veContextKey)).toBe(false);
      service.generateSelfSignedCert(veContextKey, "myhost");
      // ensureCA is called internally, so CA should now exist
      expect(service.hasCA(veContextKey)).toBe(true);
    });

    it("cert subject should contain hostname", () => {
      const generated = service.generateSelfSignedCert(veContextKey, "myhost");
      const subject = readCertSubject(generated.cert);
      expect(subject).toContain("myhost");
    });

    it("each call signs fresh material — server certs are not persisted", () => {
      // The on-disk cert (in the container's certs volume) is the source of
      // truth. The backend signs fresh on every call; the container-side
      // script (`conf-generate-certificates.sh` + `cert_should_skip_write`)
      // decides whether to commit. Two calls therefore produce different
      // key+cert material.
      const first = service.generateSelfSignedCert(veContextKey, "stable-host");
      const second = service.generateSelfSignedCert(veContextKey, "stable-host");
      expect(second.key).not.toBe(first.key);
      expect(second.cert).not.toBe(first.cert);
    });

    it("does not write a stored cert into the context manager", () => {
      service.generateSelfSignedCert(veContextKey, "no-store-host");
      // Legacy storage key — must remain absent under the new contract.
      expect(ctx.get("ssl_no-store-host")).toBeUndefined();
    });
  });

  describe("ensureServerCert()", () => {
    it("delegates to generateSelfSignedCert (no caching, fresh material per call)", () => {
      const cert = service.ensureServerCert(veContextKey, "ensure-host");
      expect(cert.key).toBeTruthy();
      expect(cert.cert).toBeTruthy();
      const subject = readCertSubject(cert.cert);
      expect(subject).toContain("ensure-host");
    });

    it("returns different material on repeated calls", () => {
      const first = service.ensureServerCert(veContextKey, "repeat-host");
      const second = service.ensureServerCert(veContextKey, "repeat-host");
      expect(second.key).not.toBe(first.key);
      expect(second.cert).not.toBe(first.cert);
    });
  });

  describe("ssl_additional_san support", () => {
    it("normalizeExtraSans() handles strings, DNS: prefix, dedup and sort", () => {
      expect(normalizeExtraSans(undefined)).toEqual([]);
      expect(normalizeExtraSans("")).toEqual([]);
      expect(normalizeExtraSans("DNS:foo.example.com,DNS:bar.example.com"))
        .toEqual(["bar.example.com", "foo.example.com"]);
      // Bare names + duplicates + mixed case
      expect(normalizeExtraSans("Foo.Example.com,foo.example.com,bar.example.com"))
        .toEqual(["bar.example.com", "foo.example.com"]);
      // Array form
      expect(normalizeExtraSans(["DNS:a.test", "b.test"])).toEqual(["a.test", "b.test"]);
    });

    it("includes extraSans in the issued cert", () => {
      const cert = service.generateSelfSignedCert(
        veContextKey,
        "registry.host",
        ["registry-1.docker.io", "index.docker.io"],
      );
      const san = readSanExtension(cert.cert);
      expect(san).toContain("registry.host");
      expect(san).toContain("registry-1.docker.io");
      expect(san).toContain("index.docker.io");
      // Default SANs still present
      expect(san).toContain("localhost");
    });

    it("ensureServerCert reflects updated extraSans on the next call", () => {
      const first = service.ensureServerCert(veContextKey, "san-host", ["a.example"]);
      const sanFirst = readSanExtension(first.cert);
      expect(sanFirst).toContain("a.example");

      const second = service.ensureServerCert(veContextKey, "san-host", [
        "a.example",
        "b.example",
      ]);
      const sanSecond = readSanExtension(second.cert);
      expect(sanSecond).toContain("a.example");
      expect(sanSecond).toContain("b.example");
    });

    it("ensureServerCert SAN list is order-independent (normalizeExtraSans)", () => {
      const first = service.ensureServerCert(veContextKey, "stable-host", [
        "DNS:b.example",
        "DNS:a.example",
      ]);
      const second = service.ensureServerCert(veContextKey, "stable-host", [
        "a.example",
        "b.example",
      ]);
      // Two separate signings → distinct material, but the SAN identity is
      // the same. The container-side cert_should_skip_write decides whether
      // to commit the new pair to disk.
      const sanFirst = readSanExtension(first.cert);
      const sanSecond = readSanExtension(second.cert);
      expect(sanFirst).toContain("a.example");
      expect(sanFirst).toContain("b.example");
      expect(sanSecond).toContain("a.example");
      expect(sanSecond).toContain("b.example");
    });

    it("DNS: prefix is accepted and stripped (matches application.json format)", () => {
      const cert = service.generateSelfSignedCert(
        veContextKey,
        "prefix-host",
        ["DNS:registry-1.docker.io", "DNS:index.docker.io"],
      );
      const san = readSanExtension(cert.cert);
      // Bare names without `DNS:` literally appearing inside the SAN entries.
      expect(san).toContain("registry-1.docker.io");
      expect(san).not.toMatch(/DNS:DNS:/);
    });
  });
});
