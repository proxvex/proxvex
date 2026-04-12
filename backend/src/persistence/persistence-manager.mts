import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { JsonValidator } from "../jsonvalidator.mjs";
import { IConfiguredPathes } from "../backend-types.mjs";
import { ITagsConfig, IStacktypeEntry, IStacktypeDependency, ITestScenarioResponse } from "../types.mjs";
import { FileSystemPersistence } from "./filesystem-persistence.mjs";
import {
  IApplicationPersistence,
  ITemplatePersistence,
  IFrameworkPersistence,
  IAddonPersistence,
} from "./interfaces.mjs";
import { ApplicationService } from "../services/application-service.mjs";
import { FrameworkService } from "../services/framework-service.mjs";
import { AddonService } from "../services/addon-service.mjs";
import { ContextManager } from "../context-manager.mjs";
import { FileSystemRepositories, type IRepositories } from "./repositories.mjs";

const baseSchemas: string[] = [
  "templatelist.schema.json",
  "categorized-templatelist.schema.json",
  "base-deployable.schema.json",
];

/**
 * Derive test scenario dependencies from stacktype and addon definitions.
 * Pure function — no filesystem access, fully testable.
 */
export function deriveTestDependencies(
  appId: string,
  scenarioName: string,
  stacktypes: string[],
  scenarioAddons: string[],
  getStacktypeDeps: (st: string) => IStacktypeDependency[],
  getAddonDeps: (addonId: string) => IStacktypeDependency[],
): string[] {
  const derived: string[] = [];
  for (const st of stacktypes) {
    for (const dep of getStacktypeDeps(st)) {
      if (dep.application !== appId) derived.push(dep.application);
    }
  }
  for (const addonId of new Set(scenarioAddons)) {
    for (const dep of getAddonDeps(addonId)) {
      if (dep.application !== appId) derived.push(dep.application);
    }
  }
  if (derived.length === 0) return [];
  return [...new Set(derived)].map(app => `${app}/${scenarioName}`);
}

/**
 * Generate a human-readable description for a test scenario.
 */
function buildScenarioDescription(appId: string, variant: string, addons?: string[]): string {
  const parts = [appId];
  if (variant !== "default") parts.push(`(${variant})`);
  if (addons && addons.length > 0) {
    parts.push("with", addons.map(a => a.replace(/^addon-/, "")).join(", "));
  }
  return parts.join(" ");
}

/**
 * Central singleton manager for Persistence, Services and ContextManager
 * Replaces StorageContext singleton for entity access (Applications, Templates, Frameworks)
 *
 * Architecture:
 * - PersistenceManager: Central singleton, manages all persistence and services
 * - ContextManager: Manages execution contexts (VE, VM, VMInstall), no longer a singleton
 * - ApplicationService: Wraps IApplicationPersistence
 * - FrameworkService: Wraps IFrameworkPersistence
 * - FileSystemPersistence: Implements persistence interfaces with caching
 */
export class PersistenceManager {
  private static instance: PersistenceManager | undefined;

  private pathes: IConfiguredPathes;
  private jsonValidator: JsonValidator;
  private persistence: IApplicationPersistence &
    IFrameworkPersistence &
    ITemplatePersistence &
    IAddonPersistence;
  private applicationService: ApplicationService;
  private frameworkService: FrameworkService;
  private addonService: AddonService;
  private contextManager: ContextManager;
  private repositories: IRepositories;

  private initArgs: {
    localPath: string;
    storageContextFilePath: string;
    secretFilePath: string;
    enableCache: boolean;
    jsonPath: string | undefined;
    schemaPath: string | undefined;
  };

  private constructor(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
    enableCache: boolean = true,
    jsonPath?: string,
    schemaPath?: string,
    repositories?: IRepositories,
  ) {
    this.initArgs = { localPath, storageContextFilePath, secretFilePath, enableCache, jsonPath, schemaPath };
    // Create paths (same logic as StorageContext)
    // persistence-manager.mts is in backend/src/persistence/
    // So we need to go up 3 levels: ../../.. to project root
    const persistenceDir = dirname(fileURLToPath(import.meta.url)); // backend/src/persistence
    const projectRoot = join(persistenceDir, "../../.."); // project root
    this.pathes = {
      localPath: localPath,
      jsonPath: jsonPath || path.join(projectRoot, "json"),
      schemaPath: schemaPath || path.join(projectRoot, "schemas"),
    };

    this.assertBasePathsExist(this.pathes);

    // Create JsonValidator (same logic as StorageContext)
    this.jsonValidator = new JsonValidator(this.pathes.schemaPath, baseSchemas);

    // Initialize Persistence (uses same pathes and validator)
    this.persistence = new FileSystemPersistence(
      this.pathes,
      this.jsonValidator,
      enableCache,
    );

    // Initialize Services
    this.applicationService = new ApplicationService(this.persistence);
    this.frameworkService = new FrameworkService(this.persistence);
    this.addonService = new AddonService(this.persistence, this.persistence);

    // Initialize ContextManager (no longer a singleton itself)
    // Pass pathes, validator and persistence to avoid duplication
    this.contextManager = new ContextManager(
      localPath,
      storageContextFilePath,
      secretFilePath,
      this.pathes,
      this.jsonValidator,
      this.persistence,
    );

    this.repositories =
      repositories ??
      new FileSystemRepositories(this.pathes, this.persistence, enableCache);
    const reposWithPreload = this.repositories as IRepositories & {
      preloadJsonResources?: () => void;
    };
    reposWithPreload.preloadJsonResources?.();
  }

