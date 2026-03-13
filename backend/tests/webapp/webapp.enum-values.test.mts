import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { ApiUri, IEnumValuesResponse } from "@src/types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

describe("WebApp Enum Values API", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;
  const veContextKey = "ve_testhost";

  beforeEach(async () => {
    process.env.LXC_MANAGER_TEST_MODE = "true";

    setup = await createWebAppTestSetup(import.meta.url, {
      jsonIncludePatterns: [
        "^shared/templates/list/list-enum-values\\.json$",
      ],
      fixturesIncludePatterns: [
        "^applications/test-enum/.*",
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

  it("returns enum values without params", async () => {
    const url = ApiUri.EnumValues.replace(":application", "test-enum")
      .replace(":veContext", veContextKey);

    const res = await request(app).post(url).send({ task: "installation" });
    expect(res.status).toBe(200);

    const body = res.body as IEnumValuesResponse;
    const iface = body.enumValues.find((entry) => entry.id === "iface");
    expect(iface).toBeDefined();
    expect(Array.isArray(iface?.enumValues)).toBe(true);
    expect(iface?.enumValues).toContainEqual({ name: "eth0", value: "eth0" });
    expect(iface?.enumValues).toContainEqual({ name: "eth1", value: "eth1" });
  });

  it("uses params for enum template", async () => {
    const env = setup.env;
    const appId = "enum-params";
    const appDir = path.join(env.jsonDir, "applications", appId);
    const templatesDir = path.join(appDir, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    fs.writeFileSync(
      path.join(appDir, "application.json"),
      JSON.stringify(
        {
          name: "Enum Params App",
          description: "Test enum values with params",
          installation: { post_start: ["enum-param.json"] },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(templatesDir, "enum-param.json"),
      JSON.stringify(
        {
          execute_on: "ve",
          name: "Enum Param",
          description: "Enum parameter with dynamic values",
          parameters: [
            {
              id: "choice",
              name: "Choice",
              type: "enum",
              description: "Dynamic enum",
              enumValuesTemplate: "enum-values-from-prefix.json",
            },
          ],
          commands: [
            {
              name: "noop",
              command: "echo noop",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(templatesDir, "enum-values-from-prefix.json"),
      JSON.stringify(
        {
          execute_on: "ve",
          name: "Enum Values From Prefix",
          description: "Emit enum values based on prefix",
          commands: [
            {
              name: "emit",
              command:
                'printf \'[{"name":"{{prefix}}-one","value":"{{prefix}}-one"}]\'',
              outputs: ["enumValues"],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    PersistenceManager.getInstance().getPersistence().invalidateCache();

    const url = ApiUri.EnumValues.replace(":application", appId)
      .replace(":veContext", veContextKey);

    const res = await request(app)
      .post(url)
      .send({ task: "installation", params: [{ id: "prefix", value: "foo" }] });
    expect(res.status).toBe(200);

    const entry = (res.body as IEnumValuesResponse).enumValues.find(
      (item) => item.id === "choice",
    );
    expect(entry).toBeDefined();
    expect(entry?.enumValues).toContainEqual({
      name: "foo-one",
      value: "foo-one",
    });
  });
});
