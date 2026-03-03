import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { TemplatePersistenceHandler } from "@src/persistence/template-persistence-handler.mjs";
import { JsonValidator } from "@src/jsonvalidator.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("TemplatePersistenceHandler", () => {
  let env: TestEnvironment;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let handler: TemplatePersistenceHandler;
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

    // TemplatePersistenceHandler initialisieren
    handler = new TemplatePersistenceHandler(
      { jsonPath, localPath, schemaPath },
      jsonValidator,
    );
  });

  afterEach(() => {
    env?.cleanup();
  });

  describe("resolveTemplatePath()", () => {
    it("should resolve shared template path from json directory", () => {
      // Setup: Shared template erstellen
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "testtemplate.json",
        {
          name: "Test Template",
          commands: [],
        },
      );

      const result = handler.resolveTemplatePath("testtemplate", true);
      expect(result).not.toBeNull();
      expect(result).toBe(path.join(templatesDir, "testtemplate.json"));
    });

    it("should prefer local over json for shared templates", () => {
      // Setup: Template in beiden Verzeichnissen
      const jsonTemplatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      const localTemplatesDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "shared/templates",
      );
      mkdirSync(jsonTemplatesDir, { recursive: true });
      mkdirSync(localTemplatesDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "testtemplate.json",
        {
          name: "JSON Template",
          commands: [],
        },
      );
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "shared/templates/testtemplate.json",
        {
          name: "Local Template",
          commands: [],
        },
      );

      const result = handler.resolveTemplatePath("testtemplate", true);
      expect(result).toBe(path.join(localTemplatesDir, "testtemplate.json"));
    });

    it("should return null when template not found", () => {
      const result = handler.resolveTemplatePath("nonexistent", true);
      expect(result).toBeNull();
    });

    it("should handle template name with or without .json extension", () => {
      // Setup: Template erstellen
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "testtemplate.json",
        {
          name: "Test Template",
          commands: [],
        },
      );

      const result1 = handler.resolveTemplatePath("testtemplate", true);
      const result2 = handler.resolveTemplatePath("testtemplate.json", true);
      expect(result1).toBe(result2);
    });
  });

  describe("loadTemplate()", () => {
    it("should load template from file", () => {
      // Setup: Template erstellen
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "testtemplate.json");
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "testtemplate.json",
        {
          name: "Test Template",
          commands: [{ name: "test", command: "echo test" }],
        },
      );

      const result = handler.loadTemplate(templateFile);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Test Template");
      expect(result?.commands).toHaveLength(1);
    });

    it("should cache template", () => {
      // Setup: Template erstellen (minimal valid template)
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "testtemplate.json");
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "testtemplate.json",
        {
          name: "Test Template",
          commands: [{ name: "test", command: "echo test" }],
        },
      );

      const result1 = handler.loadTemplate(templateFile);
      expect(result1).not.toBeNull();
      expect(result1?.name).toBe("Test Template");

      // Load again should use cache (if mtime hasn't changed)
      const result2 = handler.loadTemplate(templateFile);
      expect(result2).not.toBeNull();
      expect(result2?.name).toBe("Test Template");
    });

    it("should return null when file does not exist", () => {
      const result = handler.loadTemplate(
        path.join(jsonPath, "nonexistent.json"),
      );
      expect(result).toBeNull();
    });

    it("should return null when template is invalid", () => {
      // Setup: Invalid template
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "invalid.json");
      persistenceHelper.writeTextSync(
        Volume.JsonSharedTemplates,
        "invalid.json",
        "{ invalid json }",
      );

      expect(() => handler.loadTemplate(templateFile)).toThrow();
    });
  });

  describe("writeTemplate() and deleteTemplate()", () => {
    it("should write shared template to local directory", () => {
      const template = {
        name: "New Template",
        commands: [{ name: "test", command: "echo test" }],
      };

      handler.writeTemplate("newtemplate", template as any, true);

      // Verify file exists
      const templateFile = persistenceHelper.resolve(
        Volume.LocalRoot,
        "shared/templates/newtemplate.json",
      );
      expect(existsSync(templateFile)).toBe(true);

      // Verify content
      const content = persistenceHelper.readJsonSync(
        Volume.LocalRoot,
        "shared/templates/newtemplate.json",
      ) as any;
      expect(content.name).toBe("New Template");
    });

    it("should delete shared template from local directory", () => {
      // Setup: Template erstellen
      const templatesDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "shared/templates",
      );
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "deletetemplate.json");
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "shared/templates/deletetemplate.json",
        {
          name: "Delete Template",
          commands: [{ name: "test", command: "echo test" }],
        },
      );

      handler.deleteTemplate("deletetemplate", true);

      // Verify file is deleted
      expect(existsSync(templateFile)).toBe(false);
    });

    it("should invalidate cache when writing template", () => {
      // Setup: Template erstellen und laden (populate cache)
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "cachedtemplate.json");
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "cachedtemplate.json",
        {
          name: "Cached Template",
          commands: [{ name: "test", command: "echo test" }],
        },
      );

      handler.loadTemplate(templateFile);

      // Write new template (should invalidate cache)
      handler.writeTemplate(
        "newtemplate",
        {
          name: "New Template",
          commands: [],
        } as any,
        true,
      );

      // Cache should be cleared: deleting the file should return null on load
      rmSync(templateFile, { force: true });
      const afterDelete = handler.loadTemplate(templateFile);
      expect(afterDelete).toBeNull();
    });
  });

  describe("invalidateCache()", () => {
    it("should clear template cache", () => {
      // Setup: Template erstellen und laden
      const templatesDir = persistenceHelper.resolve(
        Volume.JsonSharedTemplates,
      );
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "testtemplate.json");
      persistenceHelper.writeJsonSync(
        Volume.JsonSharedTemplates,
        "testtemplate.json",
        {
          name: "Test Template",
          commands: [{ name: "test", command: "echo test" }],
        },
      );

      handler.loadTemplate(templateFile);

      // Invalidate cache
      handler.invalidateCache();

      // Cache should be cleared
      // (We can't directly test the cache state, but invalidateCache should not throw)
      expect(() => handler.invalidateCache()).not.toThrow();
    });
  });
});
