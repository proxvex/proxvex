import { JsonError } from "@src/jsonvalidator.mjs";
import { IResolvedParam } from "@src/backend-types.mjs";
import { ITemplate, IJsonError } from "@src/types.mjs";
import { IProcessedTemplate } from "./templateprocessor-types.mjs";

export interface PropertyDefaultEntry {
  id: string;
  default?: string | number | boolean;
  required?: boolean;
}

export interface OutputCollectionResult {
  allOutputIds: Set<string>;
  outputIdsFromOutputs: Set<string>;
  outputIdsFromProperties: Set<string>;
  /** Output IDs marked as optional — may or may not be produced at runtime */
  optionalOutputIds: Set<string>;
  /** Properties that use 'default' instead of 'value' - these should NOT be added to resolvedParams */
  propertyDefaults: PropertyDefaultEntry[];
  duplicateIds: Set<string>;
}

export interface ApplyOutputsOptions {
  applicationId: string;
  currentTemplateName: string;
  isConditional: boolean;
  outputCollection: OutputCollectionResult;
  resolvedParams: IResolvedParam[];
  outputSources?: Map<
    string,
    { template: string; kind: "outputs" | "properties" }
  >;
  processedTemplates?: Map<string, IProcessedTemplate>;
  errors?: IJsonError[];
}

export type ResolveTemplateFn = (
  applicationId: string,
  templateName: string,
  category: string,
) => { template: ITemplate } | null;
export type NormalizeTemplateNameFn = (templateName: string) => string;

export class TemplateOutputProcessor {
  constructor(
    private resolveTemplate: ResolveTemplateFn,
    private normalizeTemplateName: NormalizeTemplateNameFn,
  ) {}

  collectOutputs(tmplData: ITemplate): OutputCollectionResult {
    const allOutputIds = new Set<string>();
    const outputIdsFromOutputs = new Set<string>();
    const outputIdsFromProperties = new Set<string>();
    const optionalOutputIds = new Set<string>();
    const propertyDefaults: PropertyDefaultEntry[] = [];
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();

    for (const cmd of tmplData.commands ?? []) {
      if (cmd.outputs) {
        for (const output of cmd.outputs) {
          const id = typeof output === "string" ? output : output.id;
          const isOptional =
            typeof output === "object" && output.optional === true;
          if (isOptional) {
            optionalOutputIds.add(id);
          }
          if (seenIds.has(id)) {
            duplicateIds.add(id);
          } else {
            seenIds.add(id);
            allOutputIds.add(id);
            outputIdsFromOutputs.add(id);
          }
        }
      }

      if (cmd.properties !== undefined) {
        const propertyIdsInCommand = new Set<string>();
        const propertiesArray = Array.isArray(cmd.properties)
          ? cmd.properties
          : [cmd.properties];

        for (const prop of propertiesArray) {
          if (prop && typeof prop === "object" && prop.id) {
            if (propertyIdsInCommand.has(prop.id)) {
              duplicateIds.add(prop.id);
              continue;
            }
            propertyIdsInCommand.add(prop.id);

            // Check if this property has 'default' instead of 'value'
            // Properties with 'default' should NOT be added to resolvedParams
            // They should only set the parameter's default value
            const hasValue = prop.value !== undefined;
            const hasDefault = prop.default !== undefined;

            if (hasDefault && !hasValue) {
              // This property only sets a default - don't mark as resolved
              propertyDefaults.push({
                id: prop.id,
                default: prop.default as string | number | boolean,
              });
              // Still track in seenIds to detect duplicates
              if (seenIds.has(prop.id)) {
                duplicateIds.add(prop.id);
              } else {
                seenIds.add(prop.id);
              }
            } else {
              // This property has a value - mark as resolved
              if (seenIds.has(prop.id)) {
                duplicateIds.add(prop.id);
              } else {
                seenIds.add(prop.id);
                allOutputIds.add(prop.id);
                outputIdsFromProperties.add(prop.id);
              }
            }
          }
        }
      }
    }

    return {
      allOutputIds,
      outputIdsFromOutputs,
      outputIdsFromProperties,
      optionalOutputIds,
      propertyDefaults,
      duplicateIds,
    };
  }

