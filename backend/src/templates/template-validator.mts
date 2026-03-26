import { JsonError } from "@src/jsonvalidator.mjs";
import { IResolvedParam } from "@src/backend-types.mjs";
import { ITemplate } from "@src/types.mjs";
import {
  IProcessTemplateOpts,
  IParameterWithTemplate,
} from "./templateprocessor-types.mjs";
import { type TemplateRef } from "../persistence/repositories.mjs";

export type ResolveMarkdownSection = (
  ref: TemplateRef,
  sectionName: string,
) => string | null;
export type ResolveEnumValuesTemplate = (
  enumTemplate: string,
  opts: IProcessTemplateOpts,
) => Promise<
  | (string | { name: string; value: string | number | boolean })[]
  | null
  | undefined
>;
export type ExtractTemplateName = (
  template: IProcessTemplateOpts["template"],
) => string;
export type NormalizeTemplateName = (templateName: string) => string;

export class TemplateValidator {
  constructor(
    private resolveMarkdownSection: ResolveMarkdownSection,
    private resolveEnumValuesTemplate: ResolveEnumValuesTemplate,
    private extractTemplateName: ExtractTemplateName,
    private normalizeTemplateName: NormalizeTemplateName,
  ) {}

  shouldSkipTemplate(
    tmplData: ITemplate,
    resolvedParams: IResolvedParam[],
    applicationParams?: IParameterWithTemplate[],
  ): { shouldSkip: boolean; reason?: "property_set" | "all_missing" } {
    if (tmplData.skip_if_property_set) {
      const resolved = resolvedParams.find(
        (p) => p.id === tmplData.skip_if_property_set,
      );
      if (resolved) {
        return { shouldSkip: true, reason: "property_set" };
      }
    }

    if (
      tmplData.skip_if_all_missing &&
      tmplData.skip_if_all_missing.length > 0
    ) {
      let allSkipParamsMissing = true;
      for (const paramId of tmplData.skip_if_all_missing) {
        const resolved = resolvedParams.find((p) => p.id === paramId);
        if (resolved) {
          allSkipParamsMissing = false;
          break;
        }
        // Also consider application-declared parameters as "present".
        // If the application defines a parameter (even without a value),
        // the template should run so it can produce its outputs (e.g. shared_volpath).
        if (applicationParams?.some((p) => p.id === paramId)) {
          allSkipParamsMissing = false;
          break;
        }
      }

      if (!allSkipParamsMissing) {
        return { shouldSkip: false };
      }

      if (tmplData.parameters) {
        for (const param of tmplData.parameters) {
          if (tmplData.skip_if_all_missing.includes(param.id)) {
            continue;
          }

          if (param.required === true) {
            const resolved = resolvedParams.find((p) => p.id === param.id);
            if (!resolved) {
              return { shouldSkip: false };
            }
          }
        }
      }

      return { shouldSkip: true, reason: "all_missing" };
    }

    return { shouldSkip: false };
  }

  async validateAndAddParameters(
    opts: IProcessTemplateOpts,
    tmplData: ITemplate,
    templateName: string,
    templateRef: TemplateRef,
  ): Promise<void> {
    if (tmplData.parameters) {
      for (const param of tmplData.parameters) {
        // 'if' must not refer to itself
        // It can refer to another parameter in the same template OR to a property (stored in application.json)
        if (param.if && param.if === param.id) {
          opts.errors?.push(
            new JsonError(
              `Parameter '${param.name}': 'if' must not refer to itself.`,
            ),
          );
        }
      }
    }

    const enumTasks: Array<Promise<void>> = [];

    for (const param of tmplData.parameters ?? []) {
      if (!opts.parameters.some((p) => p.id === param.id)) {
        let description = param.description;
        if (!description || description.trim() === "") {
          let mdSection = this.resolveMarkdownSection(
            templateRef,
            param.name || param.id,
          );
          if (!mdSection && param.name && param.name !== param.id) {
            mdSection = this.resolveMarkdownSection(templateRef, param.id);
          }

          if (mdSection) {
            description = mdSection;
          } else {
            opts.errors?.push(
              new JsonError(
                `Parameter '${param.id}' in template '${this.extractTemplateName(opts.template)}' has no description. ` +
                  `Add 'description' in JSON or create '${this.normalizeTemplateName(templateName)}.md' with '## ${param.name || param.id}' section.`,
              ),
            );
          }
        }

        const pparm: IParameterWithTemplate = {
          ...param,
          description: description ?? "",
          template: this.extractTemplateName(opts.template),
          templatename:
            tmplData.name || this.extractTemplateName(opts.template),
        };

        opts.parameters.push(pparm);

        if (param.type === "enum" && (param as any).enumValuesTemplate) {
          const enumTmplName = (param as any).enumValuesTemplate;
          opts.webuiTemplates?.push(enumTmplName);
          enumTasks.push(
            (async () => {
              if (process.env.ENUM_TRACE === "1") {
                const templateNameToLog = this.extractTemplateName(
                  opts.template,
                );
                console.info(
                  `[enum-trace] request template=${templateNameToLog} param=${param.id} enumTemplate=${enumTmplName}`,
                );
              }
              const enumValues = await this.resolveEnumValuesTemplate(
                enumTmplName,
                opts,
              );
              if (Array.isArray(enumValues) && enumValues.length > 0) {
                pparm.enumValues = enumValues;
                if (enumValues.length === 1 && pparm.default === undefined) {
                  const singleValue = enumValues[0];
                  if (typeof singleValue === "string") {
                    pparm.default = singleValue;
                  } else if (
                    typeof singleValue === "object" &&
                    singleValue !== null &&
                    "value" in singleValue
                  ) {
                    pparm.default = (singleValue as any).value;
                  }
                }
              }
            })(),
          );
        }
      }
    }

    if (enumTasks.length > 0) {
      await Promise.all(enumTasks);
    }
  }
}
