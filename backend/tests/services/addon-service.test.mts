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
    notes_key: "test-addon",
    ...overrides,
  });

  // Helper to create an inline addon object with id (for isAddonCompatible tests)
  const createInlineAddon = (
    id: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    ...createAddonJson(overrides),
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
      "categorized-templatelist.schema.json",
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

    it("should load addon with disable configuration", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "disable-addon.json",
        createAddonJson({
          name: "Disable Test Addon",
          notes_key: "disable-test",
          disable: {
            post_start: ["disable-cleanup.json"],
          },
        }),
      );

      const result = service.getAddon("disable-addon");
      expect(result.name).toBe("Disable Test Addon");
      expect(result.disable).toBeDefined();
      expect(result.disable?.post_start).toEqual(["disable-cleanup.json"]);
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
    it("should return true when addon ID is in supported_addons", () => {
      const addon = createInlineAddon("test-addon");
      const app = createApplication({
        id: "my-app",
        supported_addons: ["test-addon", "other-addon"],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should return false when addon ID is not in supported_addons", () => {
      const addon = createInlineAddon("test-addon");
      const app = createApplication({
        id: "my-app",
        supported_addons: ["other-addon"],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(false);
    });

    it("should return false when supported_addons is empty", () => {
      const addon = createInlineAddon("test-addon");
      const app = createApplication({
        id: "my-app",
        supported_addons: [],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(false);
    });

    it("should return false when supported_addons is undefined", () => {
      const addon = createInlineAddon("test-addon");
      const app = createApplication({ id: "my-app" });

      expect(service.isAddonCompatible(addon, app)).toBe(false);
    });
  });

  describe("getCompatibleAddons()", () => {
    it("should return only addons listed in supported_addons", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "addon-ssl.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "addon-ssl",
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "addon-oidc.json",
        createAddonJson({
          name: "OIDC Addon",
          notes_key: "addon-oidc",
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "samba-shares.json",
        createAddonJson({
          name: "Samba Addon",
          notes_key: "samba-shares",
        }),
      );

      const app = createApplication({
        id: "my-app",
        supported_addons: ["addon-ssl", "samba-shares"],
      });
      const result = service.getCompatibleAddons(app);

      expect(result).toHaveLength(2);
      expect(result.map((a) => a.name)).toContain("SSL Addon");
      expect(result.map((a) => a.name)).toContain("Samba Addon");
      expect(result.map((a) => a.name)).not.toContain("OIDC Addon");
    });

    it("should return empty when app has no supported_addons", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "some-addon.json",
        createAddonJson({
          name: "Some Addon",
          notes_key: "some-addon",
        }),
      );

      const app = createApplication({ id: "my-app" });
      const result = service.getCompatibleAddons(app);

      expect(result).toHaveLength(0);
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

    it("should prepend template when position is start", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "template-a.json",
        "template-b.json",
      ];
      const addon = createAddonJson({
        installation: {
          post_start: [{ name: "addon-template.json", position: "start" }],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "installation",
        "post_start",
      );

      expect(result).toEqual([
        "addon-template.json",
        "template-a.json",
        "template-b.json",
      ]);
    });

    it("should append template when position is end", () => {
      const baseTemplates: AddonTemplateReference[] = [
        "template-a.json",
        "template-b.json",
      ];
      const addon = createAddonJson({
        installation: {
          post_start: [{ name: "addon-template.json", position: "end" }],
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

    it("should preserve insertion order when multiple templates use position end", () => {
      const baseTemplates: AddonTemplateReference[] = ["template-a.json"];
      const addon = createAddonJson({
        installation: {
          post_start: [
            { name: "x.json", position: "end" },
            { name: "y.json", position: "end" },
            { name: "z.json", position: "end" },
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
        "x.json",
        "y.json",
        "z.json",
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

    it("should handle disable templates", () => {
      const baseTemplates: AddonTemplateReference[] = ["template-a.json"];
      const addon = createAddonJson({
        disable: {
          post_start: ["disable-cleanup.json"],
        },
      });

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "disable",
        "post_start",
      );

      expect(result).toEqual(["template-a.json", "disable-cleanup.json"]);
    });

    it("should return base templates when addon has no disable config", () => {
      const baseTemplates: AddonTemplateReference[] = ["template-a.json"];
      const addon = createAddonJson({});

      const result = service.mergeAddonTemplates(
        baseTemplates,
        addon,
        "disable",
        "post_start",
      );

      expect(result).toEqual(["template-a.json"]);
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

  describe("getCompatibleAddonsWithParameters() - app parameter filtering", () => {
    it("should remove addon parameters that the app sets via properties with value", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-filter.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-filter",

          parameters: [
            { id: "http_port", name: "HTTP Port", type: "string", required: true },
            { id: "local_https_port", name: "HTTPS Port", type: "string", required: true },
            { id: "ssl.mode", name: "SSL Mode", type: "enum", required: true, default: "proxy" },
            { id: "ssl.cert", name: "Certificate", type: "string" },
            { id: "ssl.key", name: "Key", type: "string" },
          ],
        }),
      );

      const app = createApplication({
        id: "native-app",
        supported_addons: ["ssl-filter"],
        parameters: [
          { id: "http_port", name: "HTTP Port", type: "string" },
          { id: "local_https_port", name: "HTTPS Port", type: "string" },
        ],
        properties: [
          { id: "ssl.mode", value: "native" },
        ],
      });

      const result = service.getCompatibleAddonsWithParameters(app);
      expect(result).toHaveLength(1);
      const paramIds = result[0].parameters?.map((p) => p.id) ?? [];
      // http_port, local_https_port filtered because app defines them as parameters
      expect(paramIds).not.toContain("http_port");
      expect(paramIds).not.toContain("local_https_port");
      // ssl.mode filtered because app defines it as property with value
      expect(paramIds).not.toContain("ssl.mode");
      // These remain because the app doesn't define them
      expect(paramIds).toContain("ssl.cert");
      expect(paramIds).toContain("ssl.key");
    });

    it("should remove addon parameters that match app parameters (not just properties)", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-nofilter.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-nofilter",

          parameters: [
            { id: "http_port", name: "HTTP Port", type: "string", required: true },
            { id: "local_https_port", name: "HTTPS Port", type: "string", required: true },
            { id: "ssl.mode", name: "SSL Mode", type: "enum", required: true },
            { id: "ssl.cert", name: "Certificate", type: "string" },
          ],
        }),
      );

      const app = createApplication({
        id: "generic-app",
        supported_addons: ["ssl-nofilter"],
        parameters: [
          { id: "http_port", name: "HTTP Port", type: "string" },
          { id: "local_https_port", name: "HTTPS Port", type: "string" },
        ],
      });

      const result = service.getCompatibleAddonsWithParameters(app);
      expect(result).toHaveLength(1);
      const paramIds = result[0].parameters?.map((p) => p.id) ?? [];
      // http_port, local_https_port filtered because app already defines them
      expect(paramIds).not.toContain("http_port");
      expect(paramIds).not.toContain("local_https_port");
      // These remain because app doesn't define them
      expect(paramIds).toContain("ssl.mode");
      expect(paramIds).toContain("ssl.cert");
    });

    it("should keep all addon parameters when app has no matching parameters or properties", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-keepall.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-keepall",

          parameters: [
            { id: "http_port", name: "HTTP Port", type: "string", required: true },
            { id: "local_https_port", name: "HTTPS Port", type: "string", required: true },
            { id: "ssl.mode", name: "SSL Mode", type: "enum", required: true },
          ],
        }),
      );

      // App with NO matching parameters or properties but addon in supported_addons
      const app = createApplication({
        id: "minimal-app",
        supported_addons: ["ssl-keepall"],
      });

      const result = service.getCompatibleAddonsWithParameters(app);
      expect(result).toHaveLength(1);
      const paramIds = result[0].parameters?.map((p) => p.id) ?? [];
      // All addon parameters shown because app doesn't define any of them
      expect(paramIds).toContain("http_port");
      expect(paramIds).toContain("local_https_port");
      expect(paramIds).toContain("ssl.mode");
    });

    it("should not filter parameters set via properties with default (only value)", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-default.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-default",

          parameters: [
            { id: "ssl.mode", name: "SSL Mode", type: "enum", required: true },
          ],
        }),
      );

      const app = createApplication({
        id: "default-app",
        supported_addons: ["ssl-default"],
        properties: [
          { id: "ssl.mode", default: "proxy" },
        ],
      });

      const result = service.getCompatibleAddonsWithParameters(app);
      expect(result).toHaveLength(1);
      const paramIds = result[0].parameters?.map((p) => p.id) ?? [];
      expect(paramIds).toContain("ssl.mode");
    });
  });

  describe("getCompatibleAddonsWithParameters() - installed addons inclusion", () => {
    it("should include installed addons even if not compatible", () => {
      // SSL addon requires http_port/local_https_port
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-installed.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-installed",

          required_parameters: ["http_port", "local_https_port"],
          parameters: [
            { id: "ssl.mode", name: "SSL Mode", type: "enum", required: true },
          ],
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "basic-installed.json",
        createAddonJson({
          name: "Basic Addon",
          notes_key: "basic-installed",

        }),
      );

      // App supports both addons but SSL fails required_parameters check
      const app = createApplication({
        id: "simple-app",
        supported_addons: ["ssl-installed", "basic-installed"],
      });

      // Without installed IDs: only basic addon returned (SSL fails required_parameters)
      const withoutInstalled = service.getCompatibleAddonsWithParameters(app);
      expect(withoutInstalled.map((a) => a.name)).toContain("Basic Addon");
      expect(withoutInstalled.map((a) => a.name)).not.toContain("SSL Addon");

      // With installed IDs: SSL addon is included despite failing required_parameters
      const withInstalled = service.getCompatibleAddonsWithParameters(app, ["ssl-installed"]);
      expect(withInstalled.map((a) => a.name)).toContain("Basic Addon");
      expect(withInstalled.map((a) => a.name)).toContain("SSL Addon");
    });

    it("should not duplicate addons that are both compatible and installed", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "both-addon.json",
        createAddonJson({
          name: "Both Addon",
          notes_key: "both-addon",

        }),
      );

      const app = createApplication({
        id: "test-app",
        supported_addons: ["both-addon"],
      });
      const result = service.getCompatibleAddonsWithParameters(app, ["both-addon"]);
      expect(result.filter((a) => a.name === "Both Addon")).toHaveLength(1);
    });

    it("should skip non-existent installed addon IDs gracefully", () => {
      const app = createApplication({ id: "test-app" });
      const result = service.getCompatibleAddonsWithParameters(app, ["non-existent-addon"]);
      expect(result).toHaveLength(0);
    });
  });

  describe("required_parameters", () => {
    it("should include required_parameters in loaded addon", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-test.json",
        createAddonJson({
          required_parameters: ["http_port", "local_https_port"],
        }),
      );
      const addon = service.getAddon("ssl-test");
      expect(addon.required_parameters).toEqual(["http_port", "local_https_port"]);
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

    it("should be compatible when app has supported_addons and required_parameters met", () => {
      const addon = createInlineAddon("test-addon", {
        required_parameters: ["http_port", "local_https_port"],
      });
      const app = createApplication({
        id: "proxvex",
        supported_addons: ["test-addon"],
        parameters: [
          { id: "http_port", name: "HTTP Port", type: "string", default: "3000" },
          { id: "local_https_port", name: "HTTPS Port", type: "string", default: "3443" },
        ],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should be compatible when app defines required_parameters as properties", () => {
      const addon = createInlineAddon("test-addon", {
        required_parameters: ["http_port", "local_https_port"],
      });
      const app = createApplication({
        id: "proxvex",
        supported_addons: ["test-addon"],
        properties: [
          { id: "http_port", value: "{{http_port}}" },
          { id: "local_https_port", value: "{{local_https_port}}" },
        ],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(true);
    });

    it("should be incompatible when app is missing a required parameter", () => {
      const addon = createInlineAddon("test-addon", {
        required_parameters: ["http_port", "local_https_port"],
      });
      const app = createApplication({
        id: "simple-app",
        supported_addons: ["test-addon"],
        parameters: [
          { id: "http_port", name: "HTTP Port", type: "string" },
        ],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(false);
    });

    it("should be incompatible when app has no parameters at all", () => {
      const addon = createInlineAddon("test-addon", {
        required_parameters: ["http_port"],
      });
      const app = createApplication({
        id: "minimal-app",
        supported_addons: ["test-addon"],
      });

      expect(service.isAddonCompatible(addon, app)).toBe(false);
    });

    it("should filter out addons with unmet required_parameters in getCompatibleAddons", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-addon.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-addon",
          required_parameters: ["http_port", "local_https_port"],
        }),
      );
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "basic-addon.json",
        createAddonJson({
          name: "Basic Addon",
          notes_key: "basic-addon",
        }),
      );

      // App supports both addons but lacks http_port/local_https_port - SSL filtered by required_parameters
      const simpleApp = createApplication({
        id: "simple-app",
        supported_addons: ["ssl-addon", "basic-addon"],
      });
      const result = service.getCompatibleAddons(simpleApp);

      expect(result.map((a) => a.name)).toContain("Basic Addon");
      expect(result.map((a) => a.name)).not.toContain("SSL Addon");
    });

    it("should include addons with met required_parameters in getCompatibleAddons", () => {
      persistenceHelper.writeJsonSync(
        Volume.JsonAddons,
        "ssl-addon.json",
        createAddonJson({
          name: "SSL Addon",
          notes_key: "ssl-addon",

          required_parameters: ["http_port", "local_https_port"],
        }),
      );

      const app = createApplication({
        id: "web-app",
        supported_addons: ["ssl-addon"],
        parameters: [
          { id: "http_port", name: "HTTP Port", type: "string" },
          { id: "local_https_port", name: "HTTPS Port", type: "string" },
        ],
      });
      const result = service.getCompatibleAddons(app);

      expect(result.map((a) => a.name)).toContain("SSL Addon");
    });
  });
});
