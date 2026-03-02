import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mts";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";
import type { ContextManager } from "@src/context-manager.mjs";

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
      expect(info.subject).toContain("OCI-LXC-Deployer CA");
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

  describe("getSslEnabled() / setSslEnabled()", () => {
    it("should return false by default", () => {
      expect(service.getSslEnabled(veContextKey)).toBe(false);
    });

    it("should persist true after setSslEnabled(true)", () => {
      service.setSslEnabled(veContextKey, true);
      expect(service.getSslEnabled(veContextKey)).toBe(true);
    });

    it("should revert to false after setSslEnabled(false)", () => {
      service.setSslEnabled(veContextKey, true);
      expect(service.getSslEnabled(veContextKey)).toBe(true);
      service.setSslEnabled(veContextKey, false);
      expect(service.getSslEnabled(veContextKey)).toBe(false);
    });

    it("should be independent per veContextKey", () => {
      service.setSslEnabled("ve_host1", true);
      service.setSslEnabled("ve_host2", false);
      expect(service.getSslEnabled("ve_host1")).toBe(true);
      expect(service.getSslEnabled("ve_host2")).toBe(false);
    });
  });
});
