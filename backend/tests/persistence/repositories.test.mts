import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileSystemRepositories } from "@src/persistence/repositories.mjs";
import { FileSystemPersistence } from "@src/persistence/filesystem-persistence.mjs";
import { TemplateResolver } from "@src/templates/template-resolver.mjs";
import type { IConfiguredPathes } from "@src/backend-types.mjs";

describe("FileSystemRepositories", () => {
  let tempDir: string;
  let pathes: IConfiguredPathes;
  let persistence: FileSystemPersistence;
  let repositories: FileSystemRepositories;

  beforeEach(() => {
    // Create temp directory structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-test-"));

    // Create directory structure
    const jsonPath = path.join(tempDir, "json");
    const localPath = path.join(tempDir, "local");
    const schemaPath = path.join(tempDir, "schemas");

    fs.mkdirSync(
      path.join(jsonPath, "applications", "child-app", "templates"),
      { recursive: true },
    );
    fs.mkdirSync(
      path.join(jsonPath, "applications", "parent-app", "templates"),
      { recursive: true },
    );
    fs.mkdirSync(
      path.join(jsonPath, "applications", "grandparent-app", "templates"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(jsonPath, "shared", "templates"), {
      recursive: true,
    });
    fs.mkdirSync(localPath, { recursive: true });
    fs.mkdirSync(schemaPath, { recursive: true });

    pathes = { jsonPath, localPath, schemaPath };
    persistence = new FileSystemPersistence(pathes);
    repositories = new FileSystemRepositories(pathes, persistence, false); // disable cache for tests
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolveTemplateRef with application hierarchy", () => {
    it("should find template in direct application directory", () => {
      // Setup: child-app with a template
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "templates",
          "child-template.json",
        ),
        JSON.stringify({ name: "Child Template" }),
      );

      const ref = repositories.resolveTemplateRef(
        "child-app",
        "child-template",
        "root",
      );

      expect(ref).not.toBeNull();
      expect(ref!.name).toBe("child-template");
      expect(ref!.scope).toBe("application");
      expect(ref!.applicationId).toBe("child-app");
    });

    it("should find template in parent application via extends", () => {
      // Setup: child-app extends parent-app, template is in parent-app
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App", extends: "parent-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "application.json",
        ),
        JSON.stringify({ name: "Parent App" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "templates",
          "parent-template.json",
        ),
        JSON.stringify({ name: "Parent Template" }),
      );

      const ref = repositories.resolveTemplateRef(
        "child-app",
        "parent-template",
        "root",
      );

      expect(ref).not.toBeNull();
      expect(ref!.name).toBe("parent-template");
      expect(ref!.scope).toBe("application");
      expect(ref!.applicationId).toBe("parent-app"); // Found in parent
    });

    it("should find template in grandparent application via extends chain", () => {
      // Setup: child-app -> parent-app -> grandparent-app
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App", extends: "parent-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "application.json",
        ),
        JSON.stringify({ name: "Parent App", extends: "grandparent-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "grandparent-app",
          "application.json",
        ),
        JSON.stringify({ name: "Grandparent App" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "grandparent-app",
          "templates",
          "grandparent-template.json",
        ),
        JSON.stringify({ name: "Grandparent Template" }),
      );

      const ref = repositories.resolveTemplateRef(
        "child-app",
        "grandparent-template",
        "root",
      );

      expect(ref).not.toBeNull();
      expect(ref!.name).toBe("grandparent-template");
      expect(ref!.scope).toBe("application");
      expect(ref!.applicationId).toBe("grandparent-app"); // Found in grandparent
    });

    it("should prefer child template over parent template with same name", () => {
      // Setup: both child and parent have template with same name
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App", extends: "parent-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "application.json",
        ),
        JSON.stringify({ name: "Parent App" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "templates",
          "common-template.json",
        ),
        JSON.stringify({ name: "Child Version" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "templates",
          "common-template.json",
        ),
        JSON.stringify({ name: "Parent Version" }),
      );

      const ref = repositories.resolveTemplateRef(
        "child-app",
        "common-template",
        "root",
      );

      expect(ref).not.toBeNull();
      expect(ref!.applicationId).toBe("child-app"); // Child wins
    });

    it("should fall back to shared templates if not found in hierarchy", () => {
      // Setup: child-app extends parent-app, but template is in shared
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App", extends: "parent-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "application.json",
        ),
        JSON.stringify({ name: "Parent App" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "shared",
          "templates",
          "shared-template.json",
        ),
        JSON.stringify({ name: "Shared Template" }),
      );

      const ref = repositories.resolveTemplateRef(
        "child-app",
        "shared-template",
        "root",
      );

      expect(ref).not.toBeNull();
      expect(ref!.name).toBe("shared-template");
      expect(ref!.scope).toBe("shared");
      expect(ref!.applicationId).toBeUndefined();
    });

    it("should return null for non-existent template", () => {
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App" }),
      );

      const ref = repositories.resolveTemplateRef("child-app", "non-existent", "root");

      expect(ref).toBeNull();
    });

    it("should handle cyclic extends gracefully", () => {
      // Setup: child-app -> parent-app -> child-app (cycle)
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "application.json",
        ),
        JSON.stringify({ name: "Child App", extends: "parent-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "parent-app",
          "application.json",
        ),
        JSON.stringify({ name: "Parent App", extends: "child-app" }),
      );
      fs.writeFileSync(
        path.join(
          pathes.jsonPath,
          "applications",
          "child-app",
          "templates",
          "test-template.json",
        ),
        JSON.stringify({ name: "Test Template" }),
      );

      // Should not infinite loop - visited set prevents cycles
      const ref = repositories.resolveTemplateRef("child-app", "test-template", "root");

      expect(ref).not.toBeNull();
      expect(ref!.applicationId).toBe("child-app");
    });
  });

  describe("resolveScriptContent — app-specific script overrides shared", () => {
    it("should find app-specific script over shared script (same category)", () => {
      // Setup: shared script in post_start/
      fs.mkdirSync(path.join(pathes.jsonPath, "shared", "scripts", "post_start"), { recursive: true });
      fs.writeFileSync(
        path.join(pathes.jsonPath, "shared", "scripts", "post_start", "my-script.sh"),
        "#!/bin/sh\necho shared",
      );

      // Setup: app-specific override in post_start/
      fs.mkdirSync(path.join(pathes.jsonPath, "applications", "child-app", "scripts", "post_start"), { recursive: true });
      fs.writeFileSync(
        path.join(pathes.jsonPath, "applications", "child-app", "scripts", "post_start", "my-script.sh"),
        "#!/bin/sh\necho app-specific",
      );
      fs.writeFileSync(
        path.join(pathes.jsonPath, "applications", "child-app", "application.json"),
        JSON.stringify({ name: "Child App" }),
      );

      // Import TemplateResolver to use resolveScriptContent
      const resolver = new TemplateResolver(repositories);
      const result = resolver.resolveScriptContent("child-app", "my-script.sh", "post_start");

      expect(result.content).not.toBeNull();
      expect(result.content).toContain("app-specific");
      expect(result.ref?.scope).toBe("application");
    });

    it("should fall back to shared script when app has no override", () => {
      // Setup: only shared script
      fs.mkdirSync(path.join(pathes.jsonPath, "shared", "scripts", "post_start"), { recursive: true });
      fs.writeFileSync(
        path.join(pathes.jsonPath, "shared", "scripts", "post_start", "my-script.sh"),
        "#!/bin/sh\necho shared",
      );
      fs.writeFileSync(
        path.join(pathes.jsonPath, "applications", "child-app", "application.json"),
        JSON.stringify({ name: "Child App" }),
      );

      const resolver = new TemplateResolver(repositories);
      const result = resolver.resolveScriptContent("child-app", "my-script.sh", "post_start");

      expect(result.content).not.toBeNull();
      expect(result.content).toContain("shared");
    });
  });
});
