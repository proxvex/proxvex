import path from "path";
import fs from "fs";
import {
  IApplication,
  IConfiguredPathes,
  IReadApplicationOptions,
  VEConfigurationError,
} from "../backend-types.mjs";
import { IApplicationWeb } from "../types.mjs";
import { ITemplateReference } from "../backend-types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";
import { JsonError } from "../jsonvalidator.mjs";

/**
 * Handles application-specific persistence operations
 * Separated from main FileSystemPersistence for better organization
 */
export class ApplicationPersistenceHandler {
  // Application Caches
  private appNamesCache: {
    json: Map<string, string> | null;
    local: Map<string, string> | null;
  } = {
    json: null,
    local: null,
  };

  private applicationsListCache: IApplicationWeb[] | null = null;
  private applicationCache: Map<string, { data: IApplication; mtime: number }> =
    new Map();

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
    private enableCache: boolean = true,
  ) {}

  getAllAppNames(): Map<string, string> {
    if (!this.enableCache) {
      // Cache disabled: always scan fresh
      const jsonApps = this.scanApplicationsDir(this.pathes.jsonPath);
      const localApps = this.scanApplicationsDir(this.pathes.localPath);
      const result = new Map(jsonApps);
      for (const [name, appPath] of localApps) {
        result.set(name, appPath);
      }
      return result;
    }

    // JSON: Einmalig laden
    if (this.appNamesCache.json === null) {
      this.appNamesCache.json = this.scanApplicationsDir(this.pathes.jsonPath);
    }

    // Local: Aus Cache (wird durch fs.watch invalidiert)
    if (this.appNamesCache.local === null) {
      this.appNamesCache.local = this.scanApplicationsDir(
        this.pathes.localPath,
      );
    }

    // Merge: Local hat Priorität
    const result = new Map(this.appNamesCache.json);
    for (const [name, appPath] of this.appNamesCache.local) {
      result.set(name, appPath);
    }
    return result;
  }

  /**
   * Returns only local application names mapped to their paths
   * Used for validation when creating new applications - allows creating
   * local applications even if the same ID exists in json directory
   */
  getLocalAppNames(): Map<string, string> {
    if (!this.enableCache) {
      // Cache disabled: always scan fresh
      return this.scanApplicationsDir(this.pathes.localPath);
    }

    // Local: Aus Cache (wird durch fs.watch invalidiert)
    if (this.appNamesCache.local === null) {
      this.appNamesCache.local = this.scanApplicationsDir(
        this.pathes.localPath,
      );
    }

    return new Map(this.appNamesCache.local);
  }

  listApplicationsForFrontend(): IApplicationWeb[] {
    if (!this.enableCache) {
      // Cache disabled: always build fresh
      return this.buildApplicationList();
    }
    // Cache prüfen (wird durch fs.watch invalidiert)
    if (this.applicationsListCache === null) {
      this.applicationsListCache = this.buildApplicationList();
    }
    return this.applicationsListCache;
  }

  /**
   * Baut Application-Liste auf (ohne Templates zu laden!)
   * Jede Application bekommt einen Eintrag, auch wenn fehlerhaft.
   * Fehler werden in der errors Property gesammelt.
   */
  private buildApplicationList(): IApplicationWeb[] {
    const applications: IApplicationWeb[] = [];
    const allApps = this.getAllAppNames();
    const localApps = this.getLocalAppNames();

    // Für jede Application: application.json laden (OHNE Templates!)
    for (const [applicationName] of allApps) {
      const readOpts: IReadApplicationOptions & {
        extendsChain?: string[];
        appSource?: "local" | "json";
      } = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", applicationName),
        taskTemplates: [], // Wird nur für Validierung verwendet, nicht geladen
        extendsChain: [],
      };

      // Determine source: local or json
      const source: "local" | "json" = localApps.has(applicationName)
        ? "local"
        : "json";
      readOpts.appSource = source;

      let appWeb: IApplicationWeb;

      try {
        // Use lightweight version that doesn't process templates
        const app = this.readApplicationLightweight(applicationName, readOpts);

        // Skip hidden applications (e.g. proxmox host)
        if (app.hidden) {
          continue;
        }

        // Determine framework from extends chain
        const framework = this.determineFramework(readOpts.extendsChain || []);

        appWeb = {
          id: app.id,
          name: app.name,
          description: app.description || "No description available",
          icon: app.icon,
          iconContent: app.iconContent,
          iconType: app.iconType,
          tags: app.tags,
          source,
          framework,
          extends: app.extends,
          stacktype: app.stacktype,
          verification: app.verification,
          ...(app.errors &&
            app.errors.length > 0 && {
              errors: app.errors.map((e) => ({
                message: e,
                name: "Error",
                details: undefined,
              })),
            }),
        };
      } catch (e: Error | any) {
        // Loading failed - create minimal entry with error
        appWeb = {
          id: applicationName,
          name: applicationName,
          description: "Failed to load application",
          source,
          errors: [
            {
              name: e?.name || "Error",
              message: e?.message || String(e),
              details: e?.details,
            },
          ],
        };
      }

      // Attach any accumulated errors from readOpts
      if (readOpts.error.details && readOpts.error.details.length > 0) {
        const convertedErrors = readOpts.error.details.map((e) => ({
          name: e?.name || "Error",
          message: e?.message || String(e),
          details: e?.details,
        }));

        if (appWeb.errors) {
          // Merge with existing errors (avoid duplicates)
          appWeb.errors = [...appWeb.errors, ...convertedErrors];
        } else {
          appWeb.errors = convertedErrors;
        }
      }

      applications.push(appWeb);
    }

    return applications;
  }

  /**
   * Determines the framework from the extends chain.
   * Known frameworks: oci-image, docker-compose, npm-nodejs
   * Returns undefined if no known framework is in the chain (native app)
   */
  private determineFramework(extendsChain: string[]): string | undefined {
    const knownFrameworks = ["oci-image", "docker-compose", "npm-nodejs"];
    for (const appId of extendsChain) {
      if (knownFrameworks.includes(appId)) {
        return appId;
      }
    }
    return undefined;
  }

  /**
   * Resolves application path and file from application name.
   * Handles "json:" prefix and local/json directory lookup.
   */
  private resolveApplicationPath(
    applicationName: string,
    opts: IReadApplicationOptions,
  ): { appName: string; appPath: string; appFile: string } {
    let appName = applicationName;
    let appPath: string;
    let appFile: string;

    if (applicationName.startsWith("json:")) {
      appName = applicationName.replace(/^json:/, "");
      appPath = path.join(this.pathes.jsonPath, "applications", appName);
      appFile = path.join(appPath, "application.json");
      if (!fs.existsSync(appFile)) {
        throw new Error(`application.json not found for ${applicationName}`);
      }
    } else {
      const localPath = path.join(
        this.pathes.localPath,
        "applications",
        applicationName,
        "application.json",
      );
      const jsonPath = path.join(
        this.pathes.jsonPath,
        "applications",
        applicationName,
        "application.json",
      );
      if (fs.existsSync(localPath)) {
        appFile = localPath;
        appPath = path.dirname(localPath);
      } else if (fs.existsSync(this.pathes.jsonPath)) {
        appFile = jsonPath;
        appPath = path.dirname(jsonPath);
      } else {
        throw new Error(`application.json not found for ${applicationName}`);
      }
    }

    // Check for cyclic inheritance
    if (opts.applicationHierarchy.includes(appPath)) {
      throw new Error(
        `Cyclic inheritance detected for application: ${appName}`,
      );
    }

    return { appName, appPath, appFile };
  }

  /**
   * Deserializes application.json and initializes hierarchy tracking.
   */
  private deserializeAndInitApp(
    appFile: string,
    appName: string,
    appPath: string,
    applicationName: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    let appData: IApplication;
    try {
      appData = this.jsonValidator.serializeJsonFileWithSchema<IApplication>(
        appFile,
        "application",
      );
    } catch (e: Error | any) {
      appData = {
        id: applicationName,
        name: applicationName,
      } as IApplication;
      this.addErrorToOptions(opts, e);
    }

    appData.id = appName;

    if (!opts.application) {
      opts.application = appData;
      opts.appPath = appPath;
    }
    opts.applicationHierarchy.push(appPath);

    return appData;
  }

  /**
   * Resolves icon for an application: checks local icon file, then inherited icon.
   */
  private resolveAppIcon(
    appData: IApplication,
    appPath: string,
    opts: IReadApplicationOptions,
  ): void {
    const iconFile = appPath
      ? this.findIconFile(appPath, appData?.icon)
      : null;
    if (iconFile) {
      appData.icon = iconFile;
      appData.iconContent = fs.readFileSync(path.join(appPath, iconFile), {
        encoding: "base64",
      });
      const ext = path.extname(iconFile).toLowerCase();
      appData.iconType = ext === ".svg" ? "image/svg+xml" : "image/png";
      (opts as any).inheritedIcon = iconFile;
      (opts as any).inheritedIconContent = appData.iconContent;
      (opts as any).inheritedIconType = appData.iconType;
    } else if ((opts as any).inheritedIconContent) {
      appData.icon = (opts as any).inheritedIcon || "icon.png";
      appData.iconContent = (opts as any).inheritedIconContent;
      appData.iconType = (opts as any).inheritedIconType;
    }
  }

  /**
   * Checks if a template already exists in a task's template list.
   * Reports error if duplicate found.
   * @returns true if duplicate was found (caller should skip adding)
   */
  private isTemplateDuplicate(
    taskEntry: { templates: (string | ITemplateReference)[] },
    name: string,
    taskName: string,
    opts: IReadApplicationOptions,
  ): boolean {
    const existingTemplates = taskEntry.templates.map((t) =>
      typeof t === "string" ? t : (t as ITemplateReference).name,
    );
    if (existingTemplates.includes(name)) {
      const error = new JsonError(
        `Template '${name}' appears multiple times in ${taskName} task. Each template can only appear once per task.`,
      );
      this.addErrorToOptions(opts, error);
      return true;
    }
    return false;
  }

  /**
   * Lightweight version of readApplication that only loads metadata (id, name, description, icon)
   * without processing templates. Used for building the application list for the frontend.
   */
  private readApplicationLightweight(
    applicationName: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    const { appName, appPath, appFile } = this.resolveApplicationPath(applicationName, opts);

    try {
      const appData = this.deserializeAndInitApp(appFile, appName, appPath, applicationName, opts);

      // Recursive inheritance - load parent first to get icon data
      if (appData.extends) {
        const extendsOpts = opts as typeof opts & { extendsChain?: string[] };
        if (extendsOpts.extendsChain) {
          extendsOpts.extendsChain.push(appData.extends);
        }
        try {
          const parent = this.readApplicationLightweight(appData.extends, opts);
          if (!appData.icon && parent.icon) {
            appData.icon = parent.icon;
            appData.iconContent = parent.iconContent;
            appData.iconType = parent.iconType;
          }
        } catch (e: Error | any) {
          this.addErrorToOptions(opts, e);
        }
      }

      this.resolveAppIcon(appData, appPath, opts);

      // NOTE: We intentionally skip processTemplates() here for performance
      return appData;
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }
    throw opts.error;
  }

  readApplication(
    applicationName: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    const { appName, appPath, appFile } = this.resolveApplicationPath(applicationName, opts);

    // Check cache first (only for local apps)
    const isLocal = appPath.startsWith(this.pathes.localPath);
    if (isLocal) {
      const appFileStat = fs.statSync(appFile);
      const mtime = appFileStat.mtimeMs;
      const cached = this.applicationCache.get(applicationName);
      if (cached && cached.mtime === mtime) {
        // Return cached, but need to process inheritance/templates
        // For now, we'll reload to ensure consistency
        // TODO: Optimize to reuse cached data with proper inheritance handling
      }
    }

    try {
      const appData = this.deserializeAndInitApp(appFile, appName, appPath, applicationName, opts);

      // Recursive inheritance - load parent first to get icon data AND templates
      if (appData.extends) {
        try {
          const parent = this.readApplication(appData.extends, opts);
          if (!appData.icon && parent.icon) {
            appData.icon = parent.icon;
            appData.iconContent = parent.iconContent;
            appData.iconType = parent.iconType;
          }
          // Merge supported_addons: parent + child, deduplicated
          if (parent.supported_addons?.length || appData.supported_addons?.length) {
            appData.supported_addons = [
              ...new Set([
                ...(parent.supported_addons ?? []),
                ...(appData.supported_addons ?? []),
              ]),
            ];
          }
        } catch (e: Error | any) {
          this.addErrorToOptions(opts, e);
        }
      }

      this.resolveAppIcon(appData, appPath, opts);

      // Process templates (adds template references to opts.taskTemplates)
      this.processTemplates(appData, opts);

      // Cache only local apps
      if (isLocal) {
        const mtime = fs.statSync(appFile).mtimeMs;
        this.applicationCache.set(applicationName, { data: appData, mtime });
      }

      return appData;
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }
    throw opts.error;
  }

  /**
   * Find icon file in a directory with priority:
   * 1. iconHint (custom name from application.json "icon" property)
   * 2. Standard names: icon.png, icon.svg
   * 3. Any .svg or .png file in the directory
   * Returns the filename (not full path) or null if not found.
   */
  private findIconFile(dir: string, iconHint?: string): string | null {
    const candidates: string[] = [];

    if (iconHint) candidates.push(iconHint);
    candidates.push("icon.png", "icon.svg");

    // Any .svg or .png file in the directory
    try {
      const files = fs.readdirSync(dir);
      const svgFile = files.find(
        (f) => f.endsWith(".svg") && !candidates.includes(f),
      );
      if (svgFile) candidates.push(svgFile);
      const pngFile = files.find(
        (f) => f.endsWith(".png") && !candidates.includes(f),
      );
      if (pngFile) candidates.push(pngFile);
    } catch {
      // ignore readdir errors
    }

    for (const name of candidates) {
      if (fs.existsSync(path.join(dir, name))) return name;
    }
    return null;
  }

  readApplicationIcon(applicationName: string): {
    iconContent: string;
    iconType: string;
  } | null {
    const appPath = this.getAllAppNames().get(applicationName);
    if (!appPath) {
      return null;
    }

    // Read icon hint from application.json
    let iconHint: string | undefined;
    const appJsonPath = path.join(appPath, "application.json");
    if (fs.existsSync(appJsonPath)) {
      try {
        const appData = JSON.parse(
          fs.readFileSync(appJsonPath, { encoding: "utf-8" }),
        );
        iconHint = appData.icon;
      } catch {
        // ignore parse errors
      }
    }

    const iconName = this.findIconFile(appPath, iconHint);
    if (iconName) {
      const iconPath = path.join(appPath, iconName);
      const ext = path.extname(iconName).toLowerCase();
      const iconType = ext === ".svg" ? "image/svg+xml" : "image/png";

      if (ext === ".svg") {
        // For SVG: normalize size to 16x16 before base64 encoding
        const svgContent = fs.readFileSync(iconPath, { encoding: "utf-8" });
        const normalizedSvg = this.normalizeSvgSize(svgContent, 64);
        const iconContent = Buffer.from(normalizedSvg, "utf-8").toString(
          "base64",
        );
        return { iconContent, iconType };
      } else {
        const iconContent = fs.readFileSync(iconPath, { encoding: "base64" });
        return { iconContent, iconType };
      }
    }

    const fallbackSvg = this.generateFallbackIconSvg(applicationName);
    return {
      iconContent: Buffer.from(fallbackSvg, "utf-8").toString("base64"),
      iconType: "image/svg+xml",
    };
  }

  private generateFallbackIconSvg(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    const hue2 = (hue + 45) % 360;
    const bg = `hsl(${hue}, 65%, 45%)`;
    const fg = `hsl(${hue2}, 70%, 75%)`;
    const size = 16;
    const pad = 12;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 3;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
      `<rect width="${size}" height="${size}" rx="18" ry="18" fill="${bg}"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fg}"/>`,
      `<rect x="${pad}" y="${pad}" width="${size - pad * 2}" height="${size - pad * 2}" rx="14" ry="14" fill="none" stroke="${fg}" stroke-width="6"/>`,
      `</svg>`,
    ].join("");
  }

  /**
   * Normalizes SVG size by setting width/height attributes to a fixed size.
   * Handles multiline <svg> tags and SVGs with only viewBox (no width/height).
   * Preserves viewBox for proper scaling.
   */
  private normalizeSvgSize(svgContent: string, size: number): string {
    // Extract the <svg ...> opening tag (may span multiple lines)
    const svgTagMatch = svgContent.match(/<svg\b[^>]*>/is);
    if (!svgTagMatch) return svgContent;

    let svgTag = svgTagMatch[0];

    // Replace or add width attribute
    if (/\swidth\s*=\s*["'][^"']*["']/i.test(svgTag)) {
      svgTag = svgTag.replace(
        /\swidth\s*=\s*["'][^"']*["']/i,
        ` width="${size}"`,
      );
    } else {
      svgTag = svgTag.replace(/<svg\b/i, `<svg width="${size}"`);
    }

    // Replace or add height attribute
    if (/\sheight\s*=\s*["'][^"']*["']/i.test(svgTag)) {
      svgTag = svgTag.replace(
        /\sheight\s*=\s*["'][^"']*["']/i,
        ` height="${size}"`,
      );
    } else {
      svgTag = svgTag.replace(/<svg\b/i, `<svg height="${size}"`);
    }

    return svgContent.replace(svgTagMatch[0], svgTag);
  }

  writeApplication(applicationName: string, application: IApplication): void {
    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      applicationName,
    );
    fs.mkdirSync(appDir, { recursive: true });

    const appFile = path.join(appDir, "application.json");
    fs.writeFileSync(appFile, JSON.stringify(application, null, 2));

    // Invalidate caches (fs.watch wird auch triggern, aber manuell ist sicherer)
    this.invalidateApplicationCache(applicationName);
  }

  deleteApplication(applicationName: string): void {
    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      applicationName,
    );
    fs.rmSync(appDir, { recursive: true, force: true });

    // Invalidate caches
    this.invalidateApplicationCache(applicationName);
  }

  invalidateApplicationCache(applicationName?: string): void {
    this.appNamesCache.local = null;
    this.applicationsListCache = null;
    if (applicationName) {
      this.applicationCache.delete(applicationName);
    } else {
      this.applicationCache.clear();
    }
  }

  invalidateAllCaches(): void {
    this.appNamesCache.json = null;
    this.appNamesCache.local = null;
    this.applicationsListCache = null;
    this.applicationCache.clear();
  }

  // Helper methods

  private scanApplicationsDir(basePath: string): Map<string, string> {
    const apps = new Map<string, string>();
    const appsDir = path.join(basePath, "applications");

    if (!fs.existsSync(appsDir)) return apps;

    const entries = fs.readdirSync(appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const appJsonPath = path.join(appsDir, entry.name, "application.json");
        if (fs.existsSync(appJsonPath)) {
          apps.set(entry.name, path.join(appsDir, entry.name));
        }
      }
    }

    return apps;
  }

  private addErrorToOptions(
    opts: IReadApplicationOptions | { error: VEConfigurationError },
    error: Error | any,
  ): void {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    }
  }

  /**
   * Processes templates from application data and adds them to opts.taskTemplates
   * This is similar to ApplicationLoader.processTemplates
   */
  private processTemplates(
    appData: IApplication,
    opts: IReadApplicationOptions,
  ): void {
    // Installation uses category-based format: { image, pre_start, start, post_start }
    const installationCategories = ["image", "create_ct", "pre_start", "start", "post_start", "replace_ct"];
    const installation = (appData as any).installation;
    if (installation && typeof installation === "object") {
      let taskEntry = opts.taskTemplates.find((t) => t.task === "installation");
      if (!taskEntry) {
        taskEntry = { task: "installation", templates: [] };
        opts.taskTemplates.push(taskEntry);
      }

      for (const category of installationCategories) {
        const list = installation[category];
        if (Array.isArray(list)) {
          this.processTemplateList(list, taskEntry, "installation", opts, category);
        }
      }
    }

    // upgrade, reconfigure: support both array (flat) and object (category-based) format
    for (const key of ["upgrade", "reconfigure"] as const) {
      const value = (appData as any)[key];
      if (!value) continue;

      let taskEntry = opts.taskTemplates.find((t) => t.task === key);
      if (!taskEntry) {
        taskEntry = { task: key, templates: [] };
        opts.taskTemplates.push(taskEntry);
      }

      if (Array.isArray(value)) {
        // Simple array format (backward compatible) - uses "root" category
        this.processTemplateList(value, taskEntry, key, opts, "root");
      } else if (typeof value === "object") {
        // Category-based format (like installation)
        for (const category of installationCategories) {
          const list = value[category];
          if (Array.isArray(list)) {
            this.processTemplateList(list, taskEntry, key, opts, category);
          }
        }
      }
    }

    // Other tasks use simple array format
    const otherTaskKeys = [
      "backup",
      "restore",
      "uninstall",
      "update",
      "addon",
      "webui",
    ];

    for (const key of otherTaskKeys) {
      const list = (appData as any)[key];
      if (Array.isArray(list)) {
        let taskEntry = opts.taskTemplates.find((t) => t.task === key);
        if (!taskEntry) {
          taskEntry = { task: key, templates: [] };
          opts.taskTemplates.push(taskEntry);
        }
        this.processTemplateList(list, taskEntry, key, opts, "root");
      }
    }
  }

  /**
   * Processes a list of template entries and adds them to the task entry
   * @param category Category for shared template resolution (e.g., "image", "pre_start", "root")
   */
  private processTemplateList(
    list: any[],
    taskEntry: { task: string; templates: (ITemplateReference | string)[] },
    taskName: string,
    opts: IReadApplicationOptions,
    category: string,
  ): void {
    for (const entry of list) {
      if (typeof entry === "string") {
        // Convert string to ITemplateReference with explicit category
        this.addTemplateToTask({ name: entry, category }, taskEntry, taskName, opts);
      } else if (typeof entry === "object" && entry !== null) {
        const templateRef = entry as ITemplateReference;
        const name = templateRef.name;
        if (!name) continue;
        // Attach category if not already specified
        if (category && !templateRef.category) {
          templateRef.category = category;
        }
        // Handle position: "start" inserts at the beginning of the category group
        if (templateRef.position === "start") {
          if (!this.isTemplateDuplicate(taskEntry, name, taskName, opts)) {
            const startIdx = this.findCategoryStartIndex(
              taskEntry.templates,
              templateRef.category ?? category,
            );
            taskEntry.templates.splice(startIdx, 0, templateRef);
          }
          continue;
        }
        // Default (position "end" or unspecified): add at end of category group
        this.addTemplateToTask(templateRef, taskEntry, taskName, opts);
      }
    }
  }

  /**
   * Adds a template to the task entry. Duplicates are not allowed and will cause an error.
   * Templates are inserted at the correct position based on their category order.
   */
  private addTemplateToTask(
    template: ITemplateReference | string,
    taskEntry: { task: string; templates: (ITemplateReference | string)[] },
    taskName: string,
    opts: IReadApplicationOptions,
  ): void {
    // Check for duplicates - duplicates are not allowed
    const templateNameStr =
      typeof template === "string" ? template : template.name;
    const existingTemplates = taskEntry.templates.map((t) =>
      typeof t === "string" ? t : (t as ITemplateReference).name,
    );
    if (existingTemplates.includes(templateNameStr)) {
      const error = new JsonError(
        `Template '${templateNameStr}' appears multiple times in ${taskName} task. Each template can only appear once per task.`,
      );
      this.addErrorToOptions(opts, error);
      return; // Don't add duplicate
    }

    // Get category of the new template
    const newCategory =
      typeof template === "string" ? "root" : (template.category ?? "root");

    // Insert at correct position based on category order
    const insertIndex = this.findCategoryInsertIndex(
      taskEntry.templates,
      newCategory,
    );
    taskEntry.templates.splice(insertIndex, 0, template);
  }

  /**
   * Category order for installation tasks.
   * Templates are grouped by category in this order.
   */
  private static readonly CATEGORY_ORDER = [
    "image",
    "create_ct",
    "pre_start",
    "start",
    "post_start",
    "replace_ct",
  ];

  /**
   * Finds the correct insert index for a template based on its category.
   * Templates of the same category are appended at the end of that category group.
   * Templates without category go to the end.
   */
  private findCategoryInsertIndex(
    templates: (ITemplateReference | string)[],
    category: string,
  ): number {
    const categoryIndex =
      ApplicationPersistenceHandler.CATEGORY_ORDER.indexOf(category);
    if (categoryIndex === -1) {
      // Unknown or root category: append at end
      return templates.length;
    }

    // Find the first template that belongs to a later category
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const existingCategory =
        typeof t === "string" ? "root" : (t as ITemplateReference).category ?? "root";

      const existingCategoryIndex =
        ApplicationPersistenceHandler.CATEGORY_ORDER.indexOf(existingCategory);
      if (existingCategoryIndex !== -1 && existingCategoryIndex > categoryIndex) {
        // Found a template from a later category - insert before it
        return i;
      }
    }

    // No later category found, append at end
    return templates.length;
  }

  /**
   * Finds the index of the first template in the given category.
   * Used for position: "start" to insert before existing templates of the same category.
   * Falls back to findCategoryInsertIndex if no template of that category exists yet.
   */
  private findCategoryStartIndex(
    templates: (ITemplateReference | string)[],
    category: string,
  ): number {
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const cat =
        typeof t === "string" ? "root" : (t as ITemplateReference).category ?? "root";
      if (cat === category) return i;
    }
    return this.findCategoryInsertIndex(templates, category);
  }
}
