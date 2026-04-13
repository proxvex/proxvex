export interface IApplicationOverviewResponse {
  applicationId: string;
  name: string;
  description: string;
  markdownContent: string | null;
  extendsHierarchy: { id: string; name: string }[];
  dependencies: IApplicationOverviewDependency[];
  stacktype?: IApplicationOverviewStacktype[];
  parameters: IApplicationOverviewParameter[];
  templates: IApplicationOverviewTemplate[];
}

export interface IApplicationOverviewStacktype {
  name: string;
  role: 'provider' | 'consumer';
}

export interface IApplicationOverviewDependency {
  application: string;
  name: string;
  description?: string;
}

export interface IApplicationOverviewParameter {
  id: string;
  name: string;
  type: string;
  required: boolean;
  advanced: boolean;
  internal: boolean;
  secure: boolean;
  default?: string | number | boolean;
  description?: string;
  /** Where the default/value originates from: application.json or a template name */
  defaultSource?: string;
  origin: 'application-local' | 'application-hub' | 'application-json' | 'shared-local' | 'shared-hub' | 'shared-json';
  sourceType: 'value' | 'default' | 'parameter';
  installedValue?: string | number | boolean;
}

export interface IApplicationOverviewTemplate {
  seq: number;
  name: string;
  path: string;
  origin: 'application-local' | 'application-hub' | 'application-json' | 'shared-local' | 'shared-hub' | 'shared-json' | 'unknown';
  isShared: boolean;
  category?: string;
  executeOn?: string;
  skipped: boolean;
  skipReason?: string;
  skipIfAllMissing?: string[];
  skipIfPropertySet?: string;
  implements?: string;
  addedByAddon?: string;
  scriptName?: string;
  scriptPath?: string;
  scriptOrigin?: string;
  outputs: string[];
  parameters: string[];
}
