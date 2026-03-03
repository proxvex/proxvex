import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, statSync, existsSync, rmSync } from "fs";
import path from "path";
import { ApplicationPersistenceHandler } from "@src/persistence/application-persistence-handler.mjs";
import { JsonValidator } from "@src/jsonvalidator.mjs";
import {
  IReadApplicationOptions,
  ITemplateReference,
  VEConfigurationError,
} from "@src/backend-types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

// Helper to extract template names from templates array (which may contain strings or ITemplateReference objects)
function getTemplateNames(
  templates: (ITemplateReference | string)[] | undefined,
): string[] {
  if (!templates) return [];
  return templates.map((t) => (typeof t === "string" ? t : t.name));
}

describe("ApplicationPersistenceHandler", () => {
  let env: TestEnvironment;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let handler: ApplicationPersistenceHandler;
  let jsonValidator: JsonValidator;
  let persistenceHelper: TestPersistenceHelper;

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

    // JsonValidator initialisieren (benötigt Schemas)
    jsonValidator = new JsonValidator(schemaPath, [
      "templatelist.schema.json",
      "base-deployable.schema.json",
    ]);

    // ApplicationPersistenceHandler initialisieren
    handler = new ApplicationPersistenceHandler(
      { jsonPath, localPath, schemaPath },
      jsonValidator,
    );
  });

  afterEach(() => {
    env?.cleanup();
  });

  describe("getAllAppNames()", () => {
    it("should return empty map when no applications exist", () => {
      const result = handler.getAllAppNames();
      expect(result.size).toBe(0);
    });

    it("should find applications in json directory", () => {
      // Setup: Application in json-Verzeichnis erstellen
      const appDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "testapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "testapp/application.json",
        {
          name: "Test App",
          installation: {},
        },
      );

      const result = handler.getAllAppNames();
      expect(result.size).toBe(1);
      expect(result.has("testapp")).toBe(true);
      expect(result.get("testapp")).toBe(appDir);
    });

    it("should find applications in local directory", () => {
      // Setup: Application in local-Verzeichnis erstellen
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/localapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/localapp/application.json",
        {
          name: "Local App",
          installation: {},
        },
      );

      const result = handler.getAllAppNames();
      expect(result.size).toBe(1);
      expect(result.has("localapp")).toBe(true);
    });

    it("should prefer local over json when same name exists", () => {
      // Setup: Application in beiden Verzeichnissen
      const jsonAppDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "duplicate",
      );
      const localAppDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/duplicate",
      );
      mkdirSync(jsonAppDir, { recursive: true });
      mkdirSync(localAppDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "duplicate/application.json",
        {
          name: "JSON App",
          installation: {},
        },
      );
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/duplicate/application.json",
        {
          name: "Local App",
          installation: {},
        },
      );

      const result = handler.getAllAppNames();
      expect(result.size).toBe(1);
      expect(result.get("duplicate")).toBe(localAppDir); // Local hat Priorität
    });

    it("should cache json directory (only loaded once)", () => {
      // Erster Aufruf
      const result1 = handler.getAllAppNames();

      // Application hinzufügen NACH erstem Aufruf
      const appDir = path.join(jsonPath, "applications", "newapp");
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "newapp/application.json",
        {
          name: "New App",
          installation: {},
        },
      );

      // Zweiter Aufruf sollte noch alte Daten haben (Cache)
      const result2 = handler.getAllAppNames();
      expect(result2.size).toBe(result1.size); // Keine neue Application
      expect(result2.has("newapp")).toBe(false);
    });
  });

  describe("listApplicationsForFrontend()", () => {
    it("should return empty array when no applications exist", () => {
      const result = handler.listApplicationsForFrontend();
      expect(result).toEqual([]);
    });

    it("should return applications with basic info", () => {
      // Setup: Application erstellen
      const appDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "testapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "testapp/application.json",
        {
          name: "Test App",
          description: "Test Description",
          installation: {},
        },
      );

      const result = handler.listApplicationsForFrontend();
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Test App");
      expect(result[0]?.description).toBe("Test Description");
      expect(result[0]?.id).toBe("testapp");
    });

    it("should cache the result", () => {
      // Setup: Application erstellen
      const appDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "testapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "testapp/application.json",
        {
          name: "Test App",
          installation: {},
        },
      );

      const result1 = handler.listApplicationsForFrontend();
      expect(result1.length).toBe(1);

      // Neue Application hinzufügen (sollte nicht erscheinen wegen Cache)
      const appDir2 = path.join(jsonPath, "applications", "newapp");
      mkdirSync(appDir2, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "newapp/application.json",
        {
          name: "New App",
          installation: {},
        },
      );

      const result2 = handler.listApplicationsForFrontend();
      expect(result2.length).toBe(1); // Noch gecacht
    });
  });

  describe("readApplication()", () => {
    it("should read application from json directory", () => {
      // Setup: Application erstellen
      const appDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "testapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "testapp/application.json",
        {
          name: "Test App",
          description: "Test Description",
          installation: { post_start: ["template1.json"] },
        },
      );

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "testapp"),
        taskTemplates: [],
      };

      const result = handler.readApplication("testapp", opts);
      expect(result.name).toBe("Test App");
      expect(result.description).toBe("Test Description");
      expect(result.id).toBe("testapp");
    });

    it("should handle inheritance", () => {
      // Setup: Parent Application
      const parentDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "baseapp",
      );
      mkdirSync(parentDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "baseapp/application.json",
        {
          name: "Base App",
          installation: { post_start: ["base-template.json"] },
        },
      );

      // Setup: Child Application
      const childDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/childapp",
      );
      mkdirSync(childDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/childapp/application.json",
        {
          name: "Child App",
          extends: "baseapp",
          installation: { post_start: ["child-template.json"] },
        },
      );

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "childapp"),
        taskTemplates: [],
      };

      const result = handler.readApplication("childapp", opts);
      expect(result.name).toBe("Child App");
      expect(result.extends).toBe("baseapp");

      // Check that templates are processed
      const installationTemplates = opts.taskTemplates.find(
        (t) => t.task === "installation",
      );
      expect(installationTemplates).toBeDefined();
      const templateNames = getTemplateNames(installationTemplates?.templates);
      expect(templateNames).toContain("base-template.json");
      expect(templateNames).toContain("child-template.json");
    });

    it("should insert child templates into correct category position", () => {
      // Setup: Parent Application with pre_start AND post_start
      const parentDir = persistenceHelper.resolve(
        Volume.JsonApplications,
        "parent-app",
      );
      mkdirSync(parentDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonApplications,
        "parent-app/application.json",
        {
          name: "Parent App",
          installation: {
            pre_start: ["100-parent-pre-start.json"],
            post_start: ["300-parent-post-start.json"],
          },
        },
      );

      // Setup: Child Application with ONLY pre_start
      // These should be inserted AFTER parent pre_start but BEFORE parent post_start
      const childDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/child-app",
      );
      mkdirSync(childDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/child-app/application.json",
        {
          name: "Child App",
          extends: "parent-app",
          installation: {
            pre_start: ["0-child-pre-start.json", "1-child-pre-start-2.json"],
          },
        },
      );

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "child-app"),
        taskTemplates: [],
      };

      handler.readApplication("child-app", opts);

      // Check template order
      const installationTemplates = opts.taskTemplates.find(
        (t) => t.task === "installation",
      );
      expect(installationTemplates).toBeDefined();
      const templateNames = getTemplateNames(installationTemplates?.templates);

      // Expected order:
      // 1. Parent pre_start: 100-parent-pre-start.json
      // 2. Child pre_start: 0-child-pre-start.json, 1-child-pre-start-2.json (inserted in pre_start category)
      // 3. Parent post_start: 300-parent-post-start.json
      expect(templateNames).toEqual([
        "100-parent-pre-start.json",
        "0-child-pre-start.json",
        "1-child-pre-start-2.json",
        "300-parent-post-start.json",
      ]);

      // Verify child pre_start templates come BEFORE post_start
      const childPreStartIndex = templateNames.indexOf("0-child-pre-start.json");
      const postStartIndex = templateNames.indexOf("300-parent-post-start.json");
      expect(childPreStartIndex).toBeLessThan(postStartIndex);
    });

    it("should detect cyclic inheritance", () => {
      // Setup: Application that extends itself
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/cyclicapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/cyclicapp/application.json",
        {
          name: "Cyclic App",
          extends: "cyclicapp",
          installation: {},
        },
      );

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "cyclicapp"),
        taskTemplates: [],
      };

      // First call adds to hierarchy, second call should detect cycle
      expect(() => {
        handler.readApplication("cyclicapp", opts);
        // Second call with same appPath in hierarchy should throw
        handler.readApplication("cyclicapp", opts);
      }).toThrow("Cyclic inheritance");
    });

    it("should load icon if present", () => {
      // Setup: Application with icon
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/iconapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/iconapp/application.json",
        {
          name: "Icon App",
          icon: "icon.png",
          installation: {},
        },
      );

      // Create icon file (just a dummy file)
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "applications/iconapp/icon.png",
        "dummy icon data",
      );

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "iconapp"),
        taskTemplates: [],
      };

      const result = handler.readApplication("iconapp", opts);
      expect(result.icon).toBe("icon.png");
      expect(result.iconContent).toBeDefined();
      expect(result.iconType).toBe("image/png");
    });
  });

  describe("readApplicationIcon()", () => {
    it("should return null when application not found", () => {
      const result = handler.readApplicationIcon("nonexistent");
      expect(result).toBeNull();
    });

    it("should return icon data when icon exists", () => {
      // Setup: Application with icon
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/iconapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/iconapp/application.json",
        {
          name: "Icon App",
          installation: {},
        },
      );
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "applications/iconapp/icon.png",
        "dummy icon data",
      );

      const result = handler.readApplicationIcon("iconapp");
      expect(result).not.toBeNull();
      expect(result?.iconContent).toBeDefined();
      expect(result?.iconType).toBe("image/png");
    });

    it("should prefer png over svg", () => {
      // Setup: Application with both icons
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/bothicons",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/bothicons/application.json",
        {
          name: "Both Icons App",
          installation: {},
        },
      );
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "applications/bothicons/icon.png",
        "png data",
      );
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "applications/bothicons/icon.svg",
        "svg data",
      );

      const result = handler.readApplicationIcon("bothicons");
      expect(result).not.toBeNull();
      expect(result?.iconType).toBe("image/png"); // png comes first
    });
  });

  describe("writeApplication() and deleteApplication()", () => {
    it("should write application to local directory", () => {
      const application = {
        name: "New App",
        description: "New Description",
        installation: {},
      };

      handler.writeApplication("newapp", application as any);

      // Verify file exists
      const appFile = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/newapp/application.json",
      );
      expect(statSync(appFile).isFile()).toBe(true);

      // Verify content
      const content = persistenceHelper.readJsonSync(
        Volume.LocalRoot,
        "applications/newapp/application.json",
      ) as any;
      expect(content.name).toBe("New App");
    });

    it("should delete application from local directory", () => {
      // Setup: Application erstellen
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/deleteapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/deleteapp/application.json",
        {
          name: "Delete App",
          installation: {},
        },
      );

      handler.deleteApplication("deleteapp");

      // Verify directory is deleted
      expect(existsSync(appDir)).toBe(false);
    });
  });

  describe("invalidateApplicationCache()", () => {
    it("should invalidate application cache", () => {
      // Setup: Application in local erstellen
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/testapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/testapp/application.json",
        {
          name: "Test App",
          installation: {},
        },
      );

      // Populate cache
      handler.getAllAppNames();
      handler.listApplicationsForFrontend();
      expect(handler.getAllAppNames().has("testapp")).toBe(true);

      // Invalidate
      handler.invalidateApplicationCache();

      // Delete application
      rmSync(appDir, { recursive: true, force: true });

      // Should not see deleted app anymore
      const result = handler.getAllAppNames();
      expect(result.has("testapp")).toBe(false);
    });
  });
});
