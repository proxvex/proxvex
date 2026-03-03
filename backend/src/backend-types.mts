import { ContextManager } from "./context-manager.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { StorageContext } from "./storagecontext.mjs";
// StorageContext import removed to avoid circular dependency
// Use type-only import if needed: import type { StorageContext } from "./storagecontext.mjs";
import { IJsonError, ISsh, TaskType } from "./types.mjs";

export class VEConfigurationError extends JsonError {
  constructor(message: string, application: string, details?: IJsonError[]) {
    super(message, details, application);
    this.name = "VEConfigurationError";
    this.filename = application;
  }
}
import { IApplicationBase } from "./types.mjs";

export interface IResolvedParam {
  id: string;
  template: string;
}

export interface IConfiguredPathes {
  schemaPath: string;
  jsonPath: string;
  localPath: string;
}
export const storageKey = "global_storage_context";
export interface IContext {
  getKey(): string;
}
export interface IVMContext {
  vmid: number;
  vekey: string;
  outputs: Record<string, string | number | boolean>;
  getKey(): string;
}
export interface IVMInstallContext {
  hostname: string;
  application: string;
  task: TaskType;
  changedParams: Array<{ name: string; value: string | number | boolean }>;
}

// Interface generated from application.schema.json
// Extends IApplicationBase from types.mts (which includes url, documentation, source, vendor)
export type IApplicationSchema = IApplicationBase & {
  [key in TaskType]?: string[];
};

export interface IApplication extends IApplicationSchema {
  id: string;
  iconContent?: string | undefined;
  iconType?: string | undefined;
}
export interface ITemplateReference {
  name: string;
  category?: string;
  before?: string[];
  after?: string[];
}

export interface IReadApplicationOptions {
  applicationHierarchy: string[];
  application?: IApplication;
  appPath?: string;
  error: IJsonError;
  taskTemplates: {
    task: string;
    templates: (ITemplateReference | string)[];
  }[];
  inheritedIcon?: string;
  inheritedIconContent?: string;
  inheritedIconType?: string;
}

export class VELoadApplicationError extends VEConfigurationError {
  constructor(
    message: string,
    application: string,
    private task?: string,
    details?: IJsonError[],
  ) {
    super(message, application, details);
    this.name = "VELoadApplicationError";
    this.filename = application;
  }
}
// Interface generated from template.schema.json
export interface ITemplateSchema {}

// Use any to avoid circular dependency - will be resolved when StorageContext is fully migrated
export interface IVEContext extends ISsh {
  getStorageContext(): StorageContext | ContextManager;
  getKey(): string;
}
