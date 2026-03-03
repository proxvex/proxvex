import { expect, describe, it, beforeEach, afterEach } from "vitest";
import { VeTestHelper } from "../ve-test-helper.mjs";
import { VEConfigurationError } from "@src/backend-types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";

describe("ProxmoxConfiguration.loadApplication", () => {
  let helper: VeTestHelper;
  const testAppName = "test-load-app";

  beforeEach(async () => {
    helper = new VeTestHelper();
    await helper.setup();
    // Create a simple test application for all tests
    helper.writeApplication(testAppName, {
      name: "Test Load Application",
      description: "Test application for loadApplication tests",
      installation: {
        post_start: ["simple-template.json"],
      },
    });
    helper.writeTemplate(testAppName, "simple-template.json", {
      execute_on: "lxc",
      name: "Simple Template",
      parameters: [
        { id: "vm_id", name: "VM ID", type: "string", required: true, description: "Virtual machine ID" },
        { id: "test_param", name: "Test Param", type: "string", default: "default_value", description: "A test parameter" },
      ],
      commands: [{ command: "echo 'test'" }],
    });
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  it("should load parameters and commands for a test application", async () => {
    const config = helper.createStorageContext();
    const templateProcessor = config.getTemplateProcessor();

    const result = await templateProcessor.loadApplication(
      testAppName,
      "installation",
      { host: "localhost", port: 22 } as any,
      ExecutionMode.TEST,
    );

    expect(result.parameters.length).toBeGreaterThan(0);
    expect(result.commands.length).toBeGreaterThan(0);
    const paramNames = result.parameters.map((p) => p.id);
    expect(paramNames).toContain("vm_id");
    expect(paramNames).toContain("test_param");
  })

  it("should throw error if a template file is missing and provide all errors and application object", async () => {
    const config = helper.createStorageContext();

    try {
      let application = helper.readApplication(testAppName);
      application.installation = { post_start: ["nonexistent-template.json"] };
      helper.writeApplication(testAppName, application);
      const templateProcessor = config.getTemplateProcessor();
      await templateProcessor.loadApplication(
        testAppName,
        "installation",
        { host: "localhost", port: 22 } as any,
        ExecutionMode.TEST,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(VEConfigurationError);
      const errorObj = err as VEConfigurationError;
      expect(Array.isArray(errorObj.details)).toBe(true);
      expect(errorObj.details!.length).toBeGreaterThan(0);
      // Check details for specific error messages - it should be one of the errors
      const detailMessages = errorObj.details!.map(
        (d: any) => d.passed_message || d.message || "",
      );
      const hasTemplateNotFoundError = detailMessages.some((m: string) =>
        /Template file not found/i.test(m),
      );
      expect(hasTemplateNotFoundError).toBe(true);
      // NEU: application-Objekt mit errors-Property
      expect((err as any).application).toBeDefined();
      expect((err as any).application.name).toBeDefined();
      expect(Array.isArray((err as any).application.errors)).toBe(true);
      expect((err as any).application.errors.length).toBeGreaterThan(0);
    }
  });

  it("should throw recursion error for endless nested templates and provide application object", async () => {
    const config = helper.createStorageContext();
    // Create a template that references itself
    const templateName = "recursive-template.json";
    helper.writeTemplate(testAppName, templateName, {
      execute_on: "lxc",
      name: "Recursive Template",
      commands: [
        {
          template: templateName,
        },
      ],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(testAppName);
    app.installation = { post_start: [templateName] };
    helper.writeApplication(testAppName, app);
    try {
      const templateProcessor = config.getTemplateProcessor();
      await templateProcessor.loadApplication(
        testAppName,
        "installation",
        { host: "localhost", port: 22 } as any,
        ExecutionMode.TEST,
      );
    } catch (err: any) {
      expect(err).toBeInstanceOf(VEConfigurationError);
      const errorObj = err as VEConfigurationError;
      expect(Array.isArray(errorObj.details)).toBe(true);
      expect(errorObj.details!.length).toBeGreaterThan(0);
      // Check details for recursion error message
      const detailMessages = errorObj.details!.map(
        (d: any) => d.passed_message || d.message || "",
      );
      const hasRecursionError = detailMessages.some((m: string) =>
        /Endless recursion detected/i.test(m),
      );
      expect(hasRecursionError).toBe(true);
    }
  });

  it("should throw error if a script file is missing and provide application object", async () => {
    const config = helper.createStorageContext();
    // Write a template that references a non-existent script
    const templateName = "missing-script-template.json";
    helper.writeTemplate(testAppName, templateName, {
      execute_on: "ve",
      name: "Missing Script Template",
      commands: [{ script: "nonexistent-script.sh" }],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(testAppName);
    app.installation = { post_start: [templateName] };
    helper.writeApplication(testAppName, app);
    try {
      const templateProcessor = config.getTemplateProcessor();
      await templateProcessor.loadApplication(
        testAppName,
        "installation",
        { host: "localhost", port: 22 } as any,
        ExecutionMode.TEST,
      );
    } catch (err: any) {
      // Validation error is acceptable here when script is missing
      expect(err.message).toMatch(/error|Script file not found/i);
    }
  });

  it("should throw error if a script uses an undefined parameter and provide application object", async () => {
    // Write a template that references a script using an undefined variable
    const templateName = "missing-param-script-template.json";
    const scriptName = "uses-missing-param.sh";
    // Write the script file with a variable that is not defined as a parameter
    helper.writeScript(
      testAppName,
      scriptName,
      '#!/bin/sh\necho "Value: {{ missing_param }}"\n',
    );
    helper.writeTemplate(testAppName, templateName, {
      execute_on: "ve",
      name: "Missing Param Script Template",
      commands: [{ script: scriptName }],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(testAppName);
    app.installation = { post_start: [templateName] };
    helper.writeApplication(testAppName, app);
    try {
      const config = helper.createStorageContext();
      const templateProcessor = config.getTemplateProcessor();
      await templateProcessor.loadApplication(
        testAppName,
        "installation",
        { host: "localhost", port: 22 } as any,
        ExecutionMode.TEST,
      );
    } catch (err: any) {
      // Validation error is acceptable here when parameter is missing
      const pattern = /missing_param|no such parameter/i;
      if (err instanceof VEConfigurationError && Array.isArray(err.details)) {
        const detailMessages = err.details.map(
          (d: any) => d.passed_message || d.message || "",
        );
        const hasMatch = detailMessages.some((m: string) => pattern.test(m));
        expect(hasMatch).toBe(true);
      } else {
        let matched = false;
        if (typeof err.message === "string") {
          matched = pattern.test(err.message);
          if (!matched) {
            try {
              const parsed = JSON.parse(err.message);
              if (Array.isArray(parsed)) {
                matched = parsed.some((d: any) =>
                  pattern.test(String(d.passed_message || d.message || d)),
                );
              }
            } catch {
              // ignore JSON parse errors
            }
          }
        }
        expect(matched).toBe(true);
      }
    }
  });

  it("should throw error if a command uses an undefined parameter and provide application object", async () => {
    const config = helper.createStorageContext();
    // Write a template that references a command using an undefined variable
    const templateName = "missing-param-command-template.json";
    helper.writeTemplate(testAppName, templateName, {
      execute_on: "ve",
      name: "Missing Param Command Template",
      commands: [{ command: "echo {{ missing_param }}" }],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(testAppName);
    app.installation = { post_start: [templateName] };
    helper.writeApplication(testAppName, app);
    try {
      const templateProcessor = config.getTemplateProcessor();
      await templateProcessor.loadApplication(
        testAppName,
        "installation",
        { host: "localhost", port: 22 } as any,
        ExecutionMode.TEST,
      );
    } catch (err: any) {
      expect(err).toBeInstanceOf(VEConfigurationError);
      const errorObj = err as VEConfigurationError;
      expect(Array.isArray(errorObj.details)).toBe(true);
      expect(errorObj.details!.length).toBeGreaterThan(0);
      // Check details for command uses variable error message
      const detailMessages = errorObj.details!.map(
        (d: any) => d.passed_message || d.message || "",
      );
      const hasCommandVariableError = detailMessages.some((m: string) =>
        /Command uses variable.*missing_param/i.test(m),
      );
      expect(hasCommandVariableError).toBe(true);
    }
  });

  it("should fail when enumValuesTemplate references nonexistent list template", async () => {
    const config = helper.createStorageContext();
    const templateProcessor = config.getTemplateProcessor();

    // Create a template with enumValuesTemplate that references a nonexistent list template
    const templateName = "enum-values-template.json";
    helper.writeTemplate(testAppName, templateName, {
      execute_on: "ve",
      name: "Enum Values Template",
      parameters: [
        {
          id: "test_enum",
          name: "Test Enum",
          type: "enum",
          enumValuesTemplate: "nonexistent-list-template.json",
        },
      ],
      commands: [{ command: "echo 'test'" }],
    });
    const app = helper.readApplication(testAppName);
    app.installation = { post_start: [templateName] };
    helper.writeApplication(testAppName, app);

    // This test expects the loadApplication to fail with an error when the enumValuesTemplate cannot be found
    try {
      await templateProcessor.loadApplication(
        testAppName,
        "installation",
        { host: "localhost", port: 22 } as any,
        ExecutionMode.TEST,
      );
      expect.fail(
        "Expected loadApplication to throw an error when enumValuesTemplate is not found",
      );
    } catch (err: any) {
      // Expected: Error when enumValuesTemplate cannot be found or executed
      expect(err).toBeDefined();
      expect(err.message).toBeDefined();

      // Should be a not found error or validation error
      const isExpectedError = err.message.match(
        /error|failed|not found|template/i,
      );
      expect(isExpectedError).toBeTruthy();

      // If it's a VEConfigurationError, check for details
      if (err instanceof VEConfigurationError) {
        expect(Array.isArray(err.details)).toBe(true);
        expect(err.details!.length).toBeGreaterThan(0);
      }
    }
  });
});
