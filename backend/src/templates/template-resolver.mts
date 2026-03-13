import { ITemplate } from "@src/types.mjs";
import { ITemplateReference } from "../backend-types.mjs";
import {
  type TemplateRef,
  type ScriptRef,
  type MarkdownRef,
  type IRepositories,
} from "../persistence/repositories.mjs";

export class TemplateResolver {
  constructor(private repositories: IRepositories) {}

  extractTemplateName(template: ITemplateReference | string): string {
    return typeof template === "string" ? template : template.name;
  }

  extractTemplateCategory(template: ITemplateReference | string): string {
    if (typeof template === "string") return "root";
    return template.category ?? "root";
  }

  normalizeTemplateName(templateName: string): string {
    return templateName.replace(/\.json$/i, "");
  }

  buildTemplateTracePath(ref: TemplateRef): string {
    const normalized = this.normalizeTemplateName(ref.name);
    const filename = `${normalized}.json`;
    if (ref.scope === "shared") {
      const origin = ref.origin ?? "json";
      const categoryPath = ref.category && ref.category !== "root" ? `${ref.category}/` : "";
      return `${origin}/shared/templates/${categoryPath}${filename}`;
    }
    const origin = ref.origin ?? "json";
    const appId = ref.applicationId ?? "unknown-app";
    return `${origin}/applications/${appId}/templates/${filename}`;
  }

  resolveTemplate(
    applicationId: string,
    templateName: string,
    category: string,
  ): { template: ITemplate; ref: TemplateRef } | null {
    const ref = this.repositories.resolveTemplateRef(
      applicationId,
      templateName,
      category,
    );
    if (!ref) return null;
    const template = this.repositories.getTemplate(ref);
    if (!template) return null;
    return { template, ref };
  }

  resolveScriptContent(
    applicationId: string,
    scriptName: string,
    category: string,
  ): { content: string | null; ref: ScriptRef | null } {
    // First try app-specific (with category for subdirectory lookup)
    const appRef: ScriptRef = {
      name: scriptName,
      scope: "application",
      applicationId,
      category,
    };
    const appContent = this.repositories.getScript(appRef);
    if (appContent !== null) return { content: appContent, ref: appRef };

    // Then try shared with category
    const sharedCategoryRef: ScriptRef = {
      name: scriptName,
      scope: "shared",
      category,
    };
    const sharedCategoryContent =
      this.repositories.getScript(sharedCategoryRef);
    if (sharedCategoryContent !== null) {
      return { content: sharedCategoryContent, ref: sharedCategoryRef };
    }

    return { content: null, ref: null };
  }

  resolveScriptPath(ref: ScriptRef | null): string | null {
    if (!ref) return null;
    return this.repositories.resolveScriptPath(ref);
  }

  resolveLibraryContent(
    applicationId: string,
    libraryName: string,
  ): { content: string | null; ref: ScriptRef | null } {
    // First try app-specific
    const appRef: ScriptRef = {
      name: libraryName,
      scope: "application",
      applicationId,
      category: "",
    };
    const appContent = this.repositories.getScript(appRef);
    if (appContent !== null) return { content: appContent, ref: appRef };

    // Then try shared library category (libraries live in shared/scripts/library/)
    const sharedRootRef: ScriptRef = {
      name: libraryName,
      scope: "shared",
      category: "library",
    };
    const sharedRootContent = this.repositories.getScript(sharedRootRef);
    if (sharedRootContent !== null)
      return { content: sharedRootContent, ref: sharedRootRef };

    return { content: null, ref: null };
  }

  resolveLibraryPath(ref: ScriptRef | null): string | null {
    if (!ref) return null;
    return this.repositories.resolveLibraryPath(ref);
  }

  resolveMarkdownSection(ref: TemplateRef, sectionName: string): string | null {
    if (ref.scope !== "shared" && ref.applicationId === undefined) {
      return null;
    }
    const markdownRef: MarkdownRef = {
      templateName: this.normalizeTemplateName(ref.name),
      scope: ref.scope,
      ...(ref.applicationId !== undefined
        ? { applicationId: ref.applicationId }
        : {}),
      ...(ref.scope === "shared" ? { category: ref.category } : {}),
    };
    return this.repositories.getMarkdownSection(markdownRef, sectionName);
  }
}
