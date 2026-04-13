import { IConfiguredPathes, IResolvedParam } from "@src/backend-types.mjs";
import { TaskType } from "@src/types.mjs";
import {
  IParameterWithTemplate,
  IProcessedTemplate,
  ITemplateTraceEntry,
  IParameterTraceEntry,
  ITemplateTraceInfo,
} from "./templateprocessor-types.mjs";

export class TemplateTraceBuilder {
  constructor(private pathes: IConfiguredPathes) {}

  buildProcessedTemplatesArray(
    processedTemplates: Map<string, IProcessedTemplate>,
    templateReferences: Map<string, Set<string>>,
  ): IProcessedTemplate[] {
    const referencedBy = new Map<string, Set<string>>();
    for (const [templateName, refs] of templateReferences.entries()) {
      for (const ref of refs) {
        if (!referencedBy.has(ref)) {
          referencedBy.set(ref, new Set());
        }
        referencedBy.get(ref)!.add(templateName);
      }
    }

    const processedTemplatesArray: IProcessedTemplate[] = [];
    for (const [templateName, templateInfo] of processedTemplates.entries()) {
      const result: IProcessedTemplate = {
        ...templateInfo,
      };
      if (referencedBy.has(templateName)) {
        result.referencedBy = Array.from(referencedBy.get(templateName)!);
      }
      if (templateReferences.has(templateName)) {
        result.references = Array.from(templateReferences.get(templateName)!);
      }
      processedTemplatesArray.push(result);
    }
    return processedTemplatesArray;
  }

  buildTemplateTrace(
    processedTemplatesArray: IProcessedTemplate[],
  ): ITemplateTraceEntry[] {
    return processedTemplatesArray.map((templateInfo) => {
      const isLocal = templateInfo.path.startsWith("local/");
      const isHub = templateInfo.path.startsWith("hub/");
      const isJson = templateInfo.path.startsWith("json/");
      const sourceTag = isLocal ? "local" : isHub ? "hub" : isJson ? "json" : null;
      const origin: ITemplateTraceEntry["origin"] = sourceTag
        ? (`${templateInfo.isShared ? "shared" : "application"}-${sourceTag}` as ITemplateTraceEntry["origin"])
        : "unknown";

      const displayPath = templateInfo.path;

      return {
        name: templateInfo.name,
        path: displayPath,
        origin,
        isShared: templateInfo.isShared,
        skipped: templateInfo.skipped,
        conditional: templateInfo.conditional,
      };
    });
  }

  buildParameterTrace(
    outParameters: IParameterWithTemplate[],
    resolvedParams: IResolvedParam[],
    outputSources: Map<
      string,
      { template: string; kind: "outputs" | "properties" }
    >,
  ): IParameterTraceEntry[] {
    return outParameters.map((param) => {
      const resolved = resolvedParams.find((rp) => rp.id === param.id);
      const hasDefault =
        param.default !== undefined &&
        param.default !== null &&
        param.default !== "";

      const withOptionalFields = (
        entry: IParameterTraceEntry,
      ): IParameterTraceEntry => {
        if (typeof param.required === "boolean")
          entry.required = param.required;
        if (param.default !== undefined && param.default !== null)
          entry.default = param.default;
        if (param.template !== undefined) entry.template = param.template;
        if (param.templatename !== undefined)
          entry.templatename = param.templatename;
        return entry;
      };

      if (resolved) {
        if (resolved.template === "user_input") {
          const entry: IParameterTraceEntry = {
            id: param.id,
            name: param.name,
            source: "user_input",
          };
          entry.sourceTemplate = resolved.template;
          return withOptionalFields(entry);
        }

        const sourceInfo = outputSources.get(param.id);
        const kind = sourceInfo?.kind;
        const entry: IParameterTraceEntry = {
          id: param.id,
          name: param.name,
          source:
            kind === "properties" ? "template_properties" : "template_output",
        };
        entry.sourceTemplate = sourceInfo?.template ?? resolved.template;
        if (kind) entry.sourceKind = kind;
        return withOptionalFields(entry);
      }

      if (hasDefault) {
        const entry: IParameterTraceEntry = {
          id: param.id,
          name: param.name,
          source: "default",
        };
        return withOptionalFields(entry);
      }

      const entry: IParameterTraceEntry = {
        id: param.id,
        name: param.name,
        source: "missing",
      };
      return withOptionalFields(entry);
    });
  }

  buildTraceInfo(applicationName: string, task: TaskType): ITemplateTraceInfo {
    const appLocalDir = `${this.pathes.localPath}/applications/${applicationName}`;
    const appJsonDir = `${this.pathes.jsonPath}/applications/${applicationName}`;
    return {
      application: applicationName,
      task,
      localDir: this.pathes.localPath,
      jsonDir: this.pathes.jsonPath,
      appLocalDir,
      appJsonDir,
    };
  }
}
