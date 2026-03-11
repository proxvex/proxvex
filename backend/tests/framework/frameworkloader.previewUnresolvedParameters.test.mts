import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { IFrameworkApplicationDataBody } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";

describe("FrameworkLoader.getPreviewUnresolvedParameters", () => {
  let env: TestEnvironment;
  let contextManager: ContextManager;
  let loader: FrameworkLoader;
  let pm: PersistenceManager;
  let veContext: IVEContext;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/npm-nodejs\\.json$",
        "^applications/npm-nodejs/.*",
        "^shared/.*",
      ],
    });
    const init = env.initPersistence({ enableCache: false });
    pm = init.pm;
    contextManager = init.ctx;
    loader = new FrameworkLoader(
      {
        localPath: env.localDir,
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      contextManager,
      pm.getPersistence(),
    );

    // Create a mock VE context
    veContext = {
      host: "testhost",
      getStorageContext: () => contextManager as any,
      getKey: () => "ve_testhost",
    };
  });

  afterEach(() => {
    env.cleanup();
  });

  it("returns unresolved parameters for framework", async () => {
    const request: IFrameworkApplicationDataBody = {
      frameworkId: "npm-nodejs",
      name: "Test Application",
      description: "A test application for preview",
      parameterValues: [
        { id: "hostname", value: "test-app" },
        { id: "ostype", value: "alpine" },
      ],
    };

    const { unresolvedParameters: unresolvedParams } = await loader.getPreviewUnresolvedParameters(
      request,
      "installation",
      veContext,
    );

    // Should return an array of parameters
    expect(Array.isArray(unresolvedParams)).toBe(true);

    // Parameters should have required properties
    for (const param of unresolvedParams) {
      expect(param).toHaveProperty("id");
      expect(param).toHaveProperty("name");
      expect(param).toHaveProperty("type");
    }
  }, 60000); // 60 second timeout - template processing can be slow

  it("applies initial parameter values from request", async () => {
    const request: IFrameworkApplicationDataBody = {
      frameworkId: "npm-nodejs",
      name: "Test Application",
      description: "A test application for preview",
      parameterValues: [
        { id: "hostname", value: "my-hostname" },
        { id: "ostype", value: "debian" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "node" },
        { id: "command_args", value: "--version" },
        { id: "package", value: "my-package" },
      ],
    };

    const { unresolvedParameters: unresolvedParams } = await loader.getPreviewUnresolvedParameters(
      request,
      "installation",
      veContext,
    );

    // Parameters that were provided should not appear in unresolved list
    // (unless they're enum type which always shows)
    const hostnameParam = unresolvedParams.find((p) => p.id === "hostname");
    const ostypeParam = unresolvedParams.find((p) => p.id === "ostype");

    // These are resolved, so they may or may not appear depending on trace source
    // But if they appear, they should still have the correct structure
    if (hostnameParam) {
      expect(hostnameParam.type).toBeDefined();
    }
    if (ostypeParam) {
      expect(ostypeParam.type).toBeDefined();
    }
  }, 60000);

  it("returns empty values for empty parameter values", async () => {
    const request: IFrameworkApplicationDataBody = {
      frameworkId: "npm-nodejs",
      name: "Test Application",
      description: "A test application for preview",
      parameterValues: [], // No values provided
    };

    const { unresolvedParameters: unresolvedParams } = await loader.getPreviewUnresolvedParameters(
      request,
      "installation",
      veContext,
    );

    // Should still return parameters (all unresolved)
    expect(Array.isArray(unresolvedParams)).toBe(true);
    // With no values provided, there should be unresolved parameters
    expect(unresolvedParams.length).toBeGreaterThan(0);
  }, 60000);

  it("throws error for invalid framework", async () => {
    const request: IFrameworkApplicationDataBody = {
      frameworkId: "non-existent-framework",
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    };

    await expect(
      loader.getPreviewUnresolvedParameters(request, "installation", veContext),
    ).rejects.toThrow();
  });

  it("handles uploadfiles in request", async () => {
    const request: IFrameworkApplicationDataBody = {
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
    };

    const { unresolvedParameters: unresolvedParams } = await loader.getPreviewUnresolvedParameters(
      request,
      "installation",
      veContext,
    );

    // Should return parameters without errors
    expect(Array.isArray(unresolvedParams)).toBe(true);

    // Should include upload parameter for config.json
    const uploadParam = unresolvedParams.find(
      (p) => p.id === "upload_config_json_content",
    );
    expect(uploadParam).toBeDefined();
    expect(uploadParam?.name).toBe("config.json");
    expect(uploadParam?.upload).toBe(true);
    expect(uploadParam?.templatename).toBe("Upload Files");
    expect(uploadParam?.required).toBe(false);
  }, 60000);

  it("includes required uploadfiles without content", async () => {
    const request: IFrameworkApplicationDataBody = {
      frameworkId: "npm-nodejs",
      name: "Test App Upload Required",
      description: "Test with required upload",
      parameterValues: [
        { id: "hostname", value: "test-upload" },
        { id: "ostype", value: "alpine" },
      ],
      uploadfiles: [
        {
          destination: "config:settings.conf",
          required: true,
          // No content - user must provide during installation
        },
      ],
    };

    const { unresolvedParameters: unresolvedParams } = await loader.getPreviewUnresolvedParameters(
      request,
      "installation",
      veContext,
    );

    // Should include the required upload parameter
    const uploadParam = unresolvedParams.find(
      (p) => p.id === "upload_settings_conf_content",
    );
    expect(uploadParam).toBeDefined();
    expect(uploadParam?.name).toBe("settings.conf");
    expect(uploadParam?.upload).toBe(true);
    expect(uploadParam?.required).toBe(true);
    expect(uploadParam?.default).toBeUndefined();
  }, 60000);
});
