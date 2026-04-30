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
    it("should generate CA-signed server cert and store it", () => {
      const cert = service.generateSelfSignedCert(veContextKey, "myhost");
      expect(cert.key).toBeTruthy();
      expect(cert.cert).toBeTruthy();

      const keyPem = Buffer.from(cert.key, "base64").toString("utf-8");
      const certPem = Buffer.from(cert.cert, "base64").toString("utf-8");
      expect(keyPem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(certPem).toContain("-----BEGIN CERTIFICATE-----");
    });

    it("should store cert retrievable by hostname", () => {
      service.generateSelfSignedCert(veContextKey, "myhost");
      expect(service.hasServerCert("myhost")).toBe(true);
      const retrieved = service.getServerCert("myhost");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.key).toBeTruthy();
    });

    it("should auto-generate CA if none exists", () => {
      expect(service.hasCA(veContextKey)).toBe(false);
      service.generateSelfSignedCert(veContextKey, "myhost");
      // ensureCA is called internally, so CA should now exist
      expect(service.hasCA(veContextKey)).toBe(true);
    });

    it("cert subject should contain hostname", () => {
      service.generateSelfSignedCert(veContextKey, "myhost");
      const info = service.getServerCertInfo("myhost");
      expect(info.exists).toBe(true);
      expect(info.subject).toContain("myhost");
    });
  });

  describe("ensureServerCert()", () => {
    it("should generate if not exists", () => {
      expect(service.hasServerCert("newhost")).toBe(false);
      const cert = service.ensureServerCert(veContextKey, "newhost");
      expect(cert.key).toBeTruthy();
      expect(service.hasServerCert("newhost")).toBe(true);
    });

    it("should return existing cert on repeated calls", () => {
      const cert1 = service.ensureServerCert(veContextKey, "newhost");
      const cert2 = service.ensureServerCert(veContextKey, "newhost");
      expect(cert1.key).toBe(cert2.key);
      expect(cert1.cert).toBe(cert2.cert);
    });
  });

  describe("getServerCertInfo()", () => {
    it("should return exists=false when no cert", () => {
      const info = service.getServerCertInfo("unknown");
      expect(info.exists).toBe(false);
    });

    it("should return subject and expiry when cert exists", () => {
      service.generateSelfSignedCert(veContextKey, "infohost");
      const info = service.getServerCertInfo("infohost");
      expect(info.exists).toBe(true);
      expect(info.subject).toBeTruthy();
      expect(info.expiry_date).toBeTruthy();
      expect(info.days_remaining).toBeGreaterThan(800); // 825 days
    });
  });

  describe("setServerCert() / getServerCert()", () => {
    it("should store and retrieve server cert", () => {
      const generated = service.generateSelfSignedCert(veContextKey, "storehost");
      // Store for a different hostname
      service.setServerCert("otherhost", generated.key, generated.cert);
      const retrieved = service.getServerCert("otherhost");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.key).toBe(generated.key);
    });

    it("should return null for non-existent hostname", () => {
      expect(service.getServerCert("nope")).toBeNull();
    });

    it("should be independent per hostname", () => {
      service.generateSelfSignedCert(veContextKey, "host-a");
      service.generateSelfSignedCert(veContextKey, "host-b");
      const a = service.getServerCert("host-a");
      const b = service.getServerCert("host-b");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.key).not.toBe(b!.key);
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

    it("ensureServerCert regenerates when extraSans change", () => {
      const first = service.ensureServerCert(veContextKey, "san-host", ["a.example"]);
      const sanFirst = readSanExtension(first.cert);
      expect(sanFirst).toContain("a.example");

      const second = service.ensureServerCert(veContextKey, "san-host", [
        "a.example",
        "b.example",
      ]);
      expect(second.cert).not.toBe(first.cert);
      const sanSecond = readSanExtension(second.cert);
      expect(sanSecond).toContain("a.example");
      expect(sanSecond).toContain("b.example");
    });

    it("ensureServerCert returns cached cert when extraSans match (any order)", () => {
      const first = service.ensureServerCert(veContextKey, "stable-host", [
        "DNS:b.example",
        "DNS:a.example",
      ]);
      const second = service.ensureServerCert(veContextKey, "stable-host", [
        "a.example",
        "b.example",
      ]);
      expect(second.cert).toBe(first.cert);
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
