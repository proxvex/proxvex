import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

describe("Validation routes", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;
  const veContextKey = "ve_testhost";

  beforeEach(async () => {
    setup = await createWebAppTestSetup(import.meta.url, {
      jsonIncludePatterns: ["addons/.*", "stacktypes/.*", "applications/oci-lxc-deployer/.*", "shared/.*"],
    });
    app = setup.app;
    setup.ctx.setVEContext({ host: "testhost", current: true });
  });

  afterEach(() => {
    setup.cleanup();
  });

  describe("POST /api/:veContext/validate-parameters/:application", () => {
    it("should reject unknown stackId for app without stacktype", async () => {
      const res = await request(app)
        .post(`/api/${veContextKey}/validate-parameters/oci-lxc-deployer`)
        .send({
          task: "installation",
          params: [],
          stackId: "nonexistent",
        });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.some((e: any) => e.field === "stackId")).toBe(true);
    });

    it("should accept stackId when addon provides matching stacktype", async () => {
      // Create a stack with oidc stacktype via API
      await request(app).post(ApiUri.Stacks).send({
        name: "test-oidc",
        stacktype: ["oidc"],
        entries: [],
      });
      // List stacks to see the actual ID
      const listRes = await request(app).get(ApiUri.Stacks);
      const oidcStack = listRes.body.stacks?.find((s: any) => s.name === "test-oidc");
      const stackName = oidcStack?.id || "test-oidc";

      const res = await request(app)
        .post(`/api/${veContextKey}/validate-parameters/oci-lxc-deployer`)
        .send({
          task: "installation",
          params: [],
          selectedAddons: ["addon-oidc"],
          stackId: stackName,
        });
      if (res.status === 500) console.error("Server error:", res.body);
      expect(res.status).toBe(200);
      // stackId should be valid because addon-oidc has stacktype "oidc"
      const stackError = res.body.errors?.find((e: any) => e.field === "stackId");
      expect(stackError).toBeUndefined();
    });

    it("should reject stackId when no addon provides matching stacktype", async () => {
      // Create a stack with oidc stacktype
      await request(app).post(ApiUri.Stacks).send({
        name: "test-oidc2",
        stacktype: ["oidc"],
        entries: [],
      });

      // Install without addon-oidc — app has no stacktype, no addon provides oidc
      const res = await request(app)
        .post(`/api/${veContextKey}/validate-parameters/oci-lxc-deployer`)
        .send({
          task: "installation",
          params: [],
          stackId: "test-oidc2",
        });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      const stackError = res.body.errors?.find((e: any) => e.field === "stackId");
      expect(stackError).toBeDefined();
    });
  });
});
