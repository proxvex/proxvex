import { IResolvedParam, IApplication } from "@src/backend-types.mjs";
import {
  ITemplate,
  ICommand,
  IParameter,
  IJsonError,
  IParameterValue,
  ITemplateTraceEntry,
  IParameterTraceEntry,
  ITemplateTraceInfo,
  ITemplateProcessorLoadResult as ITemplateProcessorLoadResultBase,
} from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ITemplateReference } from "../backend-types.mjs";
import { type TemplateRef } from "../persistence/repositories.mjs";

// Re-export trace interfaces from shared types for convenience
export type { ITemplateTraceEntry, IParameterTraceEntry, ITemplateTraceInfo };

export interface IProcessTemplateOpts {
  application: string;
  template: ITemplateReference | string;
  templatename: string;
  resolvedParams: IResolvedParam[];
  parameters: IParameterWithTemplate[];
  commands: ICommand[];
  visitedTemplates?: Set<string>;
  errors?: IJsonError[];
  requestedIn?: string | undefined;
  parentTemplate?: string | undefined;
  webuiTemplates: string[];
  templateRef?: TemplateRef;
  templateCategory?: string; // Category of the current template (e.g., "list") - used for script resolution
  veContext?: IVEContext;
  executionMode?: import("../ve-execution/ve-execution-constants.mjs").ExecutionMode; // Execution mode for VeExecution
  enumValueInputs?: { id: string; value: IParameterValue }[];
  enumValuesExecuteOn?: string;
  enumValuesRefresh?: boolean;
  processedTemplates?: Map<string, IProcessedTemplate>; // Collects template information
  templateReferences?: Map<string, Set<string>>; // Template references (template -> referenced templates)
  outputSources?: Map<
    string,
    { template: string; kind: "outputs" | "properties" }
  >; // Output provenance
  pendingPropertyDefaults?: import("./template-output-processor.mjs").PropertyDefaultEntry[];
  /** Application-level feature flags from supports array, used for implements checks */
  applicationFlags?: Record<string, boolean>;
}

export interface IParameterWithTemplate extends IParameter {
  template: string;
}

export interface IProcessedTemplate {
  name: string; // Template name (without .json)
  path: string; // Full path to the template file
  isShared: boolean; // true = shared template, false = app-specific
  skipped: boolean; // true = all commands skipped
  conditional: boolean; // true = skip_if_all_missing or skip_if_property_set
  category?: string; // Category subdirectory (e.g., "pre_start", "list")
  referencedBy?: string[]; // Templates that reference this template
  references?: string[]; // Templates referenced by this template
  templateData?: ITemplate; // Full template data (validated)
  capabilities?: string[]; // Extracted capabilities from script headers
  resolvedScriptPaths?: Map<string, string>; // script name -> full path
  usedByApplications?: string[]; // Applications that use this template
}

// Full load result extending the shared base with backend-specific fields
export interface ITemplateProcessorLoadResult extends ITemplateProcessorLoadResultBase {
  commands: ICommand[];
  parameters: IParameterWithTemplate[];
  resolvedParams: IResolvedParam[];
  webuiTemplates: string[];
  application?: IApplication; // Full application data (incl. parent)
  processedTemplates?: IProcessedTemplate[]; // List of all processed templates
}
