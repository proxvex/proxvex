#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import type { IConfiguredPathes } from "../backend-types.mjs";
import type { ITemplate } from "../types.mjs";

/**
 * Utility class for resolving template and script paths.
 * Provides centralized path resolution logic that can be reused across the codebase.
 */
export class TemplatePathResolver {
  /**
   * Resolves template path (checks local first, then shared).
   * @param templateName Template name (with or without .json extension)
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @param category Category subdirectory for shared templates. Use "root" for root-level templates.
   * @returns Object with fullPath, isShared flag, and category, or null if not found
   */
  static resolveTemplatePath(
    templateName: string,
    appPath: string,
    pathes: IConfiguredPathes,
    category: string = "root",
  ): { fullPath: string; isShared: boolean; category: string } | null {
    // Ensure template name has .json extension
    const templateNameWithExt = templateName.endsWith(".json")
      ? templateName
      : `${templateName}.json`;
    const templatePath = path.join(appPath, "templates", templateNameWithExt);

    // Check app-specific first
    if (fs.existsSync(templatePath)) {
      return { fullPath: templatePath, isShared: false, category };
    }

    // Search order: local → hub → json
    const sharedBases = [pathes.localPath, pathes.hubPath, pathes.jsonPath].filter(Boolean) as string[];

    if (category === "root") {
      for (const base of sharedBases) {
        const p = path.join(base, "shared", "templates", templateNameWithExt);
        if (fs.existsSync(p)) {
          return { fullPath: p, isShared: true, category: "root" };
        }
      }
    } else {
      for (const base of sharedBases) {
        const p = path.join(base, "shared", "templates", category, templateNameWithExt);
        if (fs.existsSync(p)) {
          return { fullPath: p, isShared: true, category };
        }
      }
    }

    return null;
  }

  /**
   * Resolves script path (checks application scripts, then shared scripts).
   * @param scriptName Script name (e.g., "test-script.sh")
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @param category Category subdirectory for shared scripts. Use "root" for root-level scripts.
   * @returns Full path to script or null if not found
   */
  static resolveScriptPath(
    scriptName: string,
    appPath: string,
    pathes: IConfiguredPathes,
    category: string = "root",
  ): string | null {
    // Check app-specific first (with category subdirectory, then without)
    if (category !== "root") {
      const appCategoryPath = path.join(appPath, "scripts", category, scriptName);
      if (fs.existsSync(appCategoryPath)) {
        return appCategoryPath;
      }
    }
    const appScriptPath = path.join(appPath, "scripts", scriptName);
    if (fs.existsSync(appScriptPath)) {
      return appScriptPath;
    }

    // Search order: local → hub → json
    const sharedBases = [pathes.localPath, pathes.hubPath, pathes.jsonPath].filter(Boolean) as string[];

    if (category === "root") {
      for (const base of sharedBases) {
        const p = path.join(base, "shared", "scripts", scriptName);
        if (fs.existsSync(p)) return p;
      }
    } else {
      for (const base of sharedBases) {
        const p = path.join(base, "shared", "scripts", category, scriptName);
        if (fs.existsSync(p)) return p;
      }
    }

    return null;
  }

  /**
   * Normalizes template name by removing .json extension.
   * @param templateName Template name (with or without .json extension)
   * @returns Normalized template name without .json extension
   */
  static normalizeTemplateName(templateName: string): string {
    return templateName.replace(/\.json$/, "");
  }

  /**
   * Generates markdown documentation filename from template name.
   * @param templateName Template name (with or without .json extension)
   * @returns Markdown filename (e.g., "test-template.md")
   */
  static getTemplateDocName(templateName: string): string {
    return templateName.endsWith(".json")
      ? templateName.slice(0, -5) + ".md"
      : templateName + ".md";
  }

  /**
   * Loads a template from file system.
   * @param templateName Template name (with or without .json extension)
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @returns Template data or null if not found/error
   */
  static loadTemplate(
    templateName: string,
    appPath: string,
    pathes: IConfiguredPathes,
  ): ITemplate | null {
    const resolved = this.resolveTemplatePath(templateName, appPath, pathes);
    if (!resolved) {
      return null;
    }

    try {
      return JSON.parse(
        fs.readFileSync(resolved.fullPath, "utf-8"),
      ) as ITemplate;
    } catch {
      return null;
    }
  }

  /**
   * Extracts all template references from a template's commands.
   * @param templateData Template data
   * @returns Array of template names referenced in commands
   */
  static extractTemplateReferences(templateData: ITemplate): string[] {
    const references: string[] = [];

    if (templateData.commands && Array.isArray(templateData.commands)) {
      for (const cmd of templateData.commands) {
        if (cmd && cmd.template) {
          references.push(cmd.template);
        }
      }
    }

    return references;
  }

  /**
   * Finds a file in an array of base paths (searches in order, returns first match).
   * This is used by TemplateProcessor which searches through application hierarchy.
   * @param pathes Array of base paths to search in
   * @param name File name to find (e.g., "template.json" or "script.sh")
   * @returns Full path to file or undefined if not found
   */
  static findInPathes(pathes: string[], name: string): string | undefined {
    for (const basePath of pathes) {
      const candidate = path.join(basePath, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Builds template paths array from application hierarchy.
   * @param applicationHierarchy Array of application paths (from parent to child)
   * @param pathes Configured paths
   * @param category Category subdirectory. Use "root" for root-level templates.
   * @returns Array of template directory paths to search
   */
  static buildTemplatePathes(
    applicationHierarchy: string[],
    pathes: IConfiguredPathes,
    category: string = "root",
  ): string[] {
    const templatePathes = applicationHierarchy.map((appDir) =>
      path.join(appDir, "templates"),
    );

    // Search order: local → hub → json
    const sharedBases = [pathes.localPath, pathes.hubPath, pathes.jsonPath].filter(Boolean) as string[];
    for (const base of sharedBases) {
      templatePathes.push(
        category === "root"
          ? path.join(base, "shared", "templates")
          : path.join(base, "shared", "templates", category),
      );
    }

    return templatePathes;
  }

  /**
   * Builds script paths array from application hierarchy.
   * @param applicationHierarchy Array of application paths (from parent to child)
   * @param pathes Configured paths
   * @param category Category subdirectory. Use "root" for root-level scripts.
   * @returns Array of script directory paths to search
   */
  static buildScriptPathes(
    applicationHierarchy: string[],
    pathes: IConfiguredPathes,
    category: string = "root",
  ): string[] {
    const scriptPathes = applicationHierarchy.map((appDir) =>
      path.join(appDir, "scripts"),
    );

    // Search order: local → hub → json
    const sharedScriptBases = [pathes.localPath, pathes.hubPath, pathes.jsonPath].filter(Boolean) as string[];
    for (const base of sharedScriptBases) {
      scriptPathes.push(
        category === "root"
          ? path.join(base, "shared", "scripts")
          : path.join(base, "shared", "scripts", category),
      );
    }

    return scriptPathes;
  }
}
