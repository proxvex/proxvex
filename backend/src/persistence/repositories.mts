import fs from "node:fs";
import path from "node:path";
import { ApplicationLoader } from "../apploader.mjs";
import type {
  IConfiguredPathes,
  IReadApplicationOptions,
} from "../backend-types.mjs";
import { VEConfigurationError } from "../backend-types.mjs";
import type { IApplicationWeb, ITemplate } from "../types.mjs";
import type { IApplication } from "../backend-types.mjs";
import type {
  IApplicationPersistence,
  ITemplatePersistence,
} from "./interfaces.mjs";
import { TemplatePathResolver } from "../templates/template-path-resolver.mjs";
import { MarkdownReader } from "../markdown-reader.mjs";

export type TemplateScope = "application" | "shared";

export interface TemplateRef {
  name: string;
  scope: TemplateScope;
  applicationId?: string;
  origin?: "local" | "json";
  /** Explicit category. "root" = shared root dir; "" = application-scoped (no category). */
  category: string;
}

export interface ScriptRef {
  name: string;
  scope: TemplateScope;
  applicationId?: string;
  /** Explicit category. "root" = shared root dir; "" = application-scoped (no category). */
  category: string;
}

export interface MarkdownRef {
  templateName: string;
  scope: TemplateScope;
  applicationId?: string;
  category?: string;
}

export interface LocalResourceRef {
  path: string;
}

export interface IApplicationRepository {
  getApplication(applicationId: string): IApplication;
  listApplications(): IApplicationWeb[];
  getApplicationIcon(
    applicationId: string,
  ): { iconContent: string; iconType: string } | null;
}

export interface ITemplateRepository {
  resolveTemplateRef(
    applicationId: string,
    templateName: string,
    category: string,
  ): TemplateRef | null;
  getTemplate(ref: TemplateRef): ITemplate | null;
}

export interface IResourceRepository {
  getScript(ref: ScriptRef): string | null;
  resolveScriptPath(ref: ScriptRef): string | null;
  resolveLibraryPath(ref: ScriptRef): string | null;
  getMarkdown(ref: MarkdownRef): string | null;
  getMarkdownSection(ref: MarkdownRef, sectionName: string): string | null;
  getLocalResource(ref: LocalResourceRef): Buffer | null;
}

export interface IRepositories
  extends IApplicationRepository, ITemplateRepository, IResourceRepository {
  preloadJsonResources?(): void;
  /** Check for duplicate template/script names across categories. Returns warnings. */
  checkForDuplicates?(): string[];
}

export interface InMemoryRepositoriesOptions {
  applications?: Map<string, IApplication>;
  templates?: Map<string, ITemplate>; // application templates keyed by `${appId}:${templateName}`
  sharedTemplates?: Map<string, ITemplate>; // keyed by `${category}:${templateName}` (use "root:name" for root templates)
  scripts?: Map<string, string>; // application scripts keyed by `${appId}:${scriptName}`
  sharedScripts?: Map<string, string>; // keyed by `${category}:${scriptName}` (use "root:name" for root scripts)
  markdown?: Map<string, string>; // application markdown keyed by `${appId}:${templateName}`
  sharedMarkdown?: Map<string, string>; // keyed by templateName
  localResources?: Map<string, Buffer>; // keyed by resource path
  origin?: "local" | "json";
}