  applyOutputs(opts: ApplyOutputsOptions): void {
    const {
      applicationId,
      currentTemplateName,
      isConditional,
      outputCollection,
      resolvedParams,
      outputSources,
      processedTemplates,
      errors,
    } = opts;
    const { allOutputIds, outputIdsFromProperties, optionalOutputIds } =
      outputCollection;

    for (const outputId of allOutputIds) {
      const existing = resolvedParams.find((p) => p.id === outputId);
      if (existing === undefined) {
        resolvedParams.push({
          id: outputId,
          template: currentTemplateName,
        });
        if (outputSources) {
          outputSources.set(outputId, {
            template: currentTemplateName,
            kind: outputIdsFromProperties.has(outputId)
              ? "properties"
              : "outputs",
          });
        }
      } else {
        const conflictingTemplate = existing.template;
        if (conflictingTemplate === "user_input") {
          const existingIndex = resolvedParams.findIndex(
            (p) => p.id === outputId,
          );
          if (existingIndex !== -1) {
            resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (outputSources) {
            outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId)
                ? "properties"
                : "outputs",
            });
          }
          continue;
        }

        let conflictingTemplateIsConditional = false;
        let conflictingOutputIsOptional = false;
        let conflictingTemplateSetsOutput = true;
        const currentOutputIsOptional = optionalOutputIds.has(outputId);
        if (processedTemplates) {
          const normalizedConflictingName =
            this.normalizeTemplateName(conflictingTemplate);
          const conflictingTemplateInfo = processedTemplates.get(
            normalizedConflictingName,
          );
          if (conflictingTemplateInfo) {
            conflictingTemplateIsConditional =
              conflictingTemplateInfo.conditional || false;

            try {
              const conflictingResolved = this.resolveTemplate(
                applicationId,
                conflictingTemplate,
                conflictingTemplateInfo?.category ?? "",
              );
              const conflictingTmplData = conflictingResolved?.template ?? null;
              if (!conflictingTmplData) {
                conflictingTemplateSetsOutput = true;
              } else {
                conflictingTemplateSetsOutput = false;
                for (const cmd of conflictingTmplData.commands ?? []) {
                  if (cmd.outputs) {
                    for (const output of cmd.outputs) {
                      const id =
                        typeof output === "string" ? output : output.id;
                      if (id === outputId) {
                        conflictingTemplateSetsOutput = true;
                        if (
                          typeof output === "object" &&
                          output.optional === true
                        ) {
                          conflictingOutputIsOptional = true;
                        }
                        break;
                      }
                    }
                  }
                  if (cmd.properties !== undefined) {
                    if (Array.isArray(cmd.properties)) {
                      for (const prop of cmd.properties) {
                        if (
                          prop &&
                          typeof prop === "object" &&
                          prop.id === outputId
                        ) {
                          conflictingTemplateSetsOutput = true;
                          break;
                        }
                      }
                    } else if (
                      cmd.properties &&
                      typeof cmd.properties === "object" &&
                      cmd.properties.id === outputId
                    ) {
                      conflictingTemplateSetsOutput = true;
                    }
                  }
                  if (conflictingTemplateSetsOutput) break;
                }
              }
            } catch {
              conflictingTemplateSetsOutput = true;
            }
          }
        }

        if (!conflictingTemplateSetsOutput) {
          const existingIndex = resolvedParams.findIndex(
            (p) => p.id === outputId,
          );
          if (existingIndex !== -1) {
            resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (outputSources) {
            outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId)
                ? "properties"
                : "outputs",
            });
          }
        } else if (
          isConditional ||
          conflictingTemplateIsConditional ||
          currentOutputIsOptional ||
          conflictingOutputIsOptional
        ) {
          const existingIndex = resolvedParams.findIndex(
            (p) => p.id === outputId,
          );
          if (existingIndex !== -1) {
            resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (outputSources) {
            outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId)
                ? "properties"
                : "outputs",
            });
          }
        } else {
          errors?.push(
            new JsonError(
              `Output/property ID "${outputId}" is set by multiple templates in the same task: "${conflictingTemplate}" and "${currentTemplateName}". Each output ID can only be set once per task.`,
            ),
          );
        }
      }
    }
  }

  /**
   * Apply property defaults to parameters.
   * This sets the default value on parameters without marking them as resolved,
   * allowing them to appear as editable in the UI with pre-filled values.
   */
  applyPropertyDefaults(
    propertyDefaults: PropertyDefaultEntry[],
    parameters: Array<{
      id: string;
      default?: string | number | boolean;
      required?: boolean;
    }>,
  ): void {
    for (const propDefault of propertyDefaults) {
      const param = parameters.find((p) => p.id === propDefault.id);
      if (param) {
        if (propDefault.default !== undefined) {
          param.default = propDefault.default;
        }
        if (propDefault.required !== undefined) {
          param.required = propDefault.required;
        }
      }
    }
  }
}
