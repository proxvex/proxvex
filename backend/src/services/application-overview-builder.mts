import * as fs from "fs";
import * as path from "path";
import {
  TaskType,
  IApplicationOverviewResponse,
  IApplicationOverviewParameter,
  IApplicationOverviewTemplate,
  IApplicationOverviewStacktype,
  IApplicationOverviewDependency,
  IManagedOciContainer,
  normalizeStacktype,
  IParameter,
} from "@src/types.mjs";
import { IConfiguredPathes, IVEContext } from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import {
  IProcessedTemplate,
  IParameterWithTemplate,
} from "@src/templates/templateprocessor-types.mjs";
import { TemplatePathResolver } from "@src/templates/template-path-resolver.mjs";
import { listManagedContainers } from "./container-list-service.mjs";

export class ApplicationOverviewBuilder {
  constructor(
    private pathes: IConfiguredPathes,
    private pm: PersistenceManager,
    private storageContext: ContextManager,
  ) {}

  async build(
    applicationId: string,
    task: TaskType,
    veContext?: IVEContext,
    vmId?: number,
  ): Promise<IApplicationOverviewResponse> {
    // Load application via template processor (veContext optional)
    const loadResult = await this.storageContext
      .getTemplateProcessor()
      .loadApplication(applicationId, task);

    const app = loadResult.application;
    const appName = app?.name ?? applicationId;
    const appDescription = app?.description ?? "";

    // Read application.md
    const markdownContent = this.readApplicationMarkdown(applicationId);

    // Build extends hierarchy
    const extendsHierarchy = this.buildExtendsHierarchy(applicationId);

    // Build dependencies
    const dependencies = this.buildDependencies(app?.dependencies);

    // Build stacktype with provider/consumer roles
    const stacktype = this.buildStacktype(applicationId, app?.stacktype);

    // Fetch installed container values if vm_id provided
    let installedContainer: IManagedOciContainer | undefined;
    if (veContext && vmId !== undefined) {
      try {
        const containers = await listManagedContainers(this.pm, veContext);
        installedContainer = containers.find((c) => c.vm_id === vmId);
      } catch {
        // Non-fatal: overview works without installed values
      }
    }

    // Build parameters from the loaded result
    const parameters = this.buildParameters(
      loadResult.parameters,
      loadResult.resolvedParams,
      loadResult.processedTemplates ?? [],
      app,
      installedContainer,
    );

    // Determine app path for script resolution
    const appPath = this.pm.getApplicationService().getAllAppNames().get(applicationId) ?? '';

    // Build templates from processed templates
    const templates = this.buildTemplates(loadResult.processedTemplates ?? [], appPath);

    return {
      applicationId,
      name: appName,
      description: appDescription,
      markdownContent,
      extendsHierarchy,
      dependencies,
      stacktype: stacktype.length > 0 ? stacktype : undefined,
      parameters,
      templates,
    };
  }

  private readApplicationMarkdown(applicationId: string): string | null {
    // Check local first, then json
    const localPath = path.join(
      this.pathes.localPath,
      "applications",
      applicationId,
      "application.md",
    );
    const jsonPath = path.join(
      this.pathes.jsonPath,
      "applications",
      applicationId,
      "application.md",
    );

    for (const mdPath of [localPath, jsonPath]) {
      if (fs.existsSync(mdPath)) {
        try {
          const content = fs.readFileSync(mdPath, "utf-8").trim();
          return content || null;
        } catch {
          // ignore read errors
        }
      }
    }
    return null;
  }

  private buildExtendsHierarchy(
    applicationId: string,
  ): { id: string; name: string }[] {
    const hierarchy: { id: string; name: string }[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = applicationId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      try {
        const appNames = this.pm.getApplicationService().getAllAppNames();
        const appPath = appNames.get(currentId);
        if (!appPath) break;

        const appJsonPath = path.join(appPath, "application.json");
        if (!fs.existsSync(appJsonPath)) break;

        const raw = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
        hierarchy.push({ id: currentId, name: raw.name ?? currentId });
        currentId = raw.extends;
      } catch {
        break;
      }
    }

    return hierarchy;
  }

  private buildDependencies(
    deps?: { application: string }[],
  ): IApplicationOverviewDependency[] {
    if (!deps || deps.length === 0) return [];

    return deps.map((dep) => {
      let name = dep.application;
      let description: string | undefined;
      try {
        const appNames = this.pm.getApplicationService().getAllAppNames();
        const appPath = appNames.get(dep.application);
        if (appPath) {
          const appJsonPath = path.join(appPath, "application.json");
          if (fs.existsSync(appJsonPath)) {
            const raw = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
            name = raw.name ?? dep.application;
            description = raw.description;
          }
        }
      } catch {
        // use defaults
      }
      return { application: dep.application, name, description };
    });
  }