export class InMemoryRepositories
  implements IApplicationRepository, ITemplateRepository, IResourceRepository
{
  private applications: Map<string, IApplication>;
  private templates: Map<string, ITemplate>;
  private sharedTemplates: Map<string, ITemplate>;
  private scripts: Map<string, string>;
  private sharedScripts: Map<string, string>;
  private markdown: Map<string, string>;
  private sharedMarkdown: Map<string, string>;
  private localResources: Map<string, Buffer>;
  private origin: "local" | "json";

  constructor(options: InMemoryRepositoriesOptions = {}) {
    this.applications = options.applications ?? new Map();
    this.templates = options.templates ?? new Map();
    this.sharedTemplates = options.sharedTemplates ?? new Map();
    this.scripts = options.scripts ?? new Map();
    this.sharedScripts = options.sharedScripts ?? new Map();
    this.markdown = options.markdown ?? new Map();
    this.sharedMarkdown = options.sharedMarkdown ?? new Map();
    this.localResources = options.localResources ?? new Map();
    this.origin = options.origin ?? "json";
  }

  listApplications(): IApplicationWeb[] {
    const result: IApplicationWeb[] = [];
    for (const [id, app] of this.applications) {
      result.push({
        id,
        name: app.name ?? id,
        description: app.description ?? "",
        icon: app.icon,
        iconContent: app.iconContent,
        iconType: app.iconType,
        tags: app.tags,
        source: this.origin,
        framework: undefined,
        ...(app.errors && app.errors.length > 0
          ? {
              errors: app.errors.map((e) => ({
                message: e,
                name: "Error",
                details: undefined,
              })),
            }
          : {}),
      });
    }
    return result;
  }

  getApplicationIcon(
    applicationId: string,
  ): { iconContent: string; iconType: string } | null {
    const app = this.applications.get(applicationId);
    if (!app || !app.iconContent || !app.iconType) return null;
    return { iconContent: app.iconContent, iconType: app.iconType };
  }

  getApplication(applicationId: string): IApplication {
    const app = this.applications.get(applicationId);
    if (!app) {
      throw new Error(`Application not found: ${applicationId}`);
    }
    return app;
  }

  resolveTemplateRef(
    applicationId: string,
    templateName: string,
    category: string,
  ): TemplateRef | null {
    const normalized = TemplatePathResolver.normalizeTemplateName(templateName);
    const appKey = `${applicationId}:${normalized}`;
    if (this.templates.has(appKey)) {
      return {
        name: normalized,
        scope: "application",
        applicationId,
        origin: this.origin,
        category: "",
      };
    }
    const categoryKey = `${category}:${normalized}`;
    if (this.sharedTemplates.has(categoryKey)) {
      return {
        name: normalized,
        scope: "shared",
        origin: this.origin,
        category,
      };
    }
    return null;
  }

  getTemplate(ref: TemplateRef): ITemplate | null {
    if (ref.scope === "shared") {
      const categoryKey = `${ref.category}:${ref.name}`;
      return this.sharedTemplates.get(categoryKey) ?? null;
    }
    const key = `${ref.applicationId}:${ref.name}`;
    return this.templates.get(key) ?? null;
  }

  getScript(ref: ScriptRef): string | null {
    if (ref.scope === "shared") {
      const categoryKey = `${ref.category}:${ref.name}`;
      return this.sharedScripts.get(categoryKey) ?? null;
    }
    const key = `${ref.applicationId}:${ref.name}`;
    return this.scripts.get(key) ?? null;
  }

  resolveScriptPath(): string | null {
    return null;
  }

  resolveLibraryPath(): string | null {
    return null;
  }

  getMarkdown(ref: MarkdownRef): string | null {
    if (ref.scope === "shared") {
      return this.sharedMarkdown.get(ref.templateName) ?? null;
    }
    const key = `${ref.applicationId}:${ref.templateName}`;
    return this.markdown.get(key) ?? null;
  }

  getMarkdownSection(ref: MarkdownRef, sectionName: string): string | null {
    const content = this.getMarkdown(ref);
    if (!content) return null;
    return InMemoryRepositories.extractSectionFromContent(content, sectionName);
  }

  getLocalResource(ref: LocalResourceRef): Buffer | null {
    return this.localResources.get(ref.path) ?? null;
  }

  preloadJsonResources(): void {
    // No-op for in-memory repositories
  }

  private static extractSectionFromContent(
    content: string,
    sectionName: string,
  ): string | null {
    const normalizeHeadingName = (name: string): string => {
      let s = name.trim().toLowerCase();
      s = s.replace(/\s*\{#.*\}\s*$/, "");
      s = s.replace(/:+\s*$/, "");
      s = s.replace(/^`+|`+$/g, "");
      s = s.replace(/\s+/g, " ");
      return s;
    };

    const lines = content.split(/\r?\n/);
    const normalizedSectionName = normalizeHeadingName(sectionName);
    let inSection = false;
    const sectionContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        const headingName = normalizeHeadingName(headingMatch[1]!);
        if (headingName === normalizedSectionName) {
          inSection = true;
          continue;
        } else if (inSection) {
          break;
        }
      } else if (inSection) {
        sectionContent.push(line);
      }
    }

    if (sectionContent.length === 0) return null;
    while (sectionContent.length > 0 && sectionContent[0]!.trim() === "") {
      sectionContent.shift();
    }
    while (
      sectionContent.length > 0 &&
      sectionContent[sectionContent.length - 1]!.trim() === ""
    ) {
      sectionContent.pop();
    }
    return sectionContent.length > 0 ? sectionContent.join("\n") : null;
  }
}