  private assertBasePathsExist(pathes: IConfiguredPathes): void {
    const missing: string[] = [];
    if (!fs.existsSync(pathes.localPath))
      missing.push(`localPath: ${pathes.localPath}`);
    if (!fs.existsSync(pathes.jsonPath))
      missing.push(`jsonPath: ${pathes.jsonPath}`);
    if (!fs.existsSync(pathes.schemaPath))
      missing.push(`schemaPath: ${pathes.schemaPath}`);
    if (missing.length > 0) {
      throw new Error(
        `PersistenceManager initialization failed: missing base paths -> ${missing.join(", ")}`,
      );
    }
  }

  /**
   * Initializes the PersistenceManager singleton
   * This replaces StorageContext.setInstance()
   *
   * If already initialized, closes the existing instance first (useful for tests)
   */
  static initialize(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
    enableCache: boolean = true,
    jsonPath?: string,
    schemaPath?: string,
    repositories?: IRepositories,
  ): PersistenceManager {
    if (PersistenceManager.instance) {
      // Close existing instance (useful for tests)
      PersistenceManager.instance.close();
    }
    PersistenceManager.instance = new PersistenceManager(
      localPath,
      storageContextFilePath,
      secretFilePath,
      enableCache,
      jsonPath,
      schemaPath,
      repositories,
    );
    return PersistenceManager.instance;
  }

  /**
   * Gets the PersistenceManager singleton instance
   */
  static getInstance(): PersistenceManager {
    if (!PersistenceManager.instance) {
      throw new Error(
        "PersistenceManager not initialized. Call initialize() first.",
      );
    }
    return PersistenceManager.instance;
  }

  // Getters für Zugriff auf Komponenten
  getPersistence(): IApplicationPersistence &
    IFrameworkPersistence &
    ITemplatePersistence {
    return this.persistence;
  }

  getApplicationService(): ApplicationService {
    return this.applicationService;
  }

  getFrameworkService(): FrameworkService {
    return this.frameworkService;
  }

  getAddonService(): AddonService {
    return this.addonService;
  }

  getPathes(): IConfiguredPathes {
    return this.pathes;
  }

