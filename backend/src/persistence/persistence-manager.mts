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
import type { ICaProvider } from "../services/ca-provider.mjs";
import type { IStackProvider } from "../services/stack-provider.mjs";
import { CertificateAuthorityService } from "../services/certificate-authority-service.mjs";
import { LocalStackProvider } from "../services/local-stack-provider.mjs";
import { RemoteCaProvider } from "../services/remote-ca-provider.mjs";
import { RemoteStackProvider } from "../services/remote-stack-provider.mjs";
import {
  ApplicationDependencyResolver,
  IDependencyDataSource,
} from "../services/application-dependency-resolver.mjs";
import { createLogger } from "../logger/index.mjs";
import { getBearerToken } from "../services/bearer-token-store.mjs";

const baseSchemas: string[] = [
  "templatelist.schema.json",
  "categorized-templatelist.schema.json",
  "base-deployable.schema.json",
  "stack-usage.schema.json",
];

/**
 * Derive test scenario dependencies from stacktype and addon definitions.
 * Pure function — no filesystem access, fully testable.
 *
 * Delegates the App+Stacktype+Addons resolution to ApplicationDependencyResolver
 * (the single source of truth shared with the webapp dep-check routes), then
 * maps the deduped applications to scenario ids `<app>/<scenarioName>`. The
 * livetest path intentionally skips `app.dependencies` (`includeAppDeps: false`)
 * to preserve historical scenario-derivation semantics.
 */
