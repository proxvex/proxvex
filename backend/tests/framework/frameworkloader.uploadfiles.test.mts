import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("FrameworkLoader.createApplicationFromFramework with uploadfiles", () => {
  let env: TestEnvironment;
  let contextManager: ContextManager;
  let loader: FrameworkLoader;
  let pm: PersistenceManager;
  let persistenceHelper: TestPersistenceHelper;

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
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    loader = new FrameworkLoader(
      {
        localPath: env.localDir,
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      contextManager,
      pm.getPersistence(),
    );
  });

  afterEach(() => {
    env.cleanup();
  });

  it("creates upload templates and scripts for each uploadfile", async () => {
    const testContent = Buffer.from("test file content").toString("base64");

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-upload-app",
      name: "Test Upload Application",
      description: "Application with upload files",
      parameterValues: [
        { id: "hostname", value: "test-upload-app" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "config=test" },
      ],
      uploadfiles: [
        {
          destination: "config:config.json",
          content: testContent,
          required: true,
          advanced: false,
        },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-upload-app");

    // Verify template was created (with index prefix for ordering)
    // "config.json" sanitizes to "config-json" (extension included to avoid collisions)
    const templateContent = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-upload-app/templates/0-upload-config-json.json",
    ) as any;

    expect(templateContent.name).toBe("Upload config.json");
    expect(templateContent.description).toBe("Upload config-json");
    expect(templateContent.execute_on).toBe("ve");
    expect(templateContent.skip_if_all_missing).toContain("upload_config_json_content");

    // Verify parameters
    const contentParam = templateContent.parameters.find(
      (p: any) => p.id === "upload_config_json_content"
    );
    expect(contentParam).toBeDefined();
    expect(contentParam.upload).toBe(true);
    expect(contentParam.required).toBe(true);
    expect(contentParam.default).toBe(testContent);

    const destParam = templateContent.parameters.find(
      (p: any) => p.id === "upload_config_json_destination"
    );
    expect(destParam).toBeDefined();
    expect(destParam.default).toBe("config:config.json");

    // Verify command references library (with index prefix for ordering)
    expect(templateContent.commands[0].script).toBe("0-upload-config-json.sh");
    expect(templateContent.commands[0].library).toBe("upload-file-common.sh");
    expect(templateContent.commands[0].outputs).toContain("upload_config_json_uploaded");

    // Verify script was created (with index prefix for ordering)
    const scriptContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-upload-app/scripts/0-upload-config-json.sh",
    );
    expect(scriptContent).toContain("#!/bin/sh");
    expect(scriptContent).toContain("upload_pre_start_file");
    expect(scriptContent).toContain("{{ upload_config_json_content }}");
    expect(scriptContent).toContain("{{ upload_config_json_destination }}");
    expect(scriptContent).toContain('upload_output_result "upload_config_json_uploaded"');
  });

  it("updates application.json with pre_start templates", async () => {
    const testContent = Buffer.from("test").toString("base64");

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-prestart-app",
      name: "Test Pre-Start Application",
      description: "Application with pre_start templates",
      parameterValues: [
        { id: "hostname", value: "test-prestart-app" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
      uploadfiles: [
        {
          destination: "data:settings.yaml",
          content: testContent,
        },
      ],
    };

    await loader.createApplicationFromFramework(request);

    // Verify application.json contains pre_start reference
    const appJson = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-prestart-app/application.json",
    ) as any;

    expect(appJson.installation).toBeDefined();
    expect(appJson.installation.pre_start).toBeDefined();
    expect(Array.isArray(appJson.installation.pre_start)).toBe(true);
    expect(appJson.installation.pre_start.length).toBe(1);
    expect(appJson.installation.pre_start[0]).toBe("0-upload-settings-yaml.json");
  });

  it("handles multiple uploadfiles correctly", async () => {
    const content1 = Buffer.from("content 1").toString("base64");
    const content2 = Buffer.from("content 2").toString("base64");

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-multi-upload",
      name: "Test Multi Upload",
      description: "Application with multiple uploads",
      parameterValues: [
        { id: "hostname", value: "test-multi-upload" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
      uploadfiles: [
        {
          destination: "data:app.config",
          content: content1,
        },
        {
          destination: "data:db/settings.ini",
          content: content2,
          advanced: true,
        },
      ],
    };

    await loader.createApplicationFromFramework(request);

    // Verify both templates were created (with index prefix for ordering)
    // Label is extracted from destination: "data:app.config" → "app.config" → sanitized "app-config"
    // Label is extracted from destination: "data:db/settings.ini" → "settings.ini" → sanitized "settings-ini"
    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-multi-upload/templates/0-upload-app-config.json",
    )).not.toThrow();

    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-multi-upload/templates/1-upload-settings-ini.json",
    )).not.toThrow();

    // Verify both scripts were created (with index prefix for ordering)
    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-multi-upload/scripts/0-upload-app-config.sh",
    )).not.toThrow();

    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-multi-upload/scripts/1-upload-settings-ini.sh",
    )).not.toThrow();

    // Verify application.json contains both pre_start references (with index prefix)
    const appJson = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-multi-upload/application.json",
    ) as any;

    expect(appJson.installation.pre_start.length).toBe(2);
    expect(appJson.installation.pre_start).toContain("0-upload-app-config.json");
    expect(appJson.installation.pre_start).toContain("1-upload-settings-ini.json");

    // Verify advanced flag is preserved
    const dbTemplate = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-multi-upload/templates/1-upload-settings-ini.json",
    ) as any;
    const dbContentParam = dbTemplate.parameters.find(
      (p: any) => p.id === "upload_settings_ini_content"
    );
    expect(dbContentParam.advanced).toBe(true);
  });

  it("sanitizes filenames correctly", async () => {
    const testContent = Buffer.from("test").toString("base64");

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-sanitize",
      name: "Test Sanitize",
      description: "Test filename sanitization",
      parameterValues: [
        { id: "hostname", value: "test-sanitize" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
      uploadfiles: [
        {
          destination: "data:config.json",
          content: testContent,
        },
      ],
    };

    await loader.createApplicationFromFramework(request);

    // Label is extracted from destination: "data:config.json" → "config.json" → sanitized "config-json"
    // Verify template name (with index prefix)
    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-sanitize/templates/0-upload-config-json.json",
    )).not.toThrow();

    // Verify script name (with index prefix)
    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-sanitize/scripts/0-upload-config-json.sh",
    )).not.toThrow();

    // Verify parameter IDs
    const template = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-sanitize/templates/0-upload-config-json.json",
    ) as any;

    const contentParam = template.parameters.find(
      (p: any) => p.id === "upload_config_json_content"
    );
    expect(contentParam).toBeDefined();
  });

  it("handles uploadfiles without content (empty upload field)", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-no-content",
      name: "Test No Content",
      description: "Test uploadfile without content",
      parameterValues: [
        { id: "hostname", value: "test-no-content" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
      uploadfiles: [
        {
          destination: "data:empty.txt",
          // No content - user must upload at deployment
        },
      ],
    };

    await loader.createApplicationFromFramework(request);

    // Verify template was created without default content (with index prefix)
    const template = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-no-content/templates/0-upload-empty-txt.json",
    ) as any;

    const contentParam = template.parameters.find(
      (p: any) => p.id === "upload_empty_txt_content"
    );
    expect(contentParam).toBeDefined();
    expect(contentParam.default).toBeUndefined();
  });

  it("does not create uploadfiles if array is empty", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-empty-uploads",
      name: "Test Empty Uploads",
      description: "Test with empty uploadfiles array",
      parameterValues: [
        { id: "hostname", value: "test-empty-uploads" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
      uploadfiles: [],
    };

    await loader.createApplicationFromFramework(request);

    // Verify application.json does not have pre_start with upload templates
    const appJson = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-empty-uploads/application.json",
    ) as any;

    // installation.pre_start should not exist or be empty
    expect(
      !appJson.installation?.pre_start || appJson.installation.pre_start.length === 0
    ).toBe(true);

    // Scripts directory should not exist
    expect(() => persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "applications/test-empty-uploads/scripts/",
    )).toThrow();
  });
});
