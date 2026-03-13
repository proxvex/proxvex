import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";

describe("Certificate API routes", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;
  const veContextKey = "ve_testhost";

  beforeEach(async () => {
    setup = await createWebAppTestSetup(import.meta.url);
    app = setup.app;
    // Set up a VE context so routes can find it
    setup.ctx.setVEContext({ host: "testhost", current: true });
  });

  afterEach(() => {
    setup.cleanup();
  });

  describe("GET /api/ve/certificates/ca/:veContext", () => {
    it("should return exists=false when no CA configured", async () => {
      const url = ApiUri.CertificateCa.replace(":veContext", veContextKey);
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(false);
    });

    it("should return CA info after generation", async () => {
      // Generate CA first
      const caService = new CertificateAuthorityService(setup.ctx);
      caService.generateCA(veContextKey);

      const url = ApiUri.CertificateCa.replace(":veContext", veContextKey);
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
      expect(res.body.subject).toBeTruthy();
      expect(res.body.expiry_date).toBeTruthy();
    });
  });

  describe("POST /api/ve/certificates/ca/:veContext", () => {
    it("should import valid CA key+cert", async () => {
      // Generate a CA to get valid key+cert
      const caService = new CertificateAuthorityService(setup.ctx);
      const ca = caService.generateCA("ve_temp");

      const url = ApiUri.CertificateCa.replace(":veContext", veContextKey);
      const res = await request(app).post(url).send({
        key: ca.key,
        cert: ca.cert,
      });
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
    });

    it("should reject invalid PEM format", async () => {
      const url = ApiUri.CertificateCa.replace(":veContext", veContextKey);
      const res = await request(app).post(url).send({
        key: Buffer.from("not a key").toString("base64"),
        cert: Buffer.from("not a cert").toString("base64"),
      });
      expect(res.status).toBe(400);
    });

    it("should reject mismatched key+cert", async () => {
      const caService = new CertificateAuthorityService(setup.ctx);
      const ca1 = caService.generateCA("ve_host1");
      const ca2 = caService.generateCA("ve_host2");

      const url = ApiUri.CertificateCa.replace(":veContext", veContextKey);
      const res = await request(app).post(url).send({
        key: ca1.key,
        cert: ca2.cert,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/ve/certificates/ca/generate/:veContext", () => {
    it("should generate and store new CA", async () => {
      const url = ApiUri.CertificateCaGenerate.replace(":veContext", veContextKey);
      const res = await request(app).post(url).send({});
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
      expect(res.body.subject).toContain("OCI-LXC-Deployer CA");
    });

    it("should overwrite existing CA", async () => {
      const caService = new CertificateAuthorityService(setup.ctx);
      const ca1 = caService.generateCA(veContextKey);

      const url = ApiUri.CertificateCaGenerate.replace(":veContext", veContextKey);
      const res = await request(app).post(url).send({});
      expect(res.status).toBe(200);

      const ca2 = caService.getCA(veContextKey);
      // New CA should have different key
      expect(ca2!.key).not.toBe(ca1.key);
    });
  });

  describe("POST /api/ve/certificates/renew/:veContext", () => {
    it("should return error when no CA exists", async () => {
      const url = ApiUri.CertificateRenew.replace(":veContext", veContextKey);
      const res = await request(app).post(url).send({
        hostnames: ["myhost"],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No CA configured");
    });
  });

});
