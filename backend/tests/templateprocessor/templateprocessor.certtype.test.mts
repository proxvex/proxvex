import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("Certificate template (156)", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    const templatesDir = persistenceHelper.resolve(
      Volume.JsonApplications,
      "test-cert-app/templates",
    );
    fs.mkdirSync(templatesDir, { recursive: true });

    // Create a simplified cert template (mirrors 156 skip logic)
    const certTemplate = {
      execute_on: "ve",
      name: "Generate Certificates",
      skip_if_all_missing: ["ca_key_b64"],
      parameters: [
        { id: "ca_key_b64", name: "CA Key", type: "string", internal: true, secure: true, description: "CA private key" },
        { id: "hostname", name: "Hostname", type: "string", default: "test", description: "Container hostname" },
      ],
      commands: [{
        name: "Generate Certificates",
        command: "echo 'generate certs'",
      }],
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-cert-app/templates/generate-certificates.json",
      certTemplate,
    );

    // Create application.json with certtype on ssl.mode parameter
    const applicationJson = {
      name: "Test Cert Application",
      description: "Test application with certtype parameter",
      parameters: [
        {
          id: "ssl.mode",
          name: "SSL Mode",
          type: "string",
          certtype: "server",
        },
      ],
      installation: {
        pre_start: ["generate-certificates.json"],
      },
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "test-cert-app/application.json",
      applicationJson,
    );

    const init = env.initPersistence({ enableCache: false });
    tp = new TemplateProcessor(
      {
        localPath: env.localDir,
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      init.ctx,
      init.pm.getPersistence(),
    );
  });

  afterAll(() => {
    env.cleanup();
  });

  it("should be skipped when ca_key_b64 is missing", async () => {
    const loaded = await tp.loadApplication(
      "test-cert-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
      [], // No inputs, so ca_key_b64 won't exist
    );

    // The template has skip_if_all_missing: ["ca_key_b64"]
    // Since ca_key_b64 is not provided, it should be skipped
    const certCommand = loaded.commands.find(
      (cmd) => cmd.name === "Generate Certificates",
    );
    expect(certCommand).toBeUndefined();

    // Should have a skipped placeholder instead
    const skippedCommand = loaded.commands.find(
      (cmd) => cmd.name?.includes("(skipped)") && cmd.command === "exit 0",
    );
    expect(skippedCommand).toBeDefined();
  });

  it("should be included when ca_key_b64 is provided", async () => {
    const loaded = await tp.loadApplication(
      "test-cert-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
      [{ id: "ca_key_b64", value: "dGVzdC1jYS1rZXk=" }],
    );

    const certCommand = loaded.commands.find(
      (cmd) => cmd.name === "Generate Certificates",
    );
    expect(certCommand).toBeDefined();
  });

  it("should include certtype in unresolved parameters", async () => {
    const loaded = await tp.loadApplication(
      "test-cert-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
      [],
    );

    const sslModeParam = loaded.parameters.find(
      (p) => p.id === "ssl.mode",
    );
    expect(sslModeParam).toBeDefined();
    expect(sslModeParam!.certtype).toBe("server");
  });
});