export function deriveTestDependencies(
  appId: string,
  scenarioName: string,
  stacktypes: string[],
  scenarioAddons: string[],
  getStacktypeDeps: (st: string) => IStacktypeDependency[],
  getAddonDeps: (addonId: string) => IStacktypeDependency[],
): string[] {
  const source: IDependencyDataSource = {
    getApplication: (name) => (name === appId ? { stacktype: stacktypes } : null),
    getStacktype: (name) => ({ dependencies: getStacktypeDeps(name) }),
    getAddon: (id) => ({ dependencies: getAddonDeps(id) }),
    getStack: () => null,
  };
  const resolved = new ApplicationDependencyResolver(source).resolve(
    appId,
    scenarioAddons,
    [],
    { includeAppDeps: false },
  );
  if (resolved.length === 0) return [];
  return resolved.map((d) => `${d.application}/${scenarioName}`);
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
    hubPath?: string,
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
      ...(hubPath ? { hubPath } : {}),
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
    hubPath?: string,
  ): PersistenceManager {
    // Build the new instance first. If construction throws (e.g. invalid
    // JSON picked up by a reload), keep the existing instance alive so the
    // server stays functional and a subsequent reload can recover.
    const next = new PersistenceManager(
      localPath,
      storageContextFilePath,
      secretFilePath,
      enableCache,
      jsonPath,
      schemaPath,
      repositories,
      hubPath,
    );
    const previous = PersistenceManager.instance;
    PersistenceManager.instance = next;
    if (previous) {
      previous.close();
    }
    return next;
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
   * Single-source resolver for the question "given this app + addons +
   * stacks, which dependency apps must already be running?". Replaces three
   * inline duplicates in the webapp routes. Lazily constructed so it picks
   * up the current StackProvider (Spoke/Standalone-aware).
   */
  private _dependencyResolver: ApplicationDependencyResolver | null = null;
  getApplicationDependencyResolver(): ApplicationDependencyResolver {
    if (!this._dependencyResolver) {
      const stacktypes = this.getStacktypes();
      const stacktypeMap = new Map<string, IStacktypeEntry>();
      for (const st of stacktypes) stacktypeMap.set(st.name, st);
      const stackProvider = this.getStackProvider();
      const repos = this.repositories;
      const addonSvc = this.addonService;
      const source: IDependencyDataSource = {
        getApplication: (name) => {
          try {
            const cfg = repos.getApplication(name) as { dependencies?: IStacktypeDependency[]; stacktype?: string | string[] };
            return cfg ?? null;
          } catch { return null; }
        },
        getStacktype: (name) => stacktypeMap.get(name) ?? null,
        getAddon: (id) => {
          try { return addonSvc.getAddon(id) ?? null; } catch { return null; }
        },
        getStack: (id) => {
          try { return stackProvider.getStack(id) ?? null; } catch { return null; }
        },
      };
      this._dependencyResolver = new ApplicationDependencyResolver(source);
    }
    return this._dependencyResolver;
  }

  private _caProvider: ICaProvider | null = null;
  private _stackProvider: IStackProvider | null = null;

  /**
   * Drop memoised CA/Stack providers so the next getCaProvider /
   * getStackProvider call re-evaluates Spoke-vs-Standalone. Called by the
   * SSH-config route after the current VE entry changes (e.g. user toggles
   * isHub or swaps the active connection in the UI).
   */
  resetProviders(): void {
    this._caProvider = null;
    this._stackProvider = null;
    // Drop the cached dependency resolver too — it captures the StackProvider.
    this._dependencyResolver = null;
  }

  /**
   * Replace the active repositories root with a different path pair (used
   * by the Spoke after a fresh Hub-sync: only `localPath` is rebound to the
   * synced workspace — `jsonPath` stays on the Spoke's checkout so the
   * deployer always runs against the code revision the user has on disk).
   *
   * The pathes object is mutated in place so every handler that captured a
   * reference at construction time (FileSystemPersistence,
   * TemplatePersistenceHandler, ApplicationPersistenceHandler, …) picks up
   * the new localPath without needing to be rebuilt. Without this,
   * `resolveTemplatePath` keeps reading the spoke's pre-sync localPath and
   * Hub-overrides under `local/shared/templates/` are never found.
   */
  rebindRepositoriesRoot(newLocalPath: string): void {
    this.pathes.localPath = newLocalPath;
    this.repositories = new FileSystemRepositories(
      this.pathes,
      this.persistence,
      true,
    );
    const reposWithPreload = this.repositories as IRepositories & {
      preloadJsonResources?: () => void;
    };
    reposWithPreload.preloadJsonResources?.();
    const logger = createLogger("persistence-manager");
    logger.info(
      `Repositories root rebound: localPath=${newLocalPath} (jsonPath unchanged)`,
    );
  }

  /**
   * Returns the CA provider.
   * Hub mode (default): local CertificateAuthorityService.
   * Spoke mode (HUB_URL env set): RemoteCaProvider that proxies to the Hub.
   */
  getCaProvider(): ICaProvider {
    if (this._caProvider) return this._caProvider;
    const spoke = this.detectSpokeConfig();
    if (spoke) {
this._caProvider = new RemoteCaProvider(spoke.hubUrl, getBearerToken);
    } else {
      this._caProvider = new CertificateAuthorityService(this.contextManager);
    }
    return this._caProvider!;
  }

  /**
   * Returns the Stack provider.
   * Hub mode (default): local via ContextManager.
   * Spoke mode (HUB_URL env set): RemoteStackProvider that proxies to the Hub.
   */
  getStackProvider(): IStackProvider {
    if (this._stackProvider) return this._stackProvider;
    const spoke = this.detectSpokeConfig();
    if (spoke) {
this._stackProvider = RemoteStackProvider.create(spoke.hubUrl, getBearerToken);
    } else {
      this._stackProvider = new LocalStackProvider(this.contextManager);
    }
    return this._stackProvider!;
  }

  /**
   * Detect Spoke configuration. Spoke mode is activated when the currently
   * selected SSH entry (stored in storagecontext.json) has `isHub=true` and
   * a non-empty `hubApiUrl`. The legacy `HUB_URL` environment variable is
   * still honoured as a fallback, so dev scripts keep working.
   *
   * Auth is handled at request time:
   *   - OIDC mode: bearer token taken from the bearer-token-store (set by
   *     the OIDC callback handler)
   *   - Non-OIDC mode: no auth, relying on the Hub's open endpoints.
   *
   * Returns null for Hub mode, config object for Spoke mode.
   */
  /**
   * Returns the URL of the currently active Hub, or undefined if the
   * deployer is in standalone/Hub mode. Callers use this to decide whether
   * to trigger Spoke-sync or show Hub-related UI elements.
   */
  getActiveHubUrl(): string | undefined {
    return this.detectSpokeConfig()?.hubUrl;
  }

  private detectSpokeConfig(): { hubUrl: string } | null {
    const logger = createLogger("persistence-manager");

    // Primary: current SSH entry
    try {
      const ctx = this.contextManager.getCurrentVEContext();
      if (ctx && (ctx as { isHub?: boolean }).isHub) {
        const url = (ctx as { hubApiUrl?: string }).hubApiUrl;
        if (url && /^https?:\/\//.test(url)) {
          if (this.isSelfLoopHubUrl(url)) {
            logger.warn(
              `Spoke mode IGNORED: hubApiUrl ${url} points at this deployer itself`,
            );
            return null;
          }
          logger.info(`Spoke mode: connecting to Hub at ${url} (from SSH config)`);
          return { hubUrl: url };
        }
      }
    } catch {
      // storagecontext not ready yet — fall through to ENV fallback
    }

    // Fallback: HUB_URL env var (dev scripts, legacy)
    const envUrl = process.env.HUB_URL;
    if (envUrl) {
      if (this.isSelfLoopHubUrl(envUrl)) {
        logger.warn(
          `Spoke mode IGNORED: HUB_URL ${envUrl} points at this deployer itself`,
        );
        return null;
      }
      logger.info(`Spoke mode: connecting to Hub at ${envUrl} (from HUB_URL env)`);
      return { hubUrl: envUrl };
    }

    return null;
  }

  /**
   * Returns true if the given URL points to this deployer instance
   * (localhost/127.0.0.1/::1/0.0.0.0 + same port). Prevents self-loops when
   * a user accidentally sets isHub=true on the Hub instance itself.
   */
  private isSelfLoopHubUrl(hubUrl: string): boolean {
    try {
      const u = new URL(hubUrl);
      const ownPort = String(process.env.DEPLOYER_PORT || "3000");
      const loopback = ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"];
      const inferredOwnPort = u.port || (u.protocol === "https:" ? "443" : "80");
      return loopback.includes(u.hostname) && inferredOwnPort === ownPort;
    } catch {
      return false;
    }
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
          if (!f.endsWith(".json") || f.startsWith("production")) continue;
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
        if (data.stack_name) scenario.stack_name = data.stack_name as string;
        if (data.depends_on) scenario.depends_on = data.depends_on as string[];
        if (data.cleanup) scenario.cleanup = data.cleanup as Record<string, string>;
        if (data.wait_seconds !== undefined) scenario.wait_seconds = data.wait_seconds as number;
        if (data.cli_timeout !== undefined) scenario.cli_timeout = data.cli_timeout as number;
        if (data.verify) scenario.verify = data.verify as Record<string, boolean | number | string>;
        if (data.expect2fail) scenario.expect2fail = data.expect2fail as Record<string, number>;
        if (data.allowed2fail) scenario.allowed2fail = data.allowed2fail as Record<string, number>;
        if (data.playwright_spec)
          scenario.playwright_spec = data.playwright_spec as string | string[];
        if (data.requires_env) scenario.requires_env = data.requires_env as string[];
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

    // Fix derived depends_on: if a derived dependency like "zitadel/oidc" doesn't exist,
    // fall back to "zitadel/default"
    const scenarioIds = new Set(scenarios.map(s => s.id));
    for (const scenario of scenarios) {
      if (scenario.depends_on) {
        scenario.depends_on = scenario.depends_on.map(dep => {
          if (scenarioIds.has(dep)) return dep;
          const fallback = dep.replace(/\/[^/]+$/, "/default");
          return scenarioIds.has(fallback) ? fallback : dep;
        });
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
   *
   * In-memory state on the OLD ContextManager (registered SSH configs, stack
   * secrets that were modified after startup, …) is carried over to the NEW
   * instance. Without this, /api/reload silently wipes everything that was
   * registered post-startup — and once route handlers stop holding stale
   * references to the previous PM (see WebAppVeRouteHandlers' getter), every
   * subsequent request would 404 / "VE context not found" until a new SSH
   * config is POSTed and the storagecontext file rewritten. Reload's contract
   * is "re-read disk-backed caches", not "reset in-memory state".
   */
  static reload(): PersistenceManager {
    const previousInstance = PersistenceManager.getInstance();
    const args = previousInstance.initArgs;
    const newInstance = PersistenceManager.initialize(
      args.localPath,
      args.storageContextFilePath,
      args.secretFilePath,
      args.enableCache,
      args.jsonPath,
      args.schemaPath,
    );
    // Carry in-memory contextManager state forward so existing SSH configs,
    // stack secrets, etc. survive the reload. Note: the inherited
    // contextManager still holds references to the OLD persistence/validator;
    // that's intentional — the reload swaps file-backed services on the new
    // instance, but the contextManager's persistence boundary is "write
    // through to disk", which targets the same files regardless of which
    // FileSystemPersistence instance handles the I/O.
    newInstance.contextManager = previousInstance.contextManager;
    return newInstance;
  }

  /**
   * Cleanup (closes file watchers, etc.)
   */
  close(): void {
    if (this.persistence && "close" in this.persistence) {
      this.persistence.close();
    }
    // Only clear the singleton slot if it still points to this instance.
    // During reload() we construct a replacement before closing the old one,
    // so the slot may already hold the new instance — don't wipe it.
    if (PersistenceManager.instance === this) {
      PersistenceManager.instance = undefined;
    }
  }
}
