import { ICommand, IJsonError, IParameter } from "@src/types.mjs";
import fs from "fs";
import { JsonError } from "./jsonvalidator.mjs";
import { IResolvedParam } from "./backend-types.mjs";
import { TemplatePathResolver } from "./templates/template-path-resolver.mjs";

export class ScriptValidator {
  /**
   * Built-in template variables provided by runtime (not user parameters).
   * These are injected via defaults/context and therefore must be allowed here.
   */
  private isBuiltInVariable(v: string): boolean {
    // Keep this list intentionally small and explicit.
    return (
      v === "application" ||
      v === "application_id" ||
      v === "application_name" ||
      v === "task" ||
      v === "task_type"
    );
  }

  /**
   * Extracts all {{ var }} placeholders from a string.
   * Only extracts valid variable names (alphanumeric, underscore, hyphen, dot).
   * Ignores patterns with quotes or other invalid characters to avoid false positives.
   */
  private extractTemplateVariables(str: string): string[] {
    // Match {{ var }} but only capture valid variable names
    // Valid variable names: alphanumeric, underscore, hyphen, dot
    // This avoids false positives from shell patterns like *"{{"*"}}"*
    // Exclude Go-template variables (starting with .) like {{.Repository}}, {{.Tag}}
    const regex = /{{ *([a-zA-Z_][a-zA-Z0-9_.-]*) *}}/g;
    const vars = new Set<string>();
    let match;
    while ((match = regex.exec(str)) !== null) {
      vars.add(match[1] || "");
    }
    return Array.from(vars);
  }
  // Removed findInPathes - now using TemplatePathResolver.findInPathes
  /**
   * Checks if the script exists and if all variables are defined as parameters.
   */
  validateScript(
    cmd: ICommand,
    application: string,
    errors: IJsonError[],
    parameters: IParameter[],
    resolvedParams: IResolvedParam[],
    requestedIn?: string,
    parentTemplate?: string,
    scriptPathes?: string[],
  ) {
    if (cmd.script === undefined) {
      errors.push(
        new JsonError(
          `Script command missing 'script' property (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }
    const scriptPath = TemplatePathResolver.findInPathes(
      scriptPathes || [],
      cmd.script,
    );
    if (!scriptPath) {
      errors.push(
        new JsonError(
          `Script file not found: ${cmd.script} (searched in: applications/${application}/scripts and shared/scripts, requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }
    // Read script content and check variables
    try {
      const scriptContent = fs.readFileSync(scriptPath, "utf-8");
      const vars = this.extractTemplateVariables(scriptContent);
      for (const v of vars) {
        if (this.isBuiltInVariable(v)) continue;
        if (
          !parameters.some((p) => p.id === v) &&
          !resolvedParams.some((rp) => rp.id === v)
        ) {
          errors.push(
            new JsonError(
              `Script ${cmd.script} uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
            ),
          );
        }
      }
    } catch (e) {
      errors.push(new JsonError(`Failed to read script ${cmd.script}: ${e}`));
    }
  }

  /**
   * Validates a script using its content (no FS access).
   */
  validateScriptContent(
    cmd: ICommand,
    application: string,
    errors: IJsonError[],
    parameters: IParameter[],
    resolvedParams: IResolvedParam[],
    scriptContent: string | null,
    requestedIn?: string,
    parentTemplate?: string,
  ): void {
    if (cmd.script === undefined) {
      errors.push(
        new JsonError(
          `Script command missing 'script' property (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }
    if (!scriptContent) {
      errors.push(
        new JsonError(
          `Script file not found: ${cmd.script} (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }

    const vars = this.extractTemplateVariables(scriptContent);
    for (const v of vars) {
      if (this.isBuiltInVariable(v)) continue;
      if (
        !parameters.some((p) => p.id === v) &&
        !resolvedParams.some((rp) => rp.id === v)
      ) {
        errors.push(
          new JsonError(
            `Script ${cmd.script} uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
          ),
        );
      }
    }
  }

  /**
   * Checks if all variables in the execute string are defined as parameters.
   */
  validateCommand(
    cmd: ICommand,
    errors: IJsonError[],
    parameters: IParameter[],
    resolvedParams: IResolvedParam[],
    requestedIn?: string,
    parentTemplate?: string,
  ) {
    if (cmd.command) {
      const vars = this.extractTemplateVariables(cmd.command);
      for (const v of vars) {
        if (this.isBuiltInVariable(v)) continue;
        if (
          !parameters.some((p) => p.id === v) &&
          !resolvedParams.some((rp) => rp.id === v)
        ) {
          errors.push(
            new JsonError(
              `Command uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
            ),
          );
        }
      }
    }
  }

  /**
   * Validates a library file: checks if it exists and if it contains template variables (which should not be in libraries).
   */
  validateLibrary(
    libraryName: string,
    errors: IJsonError[],
    requestedIn?: string,
    parentTemplate?: string,
    scriptPathes?: string[],
  ) {
    if (!scriptPathes || scriptPathes.length === 0) {
      errors.push(
        new JsonError(
          `Library validation failed: scriptPathes not provided (library: ${libraryName}, requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }

    const libraryPath = TemplatePathResolver.findInPathes(
      scriptPathes,
      libraryName,
    );
    if (!libraryPath) {
      errors.push(
        new JsonError(
          `Library file not found: ${libraryName} (searched in: ${scriptPathes.join(", ")}, requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }

    // Check if library contains template variables (libraries should not contain variables)
    try {
      const libraryContent = fs.readFileSync(libraryPath, "utf-8");
      const vars = this.extractTemplateVariables(libraryContent);
      if (vars.length > 0) {
        errors.push(
          new JsonError(
            `Library ${libraryName} contains template variables ({{ ${vars.join(", ")}} }), which is not allowed. Libraries should only contain function definitions without template variables.`,
          ),
        );
      }
    } catch (e) {
      errors.push(new JsonError(`Failed to read library ${libraryName}: ${e}`));
    }
  }

  /**
   * Validates a library using its content (no FS access).
   */
  validateLibraryContent(
    libraryName: string,
    errors: IJsonError[],
    libraryContent: string | null,
    requestedIn?: string,
    parentTemplate?: string,
  ): void {
    if (!libraryContent) {
      errors.push(
        new JsonError(
          `Library file not found: ${libraryName} (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`,
        ),
      );
      return;
    }

    const vars = this.extractTemplateVariables(libraryContent);
    if (vars.length > 0) {
      errors.push(
        new JsonError(
          `Library ${libraryName} contains template variables ({{ ${vars.join(", ")}} }), which is not allowed. Libraries should only contain function definitions without template variables.`,
        ),
      );
    }
  }
}