  private buildStacktype(
    applicationId: string,
    appStacktype: string | string[] | undefined,
  ): IApplicationOverviewStacktype[] {
    const types = normalizeStacktype(appStacktype);
    if (types.length === 0) return [];

    // Determine provider/consumer: if other apps depend on this app for a stacktype, it's a provider
    const providedTypes = new Set<string>();
    try {
      const allApps = this.pm.getApplicationService().getAllAppNames();
      for (const [otherAppId] of allApps) {
        if (otherAppId === applicationId) continue;
        try {
          const otherPath = allApps.get(otherAppId);
          if (!otherPath) continue;
          const otherJsonPath = path.join(otherPath, "application.json");
          if (!fs.existsSync(otherJsonPath)) continue;
          const otherRaw = JSON.parse(
            fs.readFileSync(otherJsonPath, "utf-8"),
          );
          const otherDeps: { application: string }[] =
            otherRaw.dependencies ?? [];
          if (otherDeps.some((d) => d.application === applicationId)) {
            // This app is depended upon - its stacktypes are provided
            for (const st of types) {
              providedTypes.add(st);
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // fallback: all consumer
    }

    return types.map((st) => ({
      name: st,
      role: providedTypes.has(st) ? ("provider" as const) : ("consumer" as const),
    }));
  }

  private buildParameters(
    parameters: IParameterWithTemplate[],
    resolvedParams: import("@src/backend-types.mjs").IResolvedParam[],
    processedTemplates: IProcessedTemplate[],
    app: import("@src/backend-types.mjs").IApplication | undefined,
    installedContainer?: IManagedOciContainer,
  ): IApplicationOverviewParameter[] {
    // Build a map of output sources for determining sourceType and actual values
    const outputSources = new Map<
      string,
      { kind: "value" | "default"; source: string; actualValue?: string | number | boolean | undefined }
    >();

    // Check application properties
    if (app?.properties) {
      for (const prop of app.properties) {
        if ("value" in prop && prop.value !== undefined) {
          const v = prop.value;
          outputSources.set(prop.id, { kind: "value", source: "application.json", actualValue: typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined });
        } else if ("default" in prop && prop.default !== undefined) {
          outputSources.set(prop.id, {
            kind: "default",
            source: "application.json",
            actualValue: prop.default,
          });
        }
      }
    }

    // Check application-level parameters with defaults
    if (app?.parameters) {
      for (const p of app.parameters) {
        if (p.default !== undefined && !outputSources.has(p.id)) {
          outputSources.set(p.id, {
            kind: "default",
            source: "application.json",
            actualValue: p.default,
          });
        }
      }
    }

    // Check template commands for properties/outputs that set values
    for (const pt of processedTemplates) {
      if (!pt.templateData) continue;
      for (const cmd of pt.templateData.commands) {
        if (cmd.properties) {
          const props = Array.isArray(cmd.properties)
            ? cmd.properties
            : [cmd.properties];
          for (const prop of props) {
            if (!outputSources.has(prop.id)) {
              const isValue = "value" in prop && prop.value !== undefined;
              const raw = isValue ? prop.value : prop.default;
              const val = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? raw : undefined;
              outputSources.set(prop.id, {
                kind: (isValue ? "value" : "default") as "value" | "default",
                source: pt.name,
                actualValue: val,
              });
            }
          }
        }
      }
    }

    // Build installed values map from container data
    const installedValues = new Map<string, string | number | boolean>();
    if (installedContainer) {
      const c = installedContainer;
      if (c.hostname !== undefined) installedValues.set("hostname", c.hostname);
      if (c.oci_image !== undefined) installedValues.set("oci_image", c.oci_image);
      if (c.username !== undefined) installedValues.set("username", c.username);
      if (c.uid !== undefined) installedValues.set("uid", c.uid);
      if (c.gid !== undefined) installedValues.set("gid", c.gid);
      if (c.memory !== undefined) installedValues.set("memory", c.memory);
      if (c.cores !== undefined) installedValues.set("cores", c.cores);
      if (c.disk_size !== undefined) installedValues.set("disk_size", c.disk_size);
      if (c.volumes !== undefined) installedValues.set("volumes", c.volumes);
      if (c.stack_name !== undefined) installedValues.set("stack_name", c.stack_name);
      if (c.vm_id !== undefined) installedValues.set("vm_id", c.vm_id);
    }

    const mapped = parameters.map((param) => {
      const origin = this.getParameterOrigin(param, processedTemplates);
      const source = outputSources.get(param.id);
      const sourceType: "value" | "default" | "parameter" = source
        ? source.kind
        : "parameter";
      const defaultSource = source?.source;

      const installedValue = installedValues.get(param.id);

      return {
        id: param.id,
        name: param.name,
        type: param.type,
        required: param.required === true,
        advanced: param.advanced === true,
        internal: (param as IParameter & { internal?: boolean }).internal === true,
        secure: param.secure === true,
        default: param.default ?? source?.actualValue,
        description: param.description,
        defaultSource,
        origin,
        sourceType,
        installedValue,
      };
    });

    // Sort: required first, then by name
    mapped.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return mapped;
  }

  private getParameterOrigin(
    param: IParameterWithTemplate,
    processedTemplates: IProcessedTemplate[],
  ): IApplicationOverviewParameter["origin"] {
    // Find the template that defines this parameter
    const templateName = param.template;
    if (!templateName) return "application-json";

    const pt = processedTemplates.find((t) => t.name === templateName);
    if (!pt) return "application-json";

    const source = this.detectPathSource(pt.path);
    if (pt.isShared) {
      return `shared-${source}` as IApplicationOverviewParameter["origin"];
    }
    return `application-${source}` as IApplicationOverviewParameter["origin"];
  }

  /** Detect source tag from a template trace path like "local/...", "hub/...", "json/..." */
  private detectPathSource(tracePath: string): "local" | "hub" | "json" | "unknown" {
    if (tracePath.startsWith("local/")) return "local";
    if (tracePath.startsWith("hub/")) return "hub";
    if (tracePath.startsWith("json/")) return "json";
    return "unknown";
  }

  private buildTemplates(
    processedTemplates: IProcessedTemplate[],
    appPath: string,
  ): IApplicationOverviewTemplate[] {
    return processedTemplates.map((pt, index) => {
      const source = this.detectPathSource(pt.path);
      const origin: IApplicationOverviewTemplate["origin"] = source !== "unknown"
        ? (`${pt.isShared ? "shared" : "application"}-${source}` as IApplicationOverviewTemplate["origin"])
        : "unknown";

      const tmplData = pt.templateData;
      const rawExecuteOn = tmplData?.execute_on;
      const executeOn = typeof rawExecuteOn === "object" ? (rawExecuteOn as { where: string }).where : rawExecuteOn;

      // Build skip reason
      let skipReason: string | undefined;
      if (pt.skipped) {
        if (tmplData?.skip_if_all_missing?.length) {
          skipReason = `skip_if_all_missing: [${tmplData.skip_if_all_missing.join(", ")}]`;
        } else if (tmplData?.skip_if_property_set) {
          skipReason = `skip_if_property_set: ${tmplData.skip_if_property_set}`;
        } else if (tmplData?.implements) {
          skipReason = `implements: ${tmplData.implements} (not supported)`;
        }
      }

      // Extract script info from first command with a script
      let scriptName: string | undefined;
      let scriptPath: string | undefined;
      let scriptOrigin: string | undefined;
      if (tmplData?.commands) {
        for (const cmd of tmplData.commands) {
          if (cmd.script) {
            scriptName = cmd.script;
            // Resolve script path
            if (pt.resolvedScriptPaths) {
              scriptPath = pt.resolvedScriptPaths.get(cmd.script);
            }
            if (!scriptPath) {
              scriptPath = TemplatePathResolver.resolveScriptPath(
                cmd.script, appPath, this.pathes, pt.category,
              ) ?? undefined;
            }
            if (scriptPath) {
              const scriptSource = this.detectPathSource(scriptPath);
              const isScriptShared =
                scriptPath.includes("/shared/") ||
                scriptPath.includes("/shared\\");
              scriptOrigin = scriptSource !== "unknown"
                ? (`${isScriptShared ? "shared" : "application"}-${scriptSource}` as typeof scriptOrigin)
                : "application-json";
            }
            break;
          }
        }
      }

      // Collect outputs
      const outputs: string[] = [];
      if (tmplData?.commands) {
        for (const cmd of tmplData.commands) {
          if (cmd.outputs) {
            for (const out of cmd.outputs) {
              const outId = typeof out === "string" ? out : out.id;
              if (!outputs.includes(outId)) outputs.push(outId);
            }
          }
        }
      }

      // Collect parameters
      const paramIds: string[] = [];
      if (tmplData?.parameters) {
        for (const p of tmplData.parameters) {
          if (!paramIds.includes(p.id)) paramIds.push(p.id);
        }
      }

      return {
        seq: index + 1,
        name: tmplData?.name ?? pt.name,
        path: pt.path,
        origin,
        isShared: pt.isShared,
        category: pt.category,
        executeOn,
        skipped: pt.skipped,
        skipReason,
        skipIfAllMissing: tmplData?.skip_if_all_missing,
        skipIfPropertySet: tmplData?.skip_if_property_set,
        implements: tmplData?.implements,
        scriptName,
        scriptPath,
        scriptOrigin,
        outputs,
        parameters: paramIds,
      };
    });
  }
}