  getJsonValidator(): JsonValidator {
    return this.jsonValidator;
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getRepositories(): IRepositories {
    return this.repositories;
  }

  /**
   * Returns the tags configuration from json/tags.json
   * Used for application categorization in the frontend
   */
  getTagsConfig(): ITagsConfig {
    const tagsFilePath = path.join(this.pathes.jsonPath, "tags.json");
    if (!fs.existsSync(tagsFilePath)) {
      // Return empty config if file doesn't exist
      return { groups: [], internal: [] };
    }
    const content = fs.readFileSync(tagsFilePath, "utf-8");
    return JSON.parse(content) as ITagsConfig;
  }

  /**
   * Returns the stacktypes configuration from json/stacktypes/ directory.
   * Each .json file in the directory represents a stacktype (filename = name).
   */
  getStacktypes(): IStacktypeEntry[] {
    const stacktypesDir = path.join(this.pathes.jsonPath, "stacktypes");
    if (!fs.existsSync(stacktypesDir)) {
      return [];
    }
    const files = fs
      .readdirSync(stacktypesDir)
      .filter((f) => f.endsWith(".json"));
    return files.map((file) => {
      const name = path.basename(file, ".json");
      const content = fs.readFileSync(path.join(stacktypesDir, file), "utf-8");
      const parsed = JSON.parse(content);
      // Support both formats: array (legacy) and object with variables+dependencies
      if (Array.isArray(parsed)) {
        return { name, entries: parsed as { name: string }[] };
      }
      return {
        name,
        ...(parsed.name ? { displayName: parsed.name } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        entries: (parsed.variables ?? []) as { name: string }[],
        ...(parsed.provides ? { provides: parsed.provides } : {}),
        dependencies: parsed.dependencies,
      };
    });
  }

  /**
   * Saves test data (params + uploads) for an application into json/applications/<id>/tests/
   * Only works for applications whose source directory is inside jsonPath.
   */
  saveApplicationTestData(
    applicationId: string,
    scenarioName: string,
    params: { name: string; value: string | number | boolean }[],
    uploads: { name: string; content: string }[],
    addons?: string[],
  ): { testsDir: string } {
    const appService = this.applicationService;
    const localAppNames = appService.getLocalAppNames();

    // Determine the app directory (local or json)
    let appDir: string | undefined;
    if (localAppNames.has(applicationId)) {
      appDir = localAppNames.get(applicationId)!;
    } else {
      // Check in jsonPath
      const jsonAppDir = path.join(this.pathes.jsonPath, "applications", applicationId);
      if (fs.existsSync(jsonAppDir)) {
        appDir = jsonAppDir;
      }
    }

    if (!appDir) {
      throw new Error(`Application ${applicationId} not found`);
    }

    const testsDir = path.join(appDir, "tests");
    fs.mkdirSync(testsDir, { recursive: true });

    // Build {scenarioName}.json — filter out hostname (test-runner sets its own)
    const filteredParams = params.filter(p => p.name !== "hostname");
    const output: Record<string, unknown> = { params: filteredParams };
    if (addons && addons.length > 0) {
      output.selectedAddons = addons;
    }
    // stackId deliberately NOT saved — test-runner assigns stack names

    fs.writeFileSync(
      path.join(testsDir, `${scenarioName}.json`),
      JSON.stringify(output, null, 2) + "\n",
      "utf-8",
    );

    // Write upload files
    if (uploads.length > 0) {
      const uploadsDir = path.join(testsDir, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const file of uploads) {
        fs.writeFileSync(
          path.join(uploadsDir, file.name),
          Buffer.from(file.content, "base64"),
        );
      }
    }

    return { testsDir };
  }

  /**
   * Discovers all test scenarios across all applications (json + local).
   * Returns scenario definitions with their params and upload file lists.
   */
  getTestScenarios(): ITestScenarioResponse[] {
    const appService = this.applicationService;
    const addonService = this.addonService;
    const allApps = appService.getAllAppNames();
    const scenarios: ITestScenarioResponse[] = [];

    // Build stacktype lookup (name → dependencies)
    const stacktypeMap = new Map<string, IStacktypeDependency[]>();
    for (const st of this.getStacktypes()) {
      stacktypeMap.set(st.name, st.dependencies ?? []);
    }
    const getStacktypeDeps = (st: string) => stacktypeMap.get(st) ?? [];
    const getAddonDeps = (addonId: string) => {
      try {
        return addonService.getAddon(addonId)?.dependencies ?? [];
      } catch { return []; }
    };

    for (const [appId, appDir] of allApps) {
      // Collect test directories: own + inherited from extends chain
      // Base-app tests are included first, local tests override by name
      const testDirs: string[] = [];
      const ownTestDir = path.join(appDir, "tests");
      try {
        const appJsonPath = path.join(appDir, "application.json");
        if (fs.existsSync(appJsonPath)) {
          const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
          // Walk extends chain to collect base test directories
          let ext = appJson.extends as string | undefined;
          while (ext) {
            const baseAppName = ext.replace(/^json:/, "");
            const baseDir = path.join(this.pathes.jsonPath, "applications", baseAppName, "tests");
            if (fs.existsSync(baseDir)) testDirs.push(baseDir);
            // Check if base also extends
            try {
              const baseJsonPath = path.join(this.pathes.jsonPath, "applications", baseAppName, "application.json");
              if (fs.existsSync(baseJsonPath)) {
                const baseJson = JSON.parse(fs.readFileSync(baseJsonPath, "utf-8"));
                ext = baseJson.extends as string | undefined;
                // Stop at framework-level extends (docker-compose, oci-image)
                if (ext && !ext.includes("/") && !ext.startsWith("json:")) ext = undefined;
              } else { ext = undefined; }
            } catch { ext = undefined; }
          }
        }
      } catch { /* ignore */ }
      if (fs.existsSync(ownTestDir)) testDirs.push(ownTestDir);

      // Get application stacktype for dependency derivation
      let appStacktypes: string[] = [];
      try {
        const appJsonPath = path.join(appDir, "application.json");
        if (fs.existsSync(appJsonPath)) {
          const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
          let st = appJson.stacktype;
          if (!st) {
            let ext = appJson.extends as string | undefined;
            while (ext && !st) {
              const baseName = ext.replace(/^json:/, "");
              try {
                const baseJsonPath = path.join(this.pathes.jsonPath, "applications", baseName, "application.json");
                if (fs.existsSync(baseJsonPath)) {
                  const baseJson = JSON.parse(fs.readFileSync(baseJsonPath, "utf-8"));
                  st = baseJson.stacktype;
                  ext = baseJson.extends as string | undefined;
                  if (ext && !ext.includes("/") && !ext.startsWith("json:")) ext = undefined;
                } else { ext = undefined; }
              } catch { ext = undefined; }
            }
          }
          appStacktypes = st ? (Array.isArray(st) ? st : [st]) : [];
        }
      } catch { /* ignore */ }

      // Auto-discover scenarios from *.json files in test directories.
      // Each JSON file defines one scenario (filename without .json = variant name).
      // All fields (params, selectedAddons, task, depends_on, cleanup, etc.) live
      // in the variant file. Base dirs are read first, local dirs override.
      const scenarioData = new Map<string, Record<string, unknown>>();
      for (const td of testDirs) {
        if (!fs.existsSync(td)) continue;
        for (const f of fs.readdirSync(td)) {
          if (!f.endsWith(".json")) continue;
          const fullPath = path.join(td, f);
          if (!fs.statSync(fullPath).isFile()) continue;
          const name = f.replace(/\.json$/, "");
          try {
            const content = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
            // Later dirs (local) override earlier dirs (base)
            scenarioData.set(name, { ...(scenarioData.get(name) ?? {}), ...content });
          } catch { /* ignore parse errors */ }
        }
      }

      for (const [name, data] of scenarioData) {
        const scenario: ITestScenarioResponse = {
          id: `${appId}/${name}`,
          application: appId,
          description: "",
        };

        // Apply all known fields
        if (data.params) scenario.params = data.params as NonNullable<ITestScenarioResponse["params"]>;
        if (data.selectedAddons) scenario.selectedAddons = data.selectedAddons as string[];
        if (data.addons && !scenario.selectedAddons) scenario.selectedAddons = data.addons as string[];
        if (data.stackId) scenario.stackId = data.stackId as string;
        if (data.stackIds) scenario.stackIds = data.stackIds as string[];
        if (data.task) scenario.task = data.task as string;
        if (data.depends_on) scenario.depends_on = data.depends_on as string[];
        if (data.cleanup) scenario.cleanup = data.cleanup as Record<string, string>;
        if (data.wait_seconds !== undefined) scenario.wait_seconds = data.wait_seconds as number;
        if (data.cli_timeout !== undefined) scenario.cli_timeout = data.cli_timeout as number;
        if (data.verify) scenario.verify = data.verify as Record<string, boolean | number | string>;
        if (data.description) scenario.description = data.description as string;

        // Auto-generate description if not explicitly set
        if (!scenario.description) {
          scenario.description = buildScenarioDescription(appId, name, scenario.selectedAddons);
        }

        // Read upload files — merge from all test dirs (local overrides base by filename)
        const uploadMap = new Map<string, { dir: string; file: string }>();
        for (const td of testDirs) {
          const uploadsDir = path.join(td, "uploads");
          if (fs.existsSync(uploadsDir)) {
            for (const f of fs.readdirSync(uploadsDir)) {
              if (fs.statSync(path.join(uploadsDir, f)).isFile()) {
                uploadMap.set(f, { dir: uploadsDir, file: f });
              }
            }
          }
        }
        if (uploadMap.size > 0) {
          scenario.uploads = [...uploadMap.values()].map(({ dir, file }) => ({
            name: file,
            content: fs.readFileSync(path.join(dir, file)).toString("base64"),
          }));
        }

        // Auto-derive depends_on from stacktype + addon dependencies
        if (!scenario.depends_on) {
          const allAddons = [...new Set(scenario.selectedAddons ?? [])];
          const derived = deriveTestDependencies(appId, name, appStacktypes, allAddons, getStacktypeDeps, getAddonDeps);
          if (derived.length > 0) {
            scenario.depends_on = derived;
          }
        }

        scenarios.push(scenario);
      }
    }

    return scenarios;
  }

  // Alias für Rückwärtskompatibilität (kann später entfernt werden)
  getStorageContext(): ContextManager {
    return this.contextManager;
  }

  /**
   * Reload: close and re-initialize with the same parameters.
   * Clears all caches and re-reads json/ and schemas/ from disk.
   */
  static reload(): PersistenceManager {
    const instance = PersistenceManager.getInstance();
    const args = instance.initArgs;
    return PersistenceManager.initialize(
      args.localPath,
      args.storageContextFilePath,
      args.secretFilePath,
      args.enableCache,
      args.jsonPath,
      args.schemaPath,
    );
  }

  /**
   * Cleanup (closes file watchers, etc.)
   */
  close(): void {
    if (this.persistence && "close" in this.persistence) {
      this.persistence.close();
    }
    PersistenceManager.instance = undefined;
  }
}
