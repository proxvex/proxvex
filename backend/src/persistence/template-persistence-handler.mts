import path from "path";
import fs from "fs";
import { IConfiguredPathes } from "../backend-types.mjs";
import { ITemplate } from "../types.mjs";
import { JsonError, JsonValidator } from "../jsonvalidator.mjs";

/**
 * Handles template-specific persistence operations
 * Separated from main FileSystemPersistence for better organization
 */
export class TemplatePersistenceHandler {
  // Template Cache
  private templateCache: Map<string, { data: ITemplate; mtime: number }> =
    new Map();

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
    private enableCache: boolean = true,
  ) {}

  resolveTemplatePath(
    templateName: string,
    isShared: boolean,
    category: string = "root",
  ): string | null {
    if (isShared) {
      const templateFileName = templateName.endsWith(".json")
        ? templateName
        : `${templateName}.json`;

      // Search order: local → hub → json
      const bases = [this.pathes.localPath, this.pathes.hubPath, this.pathes.jsonPath].filter(Boolean) as string[];
      const searchPaths: string[] = [];

      for (const base of bases) {
        searchPaths.push(
          category === "root"
            ? path.join(base, "shared", "templates", templateFileName)
            : path.join(base, "shared", "templates", category, templateFileName),
        );
      }

      for (const p of searchPaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
      return null;
    } else {
      // Application-specific template - need appPath
      // This method signature doesn't include appPath, so we can't resolve it here
      // This is a limitation - we might need to adjust the interface
      // For now, return null
      return null;
    }
  }

  loadTemplate(templatePath: string): ITemplate | null {
    // Check cache first
    if (!fs.existsSync(templatePath)) {
      return null;
    }

    const mtime = fs.statSync(templatePath).mtimeMs;
    if (this.enableCache) {
      const cached = this.templateCache.get(templatePath);
      if (cached && cached.mtime === mtime) {
        return cached.data;
      }
    }

    // Load and validate
    try {
      const templateData =
        this.jsonValidator.serializeJsonFileWithSchema<ITemplate>(
          templatePath,
          "template",
        );

      // Cache it
      if (this.enableCache) {
        this.templateCache.set(templatePath, { data: templateData, mtime });
      }

      return templateData;
    } catch (e: Error | any) {
      // Preserve validation details for UI error dialog
      if (e && typeof e === "object" && (e as any).name === "JsonError") {
        throw e;
      }
      throw new JsonError(
        `Failed to load template from ${templatePath}`,
        e ? [e] : undefined,
        templatePath,
      );
    }
  }

  writeTemplate(
    templateName: string,
    template: ITemplate,
    isShared: boolean,
    appPath?: string,
    category?: string,
  ): void {
    const templateFileName = templateName.endsWith(".json")
      ? templateName
      : `${templateName}.json`;

    if (isShared) {
      const templateDir = category
        ? path.join(this.pathes.localPath, "shared", "templates", category)
        : path.join(this.pathes.localPath, "shared", "templates");
      fs.mkdirSync(templateDir, { recursive: true });
      const templateFile = path.join(templateDir, templateFileName);
      fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));
    } else {
      // Application-specific template - need appPath
      if (!appPath) {
        throw new Error(
          "Writing application-specific templates requires appPath parameter",
        );
      }
      const templatesDir = path.join(appPath, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, templateFileName);
      fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));
    }

    // Invalidate cache
    this.templateCache.clear();
  }

  deleteTemplate(
    templateName: string,
    isShared: boolean,
    category?: string,
  ): void {
    const templateFileName = templateName.endsWith(".json")
      ? templateName
      : `${templateName}.json`;

    if (isShared) {
      const templateDir = category
        ? path.join(this.pathes.localPath, "shared", "templates", category)
        : path.join(this.pathes.localPath, "shared", "templates");
      const templateFile = path.join(templateDir, templateFileName);
      if (fs.existsSync(templateFile)) {
        fs.unlinkSync(templateFile);
      }
    } else {
      // Application-specific template - need appPath
      throw new Error(
        "Deleting application-specific templates requires appPath (not implemented)",
      );
    }

    // Invalidate cache
    this.templateCache.clear();
  }

  writeScript(
    scriptName: string,
    content: string,
    isShared: boolean,
    appPath?: string,
    category?: string,
  ): void {
    if (isShared) {
      const scriptDir = category
        ? path.join(this.pathes.localPath, "shared", "scripts", category)
        : path.join(this.pathes.localPath, "shared", "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(path.join(scriptDir, scriptName), content);
    } else {
      if (!appPath) {
        throw new Error(
          "Writing application-specific scripts requires appPath parameter",
        );
      }
      const scriptsDir = path.join(appPath, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, scriptName), content);
    }
  }

  invalidateCache(): void {
    this.templateCache.clear();
  }
}
