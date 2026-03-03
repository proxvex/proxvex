import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";

describe("Template Parameter Description Validation", () => {
  let tempDir: string;
  let jsonPath: string;
  let localPath: string;
  let secretFilePath: string;
  let storageContextPath: string;
  let tp: any;

  beforeAll(() => {
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "template-validation-test-"),
    );
    jsonPath = path.join(tempDir, "json");
    localPath = path.join(tempDir, "local");
    secretFilePath = path.join(tempDir, "secret.txt");
    storageContextPath = path.join(tempDir, "storagecontext.json");

    fs.mkdirSync(path.join(jsonPath, "shared", "templates"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(jsonPath, "shared", "scripts"), { recursive: true });
    fs.mkdirSync(path.join(localPath), { recursive: true });

    fs.writeFileSync(secretFilePath, "", "utf-8");
    fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    PersistenceManager.initialize(
      localPath,
      storageContextPath,
      secretFilePath,
      true,
      jsonPath,
    );

    const pm = PersistenceManager.getInstance();
    const contextManager = pm.getContextManager();
    tp = contextManager.getTemplateProcessor();
  });

  afterEach(() => {
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore
    }

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper function to create test files
  function createTestFiles(
    templateName: string,
    parameterDescription: string | null,
    markdownContent: string | null,
  ) {
    // Templates in post_start phase must be in the post_start subdirectory
    const templatePath = path.join(
      jsonPath,
      "shared",
      "templates",
      "post_start",
      `${templateName}.json`,
    );
    // Scripts are resolved using the template category (post_start), so must be in post_start subdir
    const scriptPath = path.join(jsonPath, "shared", "scripts", "post_start", "test.sh");
    const appDir = path.join(jsonPath, "applications", templateName);
    const appPath = path.join(appDir, "application.json");

    const template = {
      name: "Test Template",
      description: "Test template for validation",
      execute_on: "ve",
      parameters: [
        {
          id: "test_param",
          name: "Test Parameter",
          type: "string",
          required: true,
          ...(parameterDescription && { description: parameterDescription }),
        },
      ],
      commands: [
        {
          script: "test.sh",
          description: "Test script",
        },
      ],
    };

    const application = {
      name: templateName,
      description: "Test application",
      installation: { post_start: [`${templateName}.json`] },
    };

    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2), "utf-8");
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho "test"', "utf-8");
    fs.writeFileSync(appPath, JSON.stringify(application, null, 2), "utf-8");

    if (markdownContent) {
      const markdownPath = path.join(
        jsonPath,
        "shared",
        "templates",
        "post_start",
        `${templateName}.md`,
      );
      fs.writeFileSync(markdownPath, markdownContent, "utf-8");
    }
  }

  // Helper function to create test with custom parameter
  function createTestFilesWithCustomParam(
    templateName: string,
    parameter: any,
    markdownContent: string | null,
  ) {
    // Templates in post_start phase must be in the post_start subdirectory
    const templatePath = path.join(
      jsonPath,
      "shared",
      "templates",
      "post_start",
      `${templateName}.json`,
    );
    // Scripts are resolved using the template category (post_start), so must be in post_start subdir
    const scriptPath = path.join(jsonPath, "shared", "scripts", "post_start", "test.sh");
    const appDir = path.join(jsonPath, "applications", templateName);
    const appPath = path.join(appDir, "application.json");

    const template = {
      name: "Test Template",
      description: "Test template for validation",
      execute_on: "ve",
      parameters: [parameter],
      commands: [
        {
          script: "test.sh",
          description: "Test script",
        },
      ],
    };

    const application = {
      name: templateName,
      description: "Test application",
      installation: { post_start: [`${templateName}.json`] },
    };

    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2), "utf-8");
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho "test"', "utf-8");
    fs.writeFileSync(appPath, JSON.stringify(application, null, 2), "utf-8");

    if (markdownContent) {
      const markdownPath = path.join(
        jsonPath,
        "shared",
        "templates",
        "post_start",
        `${templateName}.md`,
      );
      fs.writeFileSync(markdownPath, markdownContent, "utf-8");
    }
  }

  // Helper function to load application
  async function loadApplication(appName: string) {
    const veContext = { host: "localhost", port: 22 } as any;
    return await tp.loadApplication(
      appName,
      "installation",
      veContext,
      ExecutionMode.TEST,
    );
  }

  it("should fail validation when parameter has no description and no markdown file", async () => {
    createTestFiles("test-no-description", null, null);

    await expect(loadApplication("test-no-description")).rejects.toThrow(
      "has no description",
    );
  });

  it("should pass validation when parameter has description in JSON", async () => {
    createTestFiles(
      "test-with-json-description",
      "This is a valid description in JSON",
      null,
    );

    const loaded = await loadApplication("test-with-json-description");

    // Should load successfully without errors
    expect(loaded).toBeTruthy();
  });

  it("should pass validation when parameter has description in markdown file", async () => {
    const markdown = `# Test Template Documentation

## Test Parameter

This is a valid description from the markdown file.
It can span multiple lines.`;

    createTestFiles("test-with-markdown", null, markdown);

    const loaded = await loadApplication("test-with-markdown");

    // Should load successfully
    expect(loaded).toBeTruthy();

    const param = loaded.parameters.find((p: any) => p.id === "test_param");
    expect(param).toBeTruthy();
    expect(param?.description).toContain(
      "valid description from the markdown file",
    );
  });

  it("should resolve markdown section by parameter ID when name does not match", async () => {
    const markdown = `# Test Template Documentation

## my_param_id

This description is matched by the parameter ID, not the name.`;

    const parameter = {
      id: "my_param_id",
      name: "Different Name",
      type: "string",
      required: true,
    };

    createTestFilesWithCustomParam("test-id-match", parameter, markdown);

    const loaded = await loadApplication("test-id-match");

    // Should load successfully
    expect(loaded).toBeTruthy();

    const param = loaded.parameters.find((p: any) => p.id === "my_param_id");
    expect(param).toBeTruthy();
    expect(param?.description).toContain("matched by the parameter ID");
  });
});
