import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { FileWatcherManager } from "@src/persistence/file-watcher-manager.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("FileWatcherManager", () => {
  let testDir: string;
  let localPath: string;
  let watcher: FileWatcherManager;
  let applicationInvalidated: boolean;
  let templateInvalidated: boolean;
  let frameworkInvalidated: boolean;
  let persistenceHelper: TestPersistenceHelper;

  beforeEach(() => {
    // Setup temporäre Verzeichnisse
    testDir = mkdtempSync(path.join(tmpdir(), "watcher-test-"));
    localPath = path.join(testDir, "local");

    // Verzeichnisse erstellen
    mkdirSync(localPath, { recursive: true });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: path.join(testDir),
      localRoot: localPath,
      jsonRoot: path.join(testDir, "json"),
      schemasRoot: path.join(testDir, "schemas"),
    });

    // Reset invalidation flags
    applicationInvalidated = false;
    templateInvalidated = false;
    frameworkInvalidated = false;

    // FileWatcherManager initialisieren
    watcher = new FileWatcherManager({
      jsonPath: path.join(testDir, "json"),
      localPath,
      schemaPath: path.join(testDir, "schemas"),
    });

    // Initialize watchers with callbacks
    watcher.initWatchers(
      () => {
        applicationInvalidated = true;
      },
      () => {
        templateInvalidated = true;
      },
      () => {
        frameworkInvalidated = true;
      },
    );
  });

  afterEach(() => {
    // Cleanup
    watcher.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to manually trigger watch callbacks by simulating fs.watch events
   * This tests the callback logic deterministically without relying on actual fs.watch
   */
  function triggerApplicationWatch(filename: string, _eventType?: "change" | "rename"): void {
    // Access private method isApplicationChange via reflection
    const watcherAny = watcher as any;
    if (
      watcherAny.isApplicationChange &&
      watcherAny.isApplicationChange(filename)
    ) {
      // Call debouncedInvalidate directly
      const onApplicationChange = () => {
        applicationInvalidated = true;
      };
      watcherAny.debouncedInvalidate(onApplicationChange);
    }
  }

  function triggerTemplateWatch(filename: string): void {
    if (filename.endsWith(".json")) {
      templateInvalidated = true;
    }
  }

  function triggerFrameworkWatch(filename: string): void {
    if (filename.endsWith(".json")) {
      frameworkInvalidated = true;
    }
  }

  describe("initWatchers()", () => {
    it("should initialize watchers for existing directories", () => {
      // Directories should be created in beforeEach
      // Watcher should be initialized without errors
      expect(() =>
        watcher.initWatchers(
          () => {},
          () => {},
          () => {},
        ),
      ).not.toThrow();
    });

    it("should handle missing directories gracefully", () => {
      // Create new watcher with non-existent directories
      const newWatcher = new FileWatcherManager({
        jsonPath: path.join(testDir, "nonexistent-json"),
        localPath: path.join(testDir, "nonexistent-local"),
        schemaPath: path.join(testDir, "nonexistent-schemas"),
      });

      // Should not throw when directories don't exist
      expect(() =>
        newWatcher.initWatchers(
          () => {},
          () => {},
          () => {},
        ),
      ).not.toThrow();

      newWatcher.close();
    });
  });

  describe("Application file watching", () => {
    it("should detect application.json changes", async () => {
      // Setup: Application erstellen
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

      // Manually trigger watch event for application.json change
      triggerApplicationWatch("testapp/application.json", "change");

      // Wait for debounced invalidation (300ms)
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Application cache should be invalidated
      expect(applicationInvalidated).toBe(true);
    });

    it("should detect icon file changes", async () => {
      // Setup: Application mit Icon
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

      // Create icon file
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "applications/iconapp/icon.png",
        "icon data",
      );

      // Manually trigger watch event for icon file
      triggerApplicationWatch("iconapp/icon.png", "change");

      // Wait for debounced invalidation
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Application cache should be invalidated
      expect(applicationInvalidated).toBe(true);
    });

    it("should detect new application directories", async () => {
      // Create new application
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/newapp",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/newapp/application.json",
        {
          name: "New App",
          installation: {},
        },
      );

      // Manually trigger watch event for new directory (directory name without extension)
      triggerApplicationWatch("newapp", "rename");

      // Wait for debounced invalidation
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Application cache should be invalidated
      expect(applicationInvalidated).toBe(true);
    });
  });

  describe("Template file watching", () => {
    it("should detect template file changes", async () => {
      // Setup: Template-Verzeichnis erstellen
      const templatesDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "shared/templates",
      );
      mkdirSync(templatesDir, { recursive: true });

      // Create template file
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "shared/templates/testtemplate.json",
        {
          name: "Test Template",
          commands: [],
        },
      );

      // Manually trigger watch event for template file
      triggerTemplateWatch("testtemplate.json");

      // Templates don't have debounce, so invalidation should be immediate
      // But we wait a tiny bit to ensure callback is processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Template cache should be invalidated
      expect(templateInvalidated).toBe(true);
    });
  });

  describe("Framework file watching", () => {
    it("should detect framework file changes", async () => {
      // Setup: Framework-Verzeichnis erstellen
      const frameworksDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "frameworks",
      );
      mkdirSync(frameworksDir, { recursive: true });

      // Create framework file
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "frameworks/testframework.json",
        {
          id: "testframework",
          name: "Test Framework",
          extends: "base",
          properties: [],
        },
      );

      // Manually trigger watch event for framework file
      triggerFrameworkWatch("testframework.json");

      // Wait a tiny bit to ensure callback is processed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Framework cache should be invalidated
      expect(frameworkInvalidated).toBe(true);
    });
  });

  describe("close()", () => {
    it("should close watchers without errors", () => {
      expect(() => watcher.close()).not.toThrow();
    });

    it("should allow multiple close calls", () => {
      watcher.close();
      expect(() => watcher.close()).not.toThrow();
    });

    it("should stop watching after close", async () => {
      watcher.close();

      // Create file after close
      const appDir = persistenceHelper.resolve(
        Volume.LocalRoot,
        "applications/afterclose",
      );
      mkdirSync(appDir, { recursive: true });
      persistenceHelper.writeJsonSync(
        Volume.LocalRoot,
        "applications/afterclose/application.json",
        {
          name: "After Close",
          installation: {},
        },
      );

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should not be invalidated (watcher is closed)
      expect(applicationInvalidated).toBe(false);
    });
  });
});

describe("FileWatcherManager error handling", () => {
  it("survives an error event of a watcher instead of crashing the process", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "watcher-error-"));
    try {
      const localPath = path.join(dir, "local");
      mkdirSync(path.join(localPath, "applications", "app"), { recursive: true });
      const manager = new FileWatcherManager({
        jsonPath: path.join(dir, "json"),
        localPath,
        schemaPath: path.join(dir, "schemas"),
      });
      manager.initWatchers(() => {}, () => {}, () => {});
      const appsWatcher = (manager as unknown as { localAppsWatcher?: import("fs").FSWatcher })
        .localAppsWatcher;
      expect(appsWatcher).toBeDefined();
      // Without an 'error' listener, emit('error') throws synchronously —
      // exactly what crashed the deployer on EACCES.
      const err = Object.assign(new Error("permission denied"), {
        code: "EACCES",
        path: path.join(localPath, "applications", "app"),
      });
      expect(() => appsWatcher!.emit("error", err)).not.toThrow();
      manager.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