export class FileSystemRepositories
  implements IApplicationRepository, ITemplateRepository, IResourceRepository
{
  private templateCache = new Map<string, ITemplate>();
  private scriptCache = new Map<string, string>();
  private markdownCache = new Map<string, string>();
  private applicationHierarchyCache = new Map<string, string[]>();

  constructor(
    private pathes: IConfiguredPathes,
    private persistence: IApplicationPersistence & ITemplatePersistence,
    private enableCache: boolean = true,
  ) {}

  preloadJsonResources(): void {
    if (!this.enableCache) return;
    const jsonRoot = this.pathes.jsonPath;

    // Shared templates
    const sharedTemplatesDir = path.join(jsonRoot, "shared", "templates");
    this.preloadTemplatesFromDir(sharedTemplatesDir, "shared");

    // Shared scripts
    const sharedScriptsDir = path.join(jsonRoot, "shared", "scripts");
    this.preloadScriptsFromDir(sharedScriptsDir, "shared");

    // Applications
    const appsDir = path.join(jsonRoot, "applications");
    if (fs.existsSync(appsDir)) {
      const appEntries = fs.readdirSync(appsDir, { withFileTypes: true });
      for (const entry of appEntries) {
        if (!entry.isDirectory()) continue;
        const appId = entry.name;
        const appBase = path.join(appsDir, appId);

        const appTemplatesDir = path.join(appBase, "templates");
        this.preloadTemplatesFromDir(appTemplatesDir, "application", appId);

        const appScriptsDir = path.join(appBase, "scripts");
        this.preloadScriptsFromDir(appScriptsDir, "application", appId);
      }
    }
  }

  listApplications(): IApplicationWeb[] {
    return this.persistence.listApplicationsForFrontend();
  }

  getApplicationIcon(
    applicationId: string,
  ): { iconContent: string; iconType: string } | null {
    return this.persistence.readApplicationIcon(applicationId);
  }

  getApplication(applicationId: string): IApplication {
    const appLoader = new ApplicationLoader(this.pathes, this.persistence);
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", applicationId),
      taskTemplates: [],
    };
    return appLoader.readApplicationJson(applicationId, readOpts);
  }

  resolveTemplateRef(
    applicationId: string,
    templateName: string,
    category: string,
  ): TemplateRef | null {
    // Get the full application hierarchy (child -> parent -> grandparent...)
    const hierarchy = this.getApplicationHierarchy(applicationId);

    // Search through the hierarchy: child first, then parents
    for (const appId of hierarchy) {
      const appPath = this.getApplicationPath(appId);
      if (!appPath) continue;

      // Check if template exists in this application's templates folder (not shared)
      const templateNameWithExt = templateName.endsWith(".json")
        ? templateName
        : `${templateName}.json`;
      const templatePath = path.join(appPath, "templates", templateNameWithExt);

      if (fs.existsSync(templatePath)) {
        const fullPath = this.normalizePath(templatePath);
        const localBase = this.normalizePath(this.pathes.localPath) + path.sep;
        const jsonBase = this.normalizePath(this.pathes.jsonPath) + path.sep;
        const origin = fullPath.startsWith(localBase)
          ? "local"
          : fullPath.startsWith(jsonBase)
            ? "json"
            : undefined;
        if (!origin) continue;
        const name = TemplatePathResolver.normalizeTemplateName(templateName);
        return {
          name,
          scope: "application",
          origin,
          applicationId: appId,
          category: "",
        };
      }
    }

    // Not found in any application, check shared templates
    const resolved = TemplatePathResolver.resolveTemplatePath(
      templateName,
      hierarchy[0]
        ? this.getApplicationPath(hierarchy[0])!
        : this.pathes.jsonPath,
      this.pathes,
      category,
    );
    if (!resolved || !resolved.isShared) return null;

    const fullPath = this.normalizePath(resolved.fullPath);
    const localBase = this.normalizePath(this.pathes.localPath) + path.sep;
    const jsonBase = this.normalizePath(this.pathes.jsonPath) + path.sep;
    const origin = fullPath.startsWith(localBase)
      ? "local"
      : fullPath.startsWith(jsonBase)
        ? "json"
        : undefined;
    if (!origin) return null;
    const name = TemplatePathResolver.normalizeTemplateName(templateName);
    return {
      name,
      scope: "shared",
      origin,
      category: resolved.category,
    };
  }

  /**
   * Get the application hierarchy (extends chain) for an application.
   * Returns array starting with the application itself, then its parent, grandparent, etc.
   */
  private getApplicationHierarchy(applicationId: string): string[] {
    // Check cache first
    if (this.enableCache && this.applicationHierarchyCache.has(applicationId)) {
      return this.applicationHierarchyCache.get(applicationId)!;
    }

    const hierarchy: string[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = applicationId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      hierarchy.push(currentId);

      // Read application.json to get extends
      const appPath = this.getApplicationPath(currentId);
      if (!appPath) break;

      const appJsonPath = path.join(appPath, "application.json");
      if (!fs.existsSync(appJsonPath)) break;

      try {
        const appData = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
        currentId = appData.extends;
      } catch {
        break;
      }
    }

    // Cache the result
    if (this.enableCache) {
      this.applicationHierarchyCache.set(applicationId, hierarchy);
    }

    return hierarchy;
  }

  getTemplate(ref: TemplateRef): ITemplate | null {
    const cacheKey = this.getTemplateCacheKey(ref);
    if (this.enableCache && ref.origin === "json") {
      const cached = this.templateCache.get(cacheKey);
      if (cached) return cached;
    }
    if (ref.scope === "shared") {
      const templatePath = this.persistence.resolveTemplatePath(
        ref.name,
        true,
        ref.category,
      );
      if (!templatePath) return null;
      const template = this.persistence.loadTemplate(templatePath);
      if (this.enableCache && template && ref.origin === "json") {
        this.templateCache.set(cacheKey, template);
      }
      return template;
    }

    const appPath = this.getApplicationPath(ref.applicationId);
    if (!appPath) return null;
    const resolved = TemplatePathResolver.resolveTemplatePath(
      ref.name,
      appPath,
      this.pathes,
    );
    if (!resolved) return null;
    const template = this.persistence.loadTemplate(resolved.fullPath);
    if (this.enableCache && template && ref.origin === "json") {
      this.templateCache.set(cacheKey, template);
    }
    return template;
  }

  getScript(ref: ScriptRef): string | null {
    const cacheKey = this.getScriptCacheKey(ref);
    if (this.enableCache) {
      const cached = this.scriptCache.get(cacheKey);
      if (cached) return cached;
    }
    const scriptPath = this.resolveScriptPath(ref);
    if (!scriptPath || !fs.existsSync(scriptPath)) return null;
    const content = fs.readFileSync(scriptPath, "utf-8");
    if (
      this.enableCache &&
      scriptPath.startsWith(this.pathes.jsonPath + path.sep)
    ) {
      this.scriptCache.set(cacheKey, content);
    }
    return content;
  }

  resolveScriptPath(ref: ScriptRef): string | null {
    let scriptPath: string | null = null;
    if (ref.scope === "shared") {
      const searchPaths: string[] = [];

      if (ref.category === "root") {
        // Root-level shared scripts — no subdirectory
        searchPaths.push(
          path.join(this.pathes.localPath, "shared", "scripts", ref.name),
        );
        searchPaths.push(
          path.join(this.pathes.jsonPath, "shared", "scripts", ref.name),
        );
      } else if (ref.category) {
        // Category subdirectory — no root fallback
        searchPaths.push(
          path.join(
            this.pathes.localPath,
            "shared",
            "scripts",
            ref.category,
            ref.name,
          ),
        );
        searchPaths.push(
          path.join(
            this.pathes.jsonPath,
            "shared",
            "scripts",
            ref.category,
            ref.name,
          ),
        );
      }

      for (const p of searchPaths) {
        if (fs.existsSync(p)) {
          scriptPath = p;
          break;
        }
      }
    } else {
      const appPath = this.getApplicationPath(ref.applicationId);
      if (appPath) {
        scriptPath = TemplatePathResolver.resolveScriptPath(
          ref.name,
          appPath,
          this.pathes,
          ref.category || "root",
        );
      }
    }
    return scriptPath;
  }

  resolveLibraryPath(ref: ScriptRef): string | null {
    return this.resolveScriptPath(ref);
  }

  getMarkdown(ref: MarkdownRef): string | null {
    const cacheKey = this.getMarkdownCacheKey(ref);
    if (this.enableCache) {
      const cached = this.markdownCache.get(cacheKey);
      if (cached) return cached;
    }
    const templatePath = this.resolveTemplatePathForMarkdown(ref);
    if (!templatePath) return null;
    const mdPath = MarkdownReader.getMarkdownPath(templatePath);
    if (!fs.existsSync(mdPath)) return null;
    const content = fs.readFileSync(mdPath, "utf-8");
    if (
      this.enableCache &&
      mdPath.startsWith(this.pathes.jsonPath + path.sep)
    ) {
      this.markdownCache.set(cacheKey, content);
    }
    return content;
  }

  getMarkdownSection(ref: MarkdownRef, sectionName: string): string | null {
    const cacheKey = this.getMarkdownCacheKey(ref);
    if (this.enableCache) {
      const cached = this.markdownCache.get(cacheKey);
      if (cached) {
        return FileSystemRepositories.extractSectionFromContent(
          cached,
          sectionName,
        );
      }
    }
    const templatePath = this.resolveTemplatePathForMarkdown(ref);
    if (!templatePath) return null;
    const mdPath = MarkdownReader.getMarkdownPath(templatePath);
    return MarkdownReader.extractSection(mdPath, sectionName);
  }

  getLocalResource(ref: LocalResourceRef): Buffer | null {
    const targetPath = path.join(this.pathes.localPath, ref.path);
    if (!fs.existsSync(targetPath)) return null;
    return fs.readFileSync(targetPath);
  }

  private resolveTemplatePathForMarkdown(ref: MarkdownRef): string | null {
    if (ref.scope === "shared") {
      return this.persistence.resolveTemplatePath(ref.templateName, true, ref.category ?? "root");
    }

    const appPath = this.getApplicationPath(ref.applicationId);
    if (!appPath) return null;
    const resolved = TemplatePathResolver.resolveTemplatePath(
      ref.templateName,
      appPath,
      this.pathes,
    );
    return resolved?.fullPath ?? null;
  }

  private getApplicationPath(applicationId?: string): string | null {
    if (!applicationId) return null;
    const normalizedId = applicationId.startsWith("json:")
      ? applicationId.replace(/^json:/, "")
      : applicationId;
    const allApps = this.persistence.getAllAppNames();
    const cached = allApps.get(normalizedId);
    if (cached) return cached;

    const localCandidate = path.join(
      this.pathes.localPath,
      "applications",
      normalizedId,
    );
    if (fs.existsSync(path.join(localCandidate, "application.json"))) {
      return localCandidate;
    }

    const jsonCandidate = path.join(
      this.pathes.jsonPath,
      "applications",
      normalizedId,
    );
    if (fs.existsSync(path.join(jsonCandidate, "application.json"))) {
      return jsonCandidate;
    }

    return null;
  }

  private normalizePath(targetPath: string): string {
    try {
      return fs.realpathSync(targetPath);
    } catch {
      return path.resolve(targetPath);
    }
  }

  private preloadTemplatesFromDir(
    dir: string,
    scope: TemplateScope,
    applicationId?: string,
    category: string = "root",
  ): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Handle subdirectories as categories (for shared scope only)
      if (entry.isDirectory() && scope === "shared") {
        const categoryDir = path.join(dir, entry.name);
        this.preloadTemplatesFromDir(
          categoryDir,
          scope,
          applicationId,
          entry.name,
        );
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const fullPath = path.join(dir, entry.name);
      const template = this.persistence.loadTemplate(fullPath);
      if (!template) continue;
      const name = TemplatePathResolver.normalizeTemplateName(entry.name);
      if (scope === "shared") {
        const ref: TemplateRef = {
          name,
          scope: "shared",
          origin: "json",
          category,
        };
        this.templateCache.set(this.getTemplateCacheKey(ref), template);
      } else if (applicationId) {
        const ref: TemplateRef = {
          name,
          scope: "application",
          applicationId,
          origin: "json",
          category: "",
        };
        this.templateCache.set(this.getTemplateCacheKey(ref), template);
      }

      const mdPath = MarkdownReader.getMarkdownPath(fullPath);
      if (fs.existsSync(mdPath)) {
        const content = fs.readFileSync(mdPath, "utf-8");
        if (scope === "shared") {
          const mdRef: MarkdownRef = { templateName: name, scope: "shared", category };
          this.markdownCache.set(this.getMarkdownCacheKey(mdRef), content);
        } else if (applicationId) {
          const mdRef: MarkdownRef = {
            templateName: name,
            scope: "application",
            applicationId,
          };
          this.markdownCache.set(this.getMarkdownCacheKey(mdRef), content);
        }
      }
    }
  }

  private preloadScriptsFromDir(
    dir: string,
    scope: TemplateScope,
    applicationId?: string,
    category: string = "root",
  ): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Handle subdirectories as categories (for shared scope only)
      if (entry.isDirectory() && scope === "shared") {
        const categoryDir = path.join(dir, entry.name);
        this.preloadScriptsFromDir(
          categoryDir,
          scope,
          applicationId,
          entry.name,
        );
        continue;
      }

      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      const content = fs.readFileSync(fullPath, "utf-8");
      if (scope === "shared") {
        const ref: ScriptRef = {
          name: entry.name,
          scope: "shared",
          category,
        };
        this.scriptCache.set(this.getScriptCacheKey(ref), content);
      } else if (applicationId) {
        const ref: ScriptRef = {
          name: entry.name,
          scope: "application",
          applicationId,
          category: "",
        };
        this.scriptCache.set(this.getScriptCacheKey(ref), content);
      }
    }
  }

  private getTemplateCacheKey(ref: TemplateRef): string {
    return ref.scope === "shared"
      ? `shared:${ref.category}:${ref.name}`
      : `app:${ref.applicationId ?? "unknown"}:${ref.name}`;
  }

  private getScriptCacheKey(ref: ScriptRef): string {
    return ref.scope === "shared"
      ? `shared:${ref.category}:${ref.name}`
      : `app:${ref.applicationId ?? "unknown"}:${ref.name}`;
  }

  private getMarkdownCacheKey(ref: MarkdownRef): string {
    return ref.scope === "shared"
      ? `shared:${ref.category ?? "root"}:${ref.templateName}`
      : `app:${ref.applicationId ?? "unknown"}:${ref.templateName}`;
  }

  private static extractSectionFromContent(
    content: string,
    sectionName: string,
  ): string | null {
    const normalizeHeadingName = (name: string): string => {
      let s = name.trim().toLowerCase();
      s = s.replace(/\s*\{#.*\}\s*$/, "");
      s = s.replace(/:+\s*$/, "");
      s = s.replace(/^`+|`+$/g, "");
      s = s.replace(/\s+/g, " ");
      return s;
    };

    const lines = content.split(/\r?\n/);
    const normalizedSectionName = normalizeHeadingName(sectionName);
    let inSection = false;
    const sectionContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        const headingName = normalizeHeadingName(headingMatch[1]!);
        if (headingName === normalizedSectionName) {
          inSection = true;
          continue;
        } else if (inSection) {
          break;
        }
      } else if (inSection) {
        sectionContent.push(line);
      }
    }

    if (sectionContent.length === 0) return null;
    while (sectionContent.length > 0 && sectionContent[0]!.trim() === "") {
      sectionContent.shift();
    }
    while (
      sectionContent.length > 0 &&
      sectionContent[sectionContent.length - 1]!.trim() === ""
    ) {
      sectionContent.pop();
    }
    return sectionContent.length > 0 ? sectionContent.join("\n") : null;
  }

  /**
   * Checks for duplicate template/script names across different categories.
   * Returns warnings for any duplicates found.
   * This helps identify potential configuration issues where the same
   * file name exists in multiple category directories.
   */
  checkForDuplicates(): string[] {
    const warnings: string[] = [];

    // Track shared templates by name -> categories
    // All keys are "shared:category:name" (3-part) since category is always explicit
    const templatesByName = new Map<string, string[]>();
    for (const key of this.templateCache.keys()) {
      if (!key.startsWith("shared:")) continue;
      const parts = key.split(":");
      if (parts.length !== 3) continue;
      const category = parts[1]!;
      const name = parts[2]!;
      if (!templatesByName.has(name)) {
        templatesByName.set(name, []);
      }
      templatesByName.get(name)!.push(category);
    }

    // Check for templates in multiple categories
    for (const [name, categories] of templatesByName) {
      if (categories.length > 1) {
        warnings.push(
          `Template "${name}" exists in multiple categories: ${categories.join(", ")}`,
        );
      }
    }

    // Track shared scripts by name -> categories
    const scriptsByName = new Map<string, string[]>();
    for (const key of this.scriptCache.keys()) {
      if (!key.startsWith("shared:")) continue;
      const parts = key.split(":");
      if (parts.length !== 3) continue;
      const category = parts[1]!;
      const name = parts[2]!;
      if (!scriptsByName.has(name)) {
        scriptsByName.set(name, []);
      }
      scriptsByName.get(name)!.push(category);
    }

    // Check for scripts in multiple categories
    for (const [name, categories] of scriptsByName) {
      if (categories.length > 1) {
        warnings.push(
          `Script "${name}" exists in multiple categories: ${categories.join(", ")}`,
        );
      }
    }

    return warnings;
  }
}
