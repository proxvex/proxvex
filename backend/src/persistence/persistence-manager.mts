import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { JsonValidator } from "../jsonvalidator.mjs";
import { IConfiguredPathes } from "../backend-types.mjs";
import { ITagsConfig, IStacktypeEntry } from "../types.mjs";
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
  "base-deployable.schema.json",
];

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

  private constructor(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
    enableCache: boolean = true,
    jsonPath?: string,
    schemaPath?: string,
    repositories?: IRepositories,
  ) {
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
      const entries = JSON.parse(content) as { name: string }[];
      return { name, entries };
    });
  }

  // Alias für Rückwärtskompatibilität (kann später entfernt werden)
  getStorageContext(): ContextManager {
    return this.contextManager;
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
