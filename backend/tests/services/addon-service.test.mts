import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "fs";
import { AddonPersistenceHandler } from "@src/persistence/addon-persistence-handler.mjs";
import { AddonService } from "@src/services/addon-service.mjs";
import { JsonValidator } from "@src/jsonvalidator.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";
import type { AddonTemplateReference } from "@src/types.mjs";
import type { IApplication } from "@src/backend-types.mjs";

describe("AddonService", () => {
  let env: TestEnvironment;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let handler: AddonPersistenceHandler;
  let service: AddonService;
  let jsonValidator: JsonValidator;
  let persistenceHelper: TestPersistenceHelper;

  // Helper to create a valid addon JSON (without id, which is derived from filename)
  const createAddonJson = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    name: "Test Addon",
    description: "A test addon",
    compatible_with: "*",
    notes_key: "test-addon",
    ...overrides,
  });

  // Helper to create a mock application
  const createApplication = (
    overrides: Partial<IApplication> = {},
  ): IApplication =>
    ({
      id: "test-app",
      name: "Test Application",
      description: "A test application",
      installation: {},
      ...overrides,
    }) as IApplication;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    jsonPath = env.jsonDir;
    localPath = env.localDir;
    schemaPath = env.schemaDir;
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    // Create addons directory
    mkdirSync(persistenceHelper.resolve(Volume.JsonAddons), {
      recursive: true,
    });

    // Initialize JsonValidator
    jsonValidator = new JsonValidator(schemaPath, [
      "templatelist.schema.json",
      "base-deployable.schema.json",
    ]);

    // Initialize handler and service
    handler = new AddonPersistenceHandler(
      { jsonPath, localPath, schemaPath },
      jsonValidator,
    );
    service = new AddonService(handler);
  });

  afterEach(() => {
    env?.cleanup();
  });

  describe("getAddonIds()", () => {
    it("should return empty array when no addons exist", () => {
      const result = service.getAddonIds();
      expect(result).toEqual([]);
    });

    it("should return addon IDs from json directory", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "my-addon.json",
        createAddonJson({
          name: "My Addon",
          notes_key: "my-addon",
        }),
      );

      const result = service.getAddonIds();
      expect(result).toContain("my-addon");
    });

    it("should return addon IDs from local directory", () => {
      const localAddonsDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "addons",
      );
      mkdirSync(localAddonsDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "addons/local-addon.json",
        createAddonJson({
          name: "Local Addon",
          notes_key: "local-addon",
        }),
      );

      const result = service.getAddonIds();
      expect(result).toContain("local-addon");
    });
  });

  describe("getAddon()", () => {
    it("should load addon from json directory", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "test-addon.json",
        createAddonJson({
          name: "Test Addon",
          description: "Test description",
        }),
      );

      const result = service.getAddon("test-addon");
      expect(result.name).toBe("Test Addon");
      expect(result.description).toBe("Test description");
      expect(result.id).toBe("test-addon");
    });

    it("should throw error for non-existent addon", () => {
      expect(() => service.getAddon("non-existent")).toThrow("Addon not found");
    });
  });

  describe("getAllAddons()", () => {
    it("should return all addons", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "addon1.json",
        createAddonJson({
          name: "Addon 1",
          notes_key: "addon1",
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "addon2.json",
        createAddonJson({
          name: "Addon 2",
          notes_key: "addon2",
        }),
      );

      const result = service.getAllAddons();
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.name)).toContain("Addon 1");
      expect(result.map((a) => a.name)).toContain("Addon 2");
    });
  });

  describe("isAddonCompatible()", () => {
    it("should return true for wildcard compatible_with", () => {
      const addon = createAddonJson({ compatible_with: "*" });
      const app = createApplication({ id: "any-app" });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should return true when application ID matches", () => {
      const addon = createAddonJson({
        compatible_with: ["my-app", "other-app"],
      });
      const app = createApplication({ id: "my-app" });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should return true when application extends matches", () => {
      const addon = createAddonJson({ compatible_with: ["base-app"] });
      const app = createApplication({ id: "child-app", extends: "base-app" });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should return true when tag matches", () => {
      const addon = createAddonJson({ compatible_with: ["tag:docker"] });
      const app = createApplication({ id: "my-app", tags: ["docker", "web"] });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should return false when no criteria matches", () => {
      const addon = createAddonJson({
        compatible_with: ["other-app", "tag:special"],
      });
      const app = createApplication({ id: "my-app", tags: ["docker"] });

      expect(service.isAddonCompatible(addon, app)).toBe(false);
    });
  });

  describe("getCompatibleAddons()", () => {
    it("should return only compatible addons", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "compatible.json",
        createAddonJson({
          name: "Compatible Addon",
          notes_key: "compatible",
          compatible_with: ["my-app"],
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "incompatible.json",
        createAddonJson({
          name: "Incompatible Addon",
          notes_key: "incompatible",
          compatible_with: ["other-app"],
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "wildcard.json",
        createAddonJson({
          name: "Wildcard Addon",
          notes_key: "wildcard",
          compatible_with: "*",
        }),
      );

      const app = createApplication({ id: "my-app" });
      const result = service.getCompatibleAddons(app);

      expect(result).toHaveLength(2);
      expect(result.map((a) => a.name)).toContain("Compatible Addon");
      expect(result.map((a) => a.name)).toContain("Wildcard Addon");
      expect(result.map((a) => a.name)).not.toContain("Incompatible Addon");
    });
  });

  describe("mergeAddonTemplates()", () => {
    it("should append templates when no before/after specified", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "template-a.json",
        "template-b.json",
      ];
      const addon = createAddonJson({
        installation: {
          post_start: ["addon-template.json"],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual([
        "template-a.json",
        "template-b.json",
        "addon-template.json",
      ]);
    });

    it("should insert template before specified template", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "template-a.json",
        "template-b.json",
      ];
      const addon = createAddonJson({
        installation: {
          post_start: [
            { name: "addon-template.json", before: "template-b.json" },
          ],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual([
        "template-a.json",
        "addon-template.json",
        "template-b.json",
      ]);
    });

    it("should insert template after specified template", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "template-a.json",
        "template-b.json",
      ];
      const addon = createAddonJson({
        installation: {
          post_start: [
            { name: "addon-template.json", after: "template-a.json" },
          ],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual([
        "template-a.json",
        "addon-template.json",
        "template-b.json",
      ]);
    });

    it("should append template when before reference not found", () => {
      const baseTemplates: AddonTemplateReference[] = ["template-a.json"];
      const addon = createAddonJson({
        installation: {
          post_start: [
            { name: "addon-template.json", before: "non-existent.json" },
          ],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual(["template-a.json", "addon-template.json"]);
    });

    it("should return original templates when addon has no templates for phase", () => {
      const baseTemplates: AddonTemplateReference[] = ["template-a.json"];
      const addon = createAddonJson({
        installation: {
          pre_start: ["pre-template.json"],
          // no post_start
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual(["template-a.json"]);
    });

    it("should handle multiple addon templates", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "a.json",
        "b.json",
        "c.json",
      ];
      const addon = createAddonJson({
        installation: {
          post_start: [
            { name: "first.json", before: "b.json" },
            { name: "second.json", after: "b.json" },
            "third.json",
          ],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual([
        "a.json",
        "first.json",
        "b.json",
        "second.json",
        "c.json",
        "third.json",
      ]);
    });

    it("should handle upgrade templates (flat array)", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "template-a.json",
        "template-b.json",
      ];
      const addon = createAddonJson({
        upgrade: ["upgrade-template.json"],
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "upgrade",
      );

      expect(result).toEqual([
        "template-a.json",
        "template-b.json",
        "upgrade-template.json",
      ]);
    });

    it("should handle reconfigure templates", () => {
      const baseTemplates: AddonTemplateReference[] = ["template-a.json"];
      const addon = createAddonJson({
        reconfigure: {
          pre_start: ["reconfig-pre.json"],
          post_start: ["reconfig-post.json"],
        },
      });

      const resultPre = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "reconfigure",
        "pre_start",
      );
      const resultPost = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "reconfigure",
        "post_start",
      );

      expect(resultPre).toEqual(["template-a.json", "reconfig-pre.json"]);
      expect(resultPost).toEqual(["template-a.json", "reconfig-post.json"]);
    });
  });

  describe("getTemplateName()", () => {
    it("should return string template as-is", () => {
      expect(service.getTemplateName("template.json")).toBe("template.json");
    });

    it("should extract name from object template", () => {
      expect(
        service.getTemplateName({
          name: "template.json",
          before: "other.json",
        }),
      ).toBe("template.json");
    });
  });

  describe("extractAddonParameters() with parameterOverrides", () => {
    it("should override parameter name and description", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "override-test.json",
        createAddonJson({
          name: "Override Test Addon",
          notes_key: "override-test",
          parameters: [
            {
              id: "generic_file",
              name: "Generic File",
              type: "string",
              upload: true,
              description: "A generic file upload",
            },
            {
              id: "other_param",
              name: "Other Parameter",
              type: "string",
              description: "Another parameter",
            },
          ],
          parameterOverrides: [
            {
              id: "generic_file",
              name: "Samba Configuration File",
              description: "Upload your smb.conf file",
            },
          ],
        }),
      );

      const addon = service.getAddon("override-test");
      const result = service.extractAddonParameters(addon);

      // Check that the overridden parameter has new name and description
      const overriddenParam = result.parameters?.find(
        (p) => p.id === "generic_file",
      );
      expect(overriddenParam).toBeDefined();
      expect(overriddenParam?.name).toBe("Samba Configuration File");
      expect(overriddenParam?.description).toBe("Upload your smb.conf file");

      // Check that other parameters are unchanged
      const otherParam = result.parameters?.find((p) => p.id === "other_param");
      expect(otherParam).toBeDefined();
      expect(otherParam?.name).toBe("Other Parameter");
      expect(otherParam?.description).toBe("Another parameter");
    });

    it("should only override name when description is not provided", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "partial-override.json",
        createAddonJson({
          name: "Partial Override Addon",
          notes_key: "partial-override",
          parameters: [
            {
              id: "config_file",
              name: "Config File",
              type: "string",
              description: "Original description",
            },
          ],
          parameterOverrides: [
            {
              id: "config_file",
              name: "MQTT Configuration",
              // no description override
            },
          ],
        }),
      );

      const addon = service.getAddon("partial-override");
      const result = service.extractAddonParameters(addon);

      const param = result.parameters?.find((p) => p.id === "config_file");
      expect(param?.name).toBe("MQTT Configuration");
      expect(param?.description).toBe("Original description");
    });
  });

  describe("required_parameters", () => {
    it("should include required_parameters in loaded addon", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-test.json",
        createAddonJson({
          required_parameters: ["http_port", "https_port"],
        }),
      );
      const addon = service.getAddon("ssl-test");
      expect(addon.required_parameters).toEqual(["http_port", "https_port"]);
    });

    it("should return required_parameters as undefined when not set", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "no-req-params.json",
        createAddonJson(),
      );
      const addon = service.getAddon("no-req-params");
      expect(addon.required_parameters).toBeUndefined();
    });
  });
});
