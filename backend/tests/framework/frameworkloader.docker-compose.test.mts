import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { VEConfigurationError, IVEContext } from "@src/backend-types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import type { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import path from "node:path";

describe("FrameworkLoader - docker-compose", () => {
  let env: TestEnvironment;
  let loader: FrameworkLoader;
  let contextManager: ReturnType<TestEnvironment["initPersistence"]>["ctx"];
  let pm: ReturnType<TestEnvironment["initPersistence"]>["pm"];

  beforeAll(() => {
    // Create test environment with temporary directories
    // localDir will be a unique temporary directory for this test
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/docker-compose\\.json$",
        "^applications/docker-compose/.*",
        "^shared/.*",
      ],
    });

    // Verify that localDir is a temporary directory (not the repo's local directory)
    expect(env.localDir).not.toContain("examples");
    expect(env.localDir).toContain("proxvex-test-");

    const init = env.initPersistence({ enableCache: false });
    pm = init.pm;
    contextManager = init.ctx;
    loader = new FrameworkLoader(
      {
        localPath: env.localDir, // Temporary directory for local applications
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      contextManager,
      pm.getPersistence(),
    );
  });

  afterAll(() => {
    // Cleanup temporary directories
    env.cleanup();
  });

  it("should set hostname as optional and compose_project as optional for docker-compose framework", async () => {
    // Load framework to ensure it's valid (result not used directly)
    loader.readFrameworkJson("docker-compose", {
      error: new VEConfigurationError("", "docker-compose"),
    });
    const veContext: IVEContext = {
      host: "validation-dummy",
      getStorageContext: () => contextManager as any,
      getKey: () => "ve_validation",
    };

    // getParameters can be slow due to:
    // - Template processing (loadApplication)
    // - Script validation (may attempt SSH connections with retries)
    // - File system operations
    const parameters = await loader.getParameters(
      "docker-compose",
      "installation",
      veContext,
    );

    // Find hostname and compose_project parameters
    const hostnameParam = parameters.find((p) => p.id === "hostname");
    const composeProjectParam = parameters.find(
      (p) => p.id === "compose_project",
    );

    // Verify hostname exists and is optional (Application ID can be used as default)
    expect(hostnameParam).toBeDefined();
    expect(hostnameParam?.required).toBe(false);
    expect(hostnameParam?.id).toBe("hostname");

    // Verify compose_project exists and is optional
    expect(composeProjectParam).toBeDefined();
    expect(composeProjectParam?.required).toBe(false);
    expect(composeProjectParam?.id).toBe("compose_project");

    // Verify that other parameters maintain their required status
    // compose_file should be required (from base application)
    const composeFileParam = parameters.find((p) => p.id === "compose_file");
    expect(composeFileParam).toBeDefined();
    expect(composeFileParam?.required).toBe(true);

    // env_file should be optional in create-application (from application.json)
    // At deployment time, the 320-post-upload template uses if: env_file_has_markers
    const envFileParam = parameters.find((p) => p.id === "env_file");
    expect(envFileParam).toBeDefined();
    expect(envFileParam?.required).toBe(false);

    // Verify that advanced flag is removed for all parameters
    for (const param of parameters) {
      expect((param as any).advanced).toBeUndefined();
    }
  }, 60000); // 60 second timeout - getParameters can be slow due to template processing and SSH retries

  it("should use Application ID as default for hostname when creating application without hostname", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "docker-compose",
      applicationId: "test-app-123",
      name: "Test Docker Compose App",
      description: "Test app",
      parameterValues: [
        {
          id: "compose_file",
          value: "dGVzdDogdmFsdWU=", // base64 encoded test yaml
        },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-app-123");

    // New 1-file format: parameters and properties are in application.json directly
    const appJsonPath = path.join(
      env.localDir,
      "applications",
      "test-app-123",
      "application.json",
    );
    const appJson = JSON.parse(
      require("fs").readFileSync(appJsonPath, "utf-8"),
    );

    // Find hostname parameter in application.json
    const hostnameParam = appJson.parameters?.find(
      (p: any) => p.id === "hostname",
    );
    expect(hostnameParam).toBeDefined();
    expect(hostnameParam?.required).toBe(false);
    expect(hostnameParam?.default).toBe("test-app-123"); // Application ID should be default

    // Find hostname in properties (should be set to Application ID)
    const hostnameProperty = appJson.properties?.find(
      (p: any) => p.id === "hostname",
    );
    expect(hostnameProperty).toBeDefined();
    expect(hostnameProperty?.value).toBe("test-app-123"); // Application ID should be value

    // Verify no separate template file is created
    const templatePath = path.join(
      env.localDir,
      "applications",
      "test-app-123",
      "templates",
      "test-app-123-parameters.json",
    );
    expect(require("fs").existsSync(templatePath)).toBe(false);
  }, 60000);

  it("should store env_file with markers and set env_file_has_markers flag", async () => {
    // When env_file contains {{ }} markers, it should be stored along with env_file_has_markers flag
    // This signals that user must upload a new .env at deployment time
    const envWithMarkers =
      "POSTGRES_PASSWORD={{ DB_PASSWORD }}\nJWT_SECRET={{ JWT_SECRET }}";
    const envWithMarkersBase64 = Buffer.from(envWithMarkers).toString("base64");

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "docker-compose",
      applicationId: "test-env-with-markers",
      name: "Test Env With Markers",
      description: "Test that env_file with markers is stored with flag",
      parameterValues: [
        {
          id: "compose_file",
          value: "c2VydmljZXM6CiAgdGVzdDoKICAgIGltYWdlOiBhbHBpbmU=", // base64 encoded minimal compose
        },
        {
          id: "env_file",
          value: envWithMarkersBase64,
        },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-env-with-markers");

    // Read generated application.json
    const appJsonPath = path.join(
      env.localDir,
      "applications",
      "test-env-with-markers",
      "application.json",
    );
    const appJson = JSON.parse(
      require("fs").readFileSync(appJsonPath, "utf-8"),
    );

    // env_file should be stored in properties
    const envFileProperty = appJson.properties?.find(
      (p: any) => p.id === "env_file",
    );
    expect(envFileProperty).toBeDefined();
    expect(envFileProperty?.value).toBe(envWithMarkersBase64);

    // env_file_has_markers flag should be set
    const markersFlag = appJson.properties?.find(
      (p: any) => p.id === "env_file_has_markers",
    );
    expect(markersFlag).toBeDefined();
    expect(markersFlag?.value).toBe("true");

    // compose_file should still be stored
    const composeFileProperty = appJson.properties?.find(
      (p: any) => p.id === "compose_file",
    );
    expect(composeFileProperty).toBeDefined();
    expect(composeFileProperty?.value).toBeDefined();
  }, 60000);

  it("should store env_file without markers and NOT set env_file_has_markers flag", async () => {
    // When env_file does not contain {{ }} markers, it should be stored without the flag
    // At deployment, the stored env_file can be used directly (no user upload needed)
    const envWithoutMarkers =
      "POSTGRES_PASSWORD=actualpassword123\nJWT_SECRET=actualsecret456";
    const envWithoutMarkersBase64 =
      Buffer.from(envWithoutMarkers).toString("base64");

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "docker-compose",
      applicationId: "test-env-without-markers",
      name: "Test Env Without Markers",
      description: "Test that env_file without markers is stored without flag",
      parameterValues: [
        {
          id: "compose_file",
          value: "c2VydmljZXM6CiAgdGVzdDoKICAgIGltYWdlOiBhbHBpbmU=", // base64 encoded minimal compose
        },
        {
          id: "env_file",
          value: envWithoutMarkersBase64,
        },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-env-without-markers");

    // Read generated application.json
    const appJsonPath = path.join(
      env.localDir,
      "applications",
      "test-env-without-markers",
      "application.json",
    );
    const appJson = JSON.parse(
      require("fs").readFileSync(appJsonPath, "utf-8"),
    );

    // env_file should be stored in properties
    const envFileProperty = appJson.properties?.find(
      (p: any) => p.id === "env_file",
    );
    expect(envFileProperty).toBeDefined();
    expect(envFileProperty?.value).toBe(envWithoutMarkersBase64);

    // env_file_has_markers flag should NOT be set
    const markersFlag = appJson.properties?.find(
      (p: any) => p.id === "env_file_has_markers",
    );
    expect(markersFlag).toBeUndefined();

    // compose_file should still be stored
    const composeFileProperty = appJson.properties?.find(
      (p: any) => p.id === "compose_file",
    );
    expect(composeFileProperty).toBeDefined();
    expect(composeFileProperty?.value).toBeDefined();
  }, 60000);

  it("should NOT store env_file or flag when no env_file is provided", async () => {
    // When no env_file is provided, neither env_file nor env_file_has_markers should be stored
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "docker-compose",
      applicationId: "test-no-env-file",
      name: "Test No Env File",
      description: "Test that nothing is stored when no env_file provided",
      parameterValues: [
        {
          id: "compose_file",
          value: "c2VydmljZXM6CiAgdGVzdDoKICAgIGltYWdlOiBhbHBpbmU=", // base64 encoded minimal compose
        },
        // No env_file provided
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-no-env-file");

    // Read generated application.json
    const appJsonPath = path.join(
      env.localDir,
      "applications",
      "test-no-env-file",
      "application.json",
    );
    const appJson = JSON.parse(
      require("fs").readFileSync(appJsonPath, "utf-8"),
    );

    // env_file should NOT be in properties
    const envFileProperty = appJson.properties?.find(
      (p: any) => p.id === "env_file",
    );
    expect(envFileProperty).toBeUndefined();

    // env_file_has_markers flag should NOT be set
    const markersFlag = appJson.properties?.find(
      (p: any) => p.id === "env_file_has_markers",
    );
    expect(markersFlag).toBeUndefined();
  }, 60000);
});
