import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri, IUnresolvedParametersResponse } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

describe("WebApp Preview Unresolved Parameters API", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;
  const veContextKey = "ve_testhost";

  beforeEach(async () => {
    process.env.LXC_MANAGER_TEST_MODE = "true";

    setup = await createWebAppTestSetup(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/npm-nodejs\\.json$",
        "^applications/npm-nodejs/.*",
        "^shared/.*",
      ],
    });

    setup.ctx.setVEContext({
      host: "testhost",
      port: 22,
      current: true,
    } as any);

    app = setup.app;
  });

  afterEach(() => {
    delete process.env.LXC_MANAGER_TEST_MODE;
    setup.cleanup();
  });

  it("returns unresolved parameters for framework", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      veContextKey,
    );

    const res = await request(app)
      .post(url)
      .send({
        frameworkId: "npm-nodejs",
        name: "Test Application",
        description: "A test application for preview",
        parameterValues: [
          { id: "hostname", value: "test-app" },
          { id: "ostype", value: "alpine" },
        ],
      });

    expect(res.status).toBe(200);

    const body = res.body as IUnresolvedParametersResponse;
    expect(body).toHaveProperty("unresolvedParameters");
    expect(Array.isArray(body.unresolvedParameters)).toBe(true);

    // Each parameter should have basic properties
    for (const param of body.unresolvedParameters) {
      expect(param).toHaveProperty("id");
      expect(param).toHaveProperty("name");
      expect(param).toHaveProperty("type");
    }
  }, 60000);

  it("returns 404 for unknown veContext", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      "ve_unknown",
    );

    const res = await request(app)
      .post(url)
      .send({
        frameworkId: "npm-nodejs",
        name: "Test Application",
        description: "A test application",
        parameterValues: [],
      });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toContain("VE context not found");
  });

  it("returns 400 for missing frameworkId", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      veContextKey,
    );

    const res = await request(app).post(url).send({
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toContain("Missing frameworkId");
  });

  it("returns 400 for missing name", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      veContextKey,
    );

    const res = await request(app).post(url).send({
      frameworkId: "npm-nodejs",
      description: "A test application",
      parameterValues: [],
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toContain("Missing name");
  });

  it("returns error for invalid framework", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      veContextKey,
    );

    const res = await request(app)
      .post(url)
      .send({
        frameworkId: "non-existent-framework",
        name: "Test Application",
        description: "A test application",
        parameterValues: [],
      });

    // Should return an error status (4xx or 5xx)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toHaveProperty("error");
  });

  it("applies parameter values from request", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      veContextKey,
    );

    const res = await request(app)
      .post(url)
      .send({
        frameworkId: "npm-nodejs",
        name: "Test Application",
        description: "A test application",
        parameterValues: [
          { id: "hostname", value: "my-hostname" },
          { id: "ostype", value: "debian" },
          { id: "packages", value: "nodejs npm" },
          { id: "command", value: "node" },
          { id: "command_args", value: "--version" },
          { id: "package", value: "my-package" },
          { id: "username", value: "testuser" },
          { id: "volumes", value: "data=test" },
        ],
      });

    expect(res.status).toBe(200);

    const body = res.body as IUnresolvedParametersResponse;
    expect(body).toHaveProperty("unresolvedParameters");
    expect(Array.isArray(body.unresolvedParameters)).toBe(true);
  }, 60000);

  it("handles uploadfiles in request", async () => {
    const url = ApiUri.PreviewUnresolvedParameters.replace(
      ":veContext",
      veContextKey,
    );

    const res = await request(app)
      .post(url)
      .send({
        frameworkId: "npm-nodejs",
        name: "Test Application",
        description: "A test application with uploads",
        parameterValues: [
          { id: "hostname", value: "test-app" },
          { id: "ostype", value: "alpine" },
        ],
        uploadfiles: [
          {
            destination: "data:config.json",
            content: Buffer.from('{"key": "value"}').toString("base64"),
            required: false,
          },
        ],
      });

    expect(res.status).toBe(200);

    const body = res.body as IUnresolvedParametersResponse;
    expect(body).toHaveProperty("unresolvedParameters");
    expect(Array.isArray(body.unresolvedParameters)).toBe(true);
  }, 60000);
});
