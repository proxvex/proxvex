import path from "path";
import fs from "fs";
import { ApplicationLoader } from "./apploader.mjs";
import {
  IConfiguredPathes,
  VEConfigurationError,
  IReadApplicationOptions,
} from "./backend-types.mjs";
import {
  IFramework,
  IFrameworkPropertyInfo,
  TaskType,
  IParameter,
  IParameterValue,
  IPostFrameworkCreateApplicationBody,
  IFrameworkApplicationDataBody,
  IUploadFile,
  ParameterTarget,
} from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ContextManager } from "./context-manager.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "./templates/templateprocessor.mjs";
import { IVEContext } from "./backend-types.mjs";
import {
  IFrameworkPersistence,
  IApplicationPersistence,
  ITemplatePersistence,
} from "./persistence/interfaces.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";

export interface IReadFrameworkOptions {
  framework?: IFramework;
  frameworkPath?: string;
  error: VEConfigurationError;
}

export class FrameworkLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private storage:
      | StorageContext
      | ContextManager = StorageContext.getInstance(),
    private persistence: IFrameworkPersistence &
      IApplicationPersistence &
      ITemplatePersistence,
    private applicationLoader?: ApplicationLoader,
  ) {
    if (!this.applicationLoader) {
      // ApplicationLoader expects StorageContext | undefined
      const storageContext =
        this.storage instanceof StorageContext ? this.storage : undefined;
      this.applicationLoader = new ApplicationLoader(
        this.pathes,
        this.persistence,
        storageContext,
      );
    }
  }

  public readFrameworkJson(
    framework: string,
    opts: IReadFrameworkOptions,
  ): IFramework {
    return this.persistence.readFramework(framework, opts);
  }

  public async getParameters(
    framework: string,
    task: TaskType,
    veContext: IVEContext,
  ): Promise<IParameter[]> {
    const opts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", framework),
    };
    const frameworkData = this.readFrameworkJson(framework, opts);

    const appOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", frameworkData.extends),
      taskTemplates: [],
    };
    // Validate and load base application (errors are collected in appOpts)
    try {
      this.applicationLoader!.readApplicationJson(
        frameworkData.extends,
        appOpts,
      );
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }

    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager =
      this.storage instanceof ContextManager
        ? this.storage
        : (this.storage as any).contextManager ||
          PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(
      this.pathes,
      contextManager,
      this.persistence,
    );
    const loaded = await templateProcessor.getParameters(
      frameworkData.extends,
      task,
      veContext,
    );

    const propertyIds = (frameworkData.properties || []).map((p) =>
      typeof p === "string" ? p : p.id,
    );
    const isDockerCompose =
      framework === "docker-compose" ||
      frameworkData.extends === "docker-compose";
    const isOciImage =
      framework === "oci-image" || frameworkData.extends === "oci-image";
    const result: IParameter[] = [];
    for (const propId of propertyIds) {
      const match = loaded.find((p) => p.id === propId);
      if (match) {
        // Clone parameter and apply framework-specific rules:
        // - remove 'advanced'
        // - set required based on framework-specific rules
        const cloned: IParameter = { ...match };
        delete (cloned as any).advanced;

        // Special handling for docker-compose and oci-image frameworks:
        // - hostname should be optional (Application ID can be used as default in frontend)
        // - compose_project should be optional
        if (isDockerCompose || isOciImage) {
          if (propId === "hostname") {
            cloned.required = false; // Optional - Application ID can be used as default
          } else if (propId === "compose_project") {
            cloned.required = false; // Force optional for docker-compose
          } else {
            // For other parameters, keep original required value (default to false if not defined)
            cloned.required = match.required === true;
          }
        } else {
          // For other frameworks, respect template-defined required value
          // Only mark as required if explicitly set to true in template
          cloned.required = match.required === true;
        }

        result.push(cloned);
      }
    }
    return result;
  }

  public async createApplicationFromFramework(
    request: IPostFrameworkCreateApplicationBody,
  ): Promise<string> {
    const { framework, baseApplication, allParameters } =
      await this.loadAndValidateFramework(request);

    this.checkExistingApplication(request);

    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      request.applicationId,
    );

    const paramValuesMap = new Map<string, string | number | boolean>();
    for (const pv of request.parameterValues) {
      paramValuesMap.set(pv.id, pv.value);
    }

    // Build explicit classifications map if provided by frontend
    const explicitClassifications = new Map<string, ParameterTarget>();
    if (request.parameterClassifications) {
      for (const c of request.parameterClassifications) {
        explicitClassifications.set(c.id, c.target);
      }
    }

    const { parameters, properties } = this.classifyFrameworkProperties(
      framework,
      allParameters,
      paramValuesMap,
      request.applicationId,
      explicitClassifications,
    );

    this.applyComposeAndEnvHandling(
      framework,
      paramValuesMap,
      allParameters,
      parameters,
      properties,
    );

    this.ensureHostnameProperty(
      framework,
      request.applicationId,
      paramValuesMap,
      properties,
    );

    const applicationJson = this.buildApplicationJson(
      request,
      baseApplication,
      framework,
      parameters,
      properties,
    );

    this.persistence.writeApplication(
      request.applicationId,
      applicationJson as any,
    );

    if (request.iconContent) {
      const iconPath = path.join(appDir, request.icon || "icon.png");
      const iconBuffer = Buffer.from(request.iconContent, "base64");
      fs.writeFileSync(iconPath, iconBuffer);
    }

    this.processUploadFiles(request, appDir, paramValuesMap);

    // Generate tests/params-default.json for new applications
    if (!request.update) {
      this.generateTestParams(request, allParameters, appDir);
    }

    return request.applicationId;
  }

  private async loadAndValidateFramework(
    request: IPostFrameworkCreateApplicationBody,
  ): Promise<{
    framework: IFramework;
    baseApplication: any;
    allParameters: IParameter[];
  }> {
    const frameworkOpts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", request.frameworkId),
    };
    const framework = this.readFrameworkJson(
      request.frameworkId,
      frameworkOpts,
    );

    const appOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", framework.extends),
      taskTemplates: [],
    };
    const baseApplication = this.applicationLoader!.readApplicationJson(
      framework.extends,
      appOpts,
    );

    const contextManager =
      this.storage instanceof ContextManager
        ? this.storage
        : (this.storage as any).contextManager ||
          PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(
      this.pathes,
      contextManager,
      this.persistence,
    );
    const allParameters = await templateProcessor.getParameters(
      framework.extends,
      "installation",
    );

    return { framework, baseApplication, allParameters };
  }

  private checkExistingApplication(
    request: IPostFrameworkCreateApplicationBody,
  ): void {
    const localAppNames = this.persistence.getLocalAppNames();
    if (localAppNames.has(request.applicationId)) {
      if (request.update) {
        const existingAppPath = localAppNames.get(request.applicationId)!;
        fs.rmSync(existingAppPath, { recursive: true, force: true });
      } else {
        const existingAppPath = localAppNames.get(request.applicationId)!;
        throw new Error(
          `Application ${request.applicationId} already exists at ${existingAppPath}`,
        );
      }
    }
  }

  /**
   * Separates framework properties into parameters (default: true) and output properties.
   * Also persists remaining parameterValues not listed in framework.properties.
   */
  private classifyFrameworkProperties(
    framework: IFramework,
    allParameters: IParameter[],
    paramValuesMap: Map<string, string | number | boolean>,
    applicationId: string,
    explicitClassifications?: Map<string, ParameterTarget>,
  ): {
    parameters: IParameter[];
    properties: Array<{ id: string; value: string | number | boolean }>;
  } {
    const parameters: IParameter[] = [];
    const properties: Array<{
      id: string;
      value: string | number | boolean;
    }> = [];

    for (const prop of framework.properties) {
      const propId = typeof prop === "string" ? prop : prop.id;
      const isDefault = typeof prop === "object" && prop.default === true;

      const paramDef = allParameters.find((p) => p.id === propId);
      const paramValue = paramValuesMap.get(propId);

      // Use explicit classification if provided, otherwise fall back to framework defaults
      const explicit = explicitClassifications?.get(propId);
      let shouldAddAsParameter: boolean;

      if (explicit) {
        // Frontend explicitly classified this parameter
        shouldAddAsParameter = explicit === "default";
        // If explicit === 'value', it goes to properties
        // If explicit === 'install', it doesn't go to either
      } else {
        shouldAddAsParameter =
          isDefault ||
          (framework.id === "docker-compose" &&
            propId === "hostname" &&
            !!paramDef);
      }

      if (explicit === "install") {
        // Skip - don't store in application.json
        continue;
      }

      if (shouldAddAsParameter && paramDef) {
        const param: IParameter = { ...paramDef };
        if (
          paramValue !== undefined &&
          String(paramValue) !== String(paramDef.default)
        ) {
          param.default = paramValue;
        } else if (paramDef.default !== undefined) {
          param.default = paramDef.default;
        }

        if (propId === "hostname") {
          if (
            framework.id === "docker-compose" ||
            framework.id === "oci-image"
          ) {
            param.required = false;
            if (paramValue === undefined && paramDef.default === undefined) {
              param.default = applicationId;
            }
          }
        }

        if (framework.id === "docker-compose" && propId === "compose_project") {
          param.required = false;
        }

        parameters.push(param);
      } else if (paramValue !== undefined) {
        properties.push({ id: propId, value: paramValue });
      }
    }

    // Persist remaining parameterValues not listed in framework.properties
    const processedIds = new Set([
      ...parameters.map((p) => p.id),
      ...properties.map((p) => p.id),
    ]);
    for (const [paramId, paramValue] of paramValuesMap) {
      if (processedIds.has(paramId)) continue;

      // Check explicit classification for non-framework params
      const explicit = explicitClassifications?.get(paramId);
      if (explicit === "install") continue; // Skip install-only params

      const paramDef = allParameters.find((p) => p.id === paramId);

      if (explicit === "value" && paramValue !== undefined) {
        // Explicitly classified as value
        properties.push({ id: paramId, value: paramValue });
      } else if (explicit === "default" && paramDef) {
        // Explicitly classified as default
        parameters.push({ ...paramDef, default: paramValue });
      } else if (paramDef && String(paramValue) !== String(paramDef.default)) {
        // Legacy behavior: non-framework params with changed values become defaults
        parameters.push({ ...paramDef, default: paramValue });
      }
    }

    return { parameters, properties };
  }

  /**
   * Handles compose_file storage (docker-compose only) and env_file marker detection
   * (docker-compose and oci-image).
   */
  private applyComposeAndEnvHandling(
    framework: IFramework,
    paramValuesMap: Map<string, string | number | boolean>,
    allParameters: IParameter[],
    parameters: IParameter[],
    properties: Array<{ id: string; value: string | number | boolean }>,
  ): void {
    // docker-compose only: store compose_file in application.json
    if (framework.id === "docker-compose") {
      const composeFileValue = paramValuesMap.get("compose_file");
      if (composeFileValue && typeof composeFileValue === "string") {
        const composeFileIndex = properties.findIndex(
          (p) => p.id === "compose_file",
        );
        if (composeFileIndex >= 0 && properties[composeFileIndex]) {
          properties[composeFileIndex].value = composeFileValue;
        } else {
          properties.push({ id: "compose_file", value: composeFileValue });
        }

        const composeParamIndex = parameters.findIndex(
          (p) => p.id === "compose_file",
        );
        if (composeParamIndex < 0) {
          const composeParamDef = allParameters.find(
            (p) => p.id === "compose_file",
          );
          if (composeParamDef) {
            parameters.push({ ...composeParamDef, default: composeFileValue });
          }
        }
      }
    }

    // docker-compose and oci-image: env_file marker detection
    if (framework.id === "docker-compose" || framework.id === "oci-image") {
      const envFileValue = paramValuesMap.get("env_file");
      if (envFileValue && typeof envFileValue === "string") {
        const envContent = Buffer.from(envFileValue, "base64").toString("utf8");
        const hasMarkers = /\{\{.*?\}\}/.test(envContent);
        if (hasMarkers) {
          properties.push({ id: "env_file_has_markers", value: "true" });
        }
        properties.push({ id: "env_file", value: envFileValue });
      }
    }
  }

  /**
   * Ensures hostname is set as a property for docker-compose/oci-image frameworks
   * when not explicitly provided, using the Application ID as default.
   */
  private ensureHostnameProperty(
    framework: IFramework,
    applicationId: string,
    paramValuesMap: Map<string, string | number | boolean>,
    properties: Array<{ id: string; value: string | number | boolean }>,
  ): void {
    if (framework.id !== "docker-compose" && framework.id !== "oci-image") {
      return;
    }
    const hostnameValue = paramValuesMap.get("hostname");
    if (hostnameValue === undefined) {
      const hostnamePropIndex = properties.findIndex(
        (p) => p.id === "hostname",
      );
      if (hostnamePropIndex < 0) {
        properties.push({ id: "hostname", value: applicationId });
      }
    }
  }

  /**
   * Builds the application.json object from framework data, parameters and properties.
   */
  private buildApplicationJson(
    request: IPostFrameworkCreateApplicationBody,
    baseApplication: any,
    framework: IFramework,
    parameters: IParameter[],
    properties: Array<{ id: string; value: string | number | boolean }>,
  ): any {
    const applicationJson: any = {
      name: request.name,
      description: request.description,
      extends: framework.extends,
      icon: request.icon || baseApplication.icon || "icon.png",
      ...(parameters.length > 0 && { parameters }),
      ...(properties.length > 0 && { properties }),
      installation: {},
    };

    const metaFields: Array<{ key: string; value: any }> = [
      {
        key: "url",
        value:
          request.url ??
          (framework as any).url ??
          (baseApplication as any).url,
      },
      {
        key: "documentation",
        value:
          request.documentation ??
          (framework as any).documentation ??
          (baseApplication as any).documentation,
      },
      {
        key: "source",
        value:
          request.source ??
          (framework as any).source ??
          (baseApplication as any).source,
      },
      {
        key: "vendor",
        value:
          request.vendor ??
          (framework as any).vendor ??
          (baseApplication as any).vendor,
      },
    ];
    for (const { key, value } of metaFields) {
      if (value) {
        applicationJson[key] = value;
      }
    }
    if (request.tags && request.tags.length > 0) {
      applicationJson.tags = request.tags;
    }
    if (request.stacktype) {
      applicationJson.stacktype = request.stacktype;
    }

    return applicationJson;
  }

  /**
   * Processes upload files: creates template and script files for each uploaded file,
   * then updates application.json with pre_start template references.
   */
  private processUploadFiles(
    request: IPostFrameworkCreateApplicationBody,
    appDir: string,
    paramValuesMap: Map<string, string | number | boolean>,
  ): void {
    if (!request.uploadfiles || request.uploadfiles.length === 0) {
      return;
    }

    const uploadTemplateNames: string[] = [];

    for (let i = 0; i < request.uploadfiles.length; i++) {
      const uploadFile = request.uploadfiles[i]!;
      const fileLabel = this.getUploadFileLabel(uploadFile);
      const sanitized = this.sanitizeFilename(fileLabel);
      const templateName = `${i}-upload-${sanitized}`;
      const scriptName = `${i}-upload-${sanitized}.sh`;
      const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;
      const destParamId = `upload_${sanitized.replace(/-/g, "_")}_destination`;
      const outputId = `upload_${sanitized.replace(/-/g, "_")}_uploaded`;

      const fileContent =
        uploadFile.content ??
        (paramValuesMap.get(contentParamId) as string | undefined);

      const uploadTemplate = {
        name: `Upload ${fileLabel}`,
        description: `Uploads ${fileLabel} to ${uploadFile.destination}`,
        execute_on: "ve",
        skip_if_all_missing: [contentParamId],
        parameters: [
          {
            id: contentParamId,
            name: fileLabel,
            type: "string",
            upload: true,
            ...(uploadFile.certtype ? { certtype: uploadFile.certtype } : {}),
            required: uploadFile.required ?? false,
            advanced: uploadFile.advanced ?? false,
            description: `Configuration file: ${fileLabel}`,
            ...(fileContent ? { default: fileContent } : {}),
          },
          {
            id: destParamId,
            name: "Destination Path",
            type: "string",
            default: uploadFile.destination,
            advanced: true,
            description: "Target path: {volume_key}:{filename}",
          },
          {
            id: "shared_volpath",
            name: "Shared Volume Path",
            type: "string",
            advanced: true,
            description: "Path to the shared volume mount point",
          },
          {
            id: "hostname",
            name: "Hostname",
            type: "string",
            required: true,
            description: "Container hostname",
          },
          {
            id: "uid",
            name: "UID",
            type: "string",
            default: "0",
            advanced: true,
            description: "User ID for file ownership",
          },
          {
            id: "gid",
            name: "GID",
            type: "string",
            default: "0",
            advanced: true,
            description: "Group ID for file ownership",
          },
          {
            id: "mapped_uid",
            name: "Mapped UID",
            type: "string",
            default: "",
            advanced: true,
            description: "Mapped user ID for unprivileged containers",
          },
          {
            id: "mapped_gid",
            name: "Mapped GID",
            type: "string",
            default: "",
            advanced: true,
            description: "Mapped group ID for unprivileged containers",
          },
        ],
        commands: [
          {
            name: `Upload ${fileLabel}`,
            script: scriptName,
            library: "upload-file-common.sh",
            outputs: [outputId],
          },
        ],
      };

      this.persistence.writeTemplate(
        templateName,
        uploadTemplate as any,
        false,
        appDir,
      );

      const scriptContent = `#!/bin/sh
# Upload file: ${fileLabel}
# Auto-generated by create-application
set -eu

upload_pre_start_file \\
  "{{ ${contentParamId} }}" \\
  "{{ ${destParamId} }}" \\
  "${fileLabel}" \\
  "{{ shared_volpath }}" \\
  "{{ hostname }}" \\
  "{{ uid }}" \\
  "{{ gid }}" \\
  "{{ mapped_uid }}" \\
  "{{ mapped_gid }}"

upload_output_result "${outputId}"
`;
      this.persistence.writeScript(scriptName, scriptContent, false, appDir);
      uploadTemplateNames.push(`${templateName}.json`);
    }

    if (uploadTemplateNames.length > 0) {
      const appJsonPath = path.join(appDir, "application.json");
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
      if (!appJson.installation) {
        appJson.installation = {};
      }
      if (!appJson.installation.pre_start) {
        appJson.installation.pre_start = [];
      }
      for (const templateName of uploadTemplateNames) {
        appJson.installation.pre_start.push(templateName);
      }
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
    }
  }

  /**
   * Prepare application parameters from framework request data.
   * Shared logic between createApplicationFromFramework and getPreviewUnresolvedParameters.
   */
  private async prepareApplicationParameters(
    request: IFrameworkApplicationDataBody,
  ): Promise<{
    framework: IFramework;
    initialInputs: Array<{ id: string; value: IParameterValue }>;
  }> {
    // Load framework
    const frameworkOpts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", request.frameworkId),
    };
    const framework = this.readFrameworkJson(request.frameworkId, frameworkOpts);

    // Build initialInputs from parameterValues
    const initialInputs: Array<{ id: string; value: IParameterValue }> = [];
    for (const pv of request.parameterValues) {
      if (pv.value !== null && pv.value !== undefined && pv.value !== "") {
        initialInputs.push({ id: pv.id, value: pv.value });
      }
    }

    // Add upload file contents as parameters (same logic as in createApplicationFromFramework)
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      for (const uploadFile of request.uploadfiles) {
        if (uploadFile.content) {
          const fileLabel = this.getUploadFileLabel(uploadFile);
          const sanitized = this.sanitizeFilename(fileLabel);
          const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;
          initialInputs.push({ id: contentParamId, value: uploadFile.content });
        }
      }
    }

    return { framework, initialInputs };
  }

  /**
   * Get a preview of the unresolved parameters that will be shown during installation.
   * Uses the same parameter resolution logic as the actual installation flow.
   *
   * IMPORTANT: parameterValues from step 3 (framework parameters like 'volumes') are
   * treated as defaults, NOT as resolved inputs. This matches how createApplicationFromFramework
   * writes them to application.json (as param.default), so the preview shows the same
   * parameters that will be editable after the application is created.
   */
  public async getPreviewUnresolvedParameters(
    request: IFrameworkApplicationDataBody,
    task: TaskType,
    veContext: IVEContext,
  ): Promise<{ unresolvedParameters: IParameter[]; frameworkProperties: IFrameworkPropertyInfo[] }> {
    const { framework } = await this.prepareApplicationParameters(request);

    // Build a map of parameterValues for later use as defaults
    const paramValuesMap = new Map<string, IParameterValue>();
    for (const pv of request.parameterValues) {
      if (pv.value !== null && pv.value !== undefined && pv.value !== "") {
        paramValuesMap.set(pv.id, pv.value);
      }
    }

    // Only pass upload file contents as initialInputs (not framework parameters)
    // Framework parameters (like 'volumes') will be applied as defaults below,
    // matching how createApplicationFromFramework writes them to application.json
    const initialInputs: Array<{ id: string; value: IParameterValue }> = [];
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      for (const uploadFile of request.uploadfiles) {
        if (uploadFile.content) {
          const fileLabel = this.getUploadFileLabel(uploadFile);
          const sanitized = this.sanitizeFilename(fileLabel);
          const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;
          initialInputs.push({ id: contentParamId, value: uploadFile.content });
        }
      }
    }

    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager =
      this.storage instanceof ContextManager
        ? this.storage
        : (this.storage as any).contextManager ||
          PersistenceManager.getInstance().getContextManager();

    const templateProcessor = new TemplateProcessor(
      this.pathes,
      contextManager,
      this.persistence,
    );

    // Load application with only upload inputs (not framework parameters)
    const loaded = await templateProcessor.loadApplication(
      framework.extends,
      task,
      veContext,
      undefined,
      initialInputs,
      true, // skipUnresolved / enumValuesRefresh
    );

    // Apply parameterValues as defaults to loaded parameters
    // This matches how createApplicationFromFramework writes them (param.default = value)
    for (const param of loaded.parameters) {
      const value = paramValuesMap.get(param.id);
      if (value !== undefined) {
        param.default = value;
      }
    }

    // Use same filtering logic as TemplateProcessor.getUnresolvedParameters()
    let unresolvedParams: IParameter[];

    if (loaded.parameterTrace && loaded.parameterTrace.length > 0) {
      const traceById = new Map(
        loaded.parameterTrace.map((entry) => [entry.id, entry]),
      );
      unresolvedParams = loaded.parameters.filter((param) => {
        if (param.type === "enum") return true;
        const trace = traceById.get(param.id);
        // Include parameters that are missing OR have only a default value
        // (both should be shown as editable in the UI)
        return trace
          ? trace.source === "missing" || trace.source === "default"
          : true;
      });
    } else {
      // Fallback: Only parameters whose id is not in resolvedParams
      unresolvedParams = loaded.parameters.filter(
        (param) =>
          undefined ==
          loaded.resolvedParams.find(
            (rp) => rp.id == param.id && rp.template != param.template,
          ),
      );
    }

    // Add virtual upload parameters if uploadfiles are defined
    if (request.uploadfiles && request.uploadfiles.length > 0) {
      const uploadParams = this.generateUploadParameters(request.uploadfiles);

      for (const uploadParam of uploadParams) {
        const existingParam = unresolvedParams.find(
          (p) => p.id === uploadParam.id,
        );
        if (!existingParam) {
          unresolvedParams.push(uploadParam);
        }
      }
    }

    // Build framework properties info for the frontend
    const frameworkProperties: IFrameworkPropertyInfo[] = framework.properties.map(
      (prop) => {
        const propId = typeof prop === "string" ? prop : prop.id;
        const isDefault = typeof prop === "object" && prop.default === true;
        return { id: propId, isDefault };
      },
    );

    return { unresolvedParameters: unresolvedParams, frameworkProperties };
  }

  /**
   * Generate virtual upload parameters from uploadfiles definition.
   * Used by getPreviewUnresolvedParameters to show upload parameters
   * before the actual templates are created on the filesystem.
   */
  private generateUploadParameters(uploadfiles: IUploadFile[]): IParameter[] {
    const parameters: IParameter[] = [];

    for (const uploadFile of uploadfiles) {
      const fileLabel = this.getUploadFileLabel(uploadFile);
      const sanitized = this.sanitizeFilename(fileLabel);
      const contentParamId = `upload_${sanitized.replace(/-/g, "_")}_content`;

      parameters.push({
        id: contentParamId,
        name: fileLabel,
        type: "string",
        upload: true,
        required: uploadFile.required ?? false,
        advanced: uploadFile.advanced ?? false,
        description: `Configuration file: ${fileLabel}`,
        templatename: "Upload Files",
        ...(uploadFile.content ? { default: uploadFile.content } : {}),
      });
    }

    return parameters;
  }

  /**
   * Sanitize filename for use in parameter IDs and template names.
   * Includes the file extension to avoid collisions (e.g., server.crt vs server.key).
   */
  private sanitizeFilename(filename: string): string {
    const base = path.basename(filename);
    return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  /**
   * Get the display label for an upload file.
   * Returns the explicit label if set, otherwise extracts the filename from destination.
   * @example getUploadFileLabel({ destination: "config:certs/server.crt" }) => "server.crt"
   * @example getUploadFileLabel({ destination: "config:app.conf", label: "App Config" }) => "App Config"
   */
  private getUploadFileLabel(uploadFile: IUploadFile): string {
    if (uploadFile.label) {
      return uploadFile.label;
    }
    // Handle missing destination (shouldn't happen but be defensive)
    if (!uploadFile.destination) {
      return 'unknown';
    }
    // Extract filename from destination (format: "volume:path/to/file.ext")
    const colonIndex = uploadFile.destination.indexOf(':');
    const filePath = colonIndex >= 0 ? uploadFile.destination.slice(colonIndex + 1) : uploadFile.destination;
    return path.basename(filePath);
  }

  private addErrorToOptions(opts: IReadFrameworkOptions, error: Error | any) {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    } else {
      throw new JsonError(error?.message || String(error));
    }
  }

  /**
   * Generates tests/params-default.json for a new application.
   * Contains vm_id and all required parameters in CLI format [{name, value}].
   */
  private generateTestParams(
    request: IPostFrameworkCreateApplicationBody,
    allParameters: IParameter[],
    appDir: string,
  ): void {
    const testsDir = path.join(appDir, "tests");
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }

    const params: Array<{ name: string; value: string }> = [
      { name: "vm_id", value: "{{ vm_id }}" },
    ];

    // Add all required parameters
    for (const param of allParameters) {
      if (!param.required) continue;
      if (param.id === "vm_id") continue;

      if (param.upload) {
        // For file upload params, use file:<filename> format
        // Try to extract filename from uploadfiles definition
        const uploadFile = request.uploadfiles?.find((uf) => {
          const label = this.getUploadFileLabel(uf);
          const sanitized = this.sanitizeFilename(label).replace(/-/g, "_");
          return `upload_${sanitized}_content` === param.id;
        });

        if (uploadFile) {
          const colonIndex = uploadFile.destination.indexOf(":");
          const filePath =
            colonIndex >= 0
              ? uploadFile.destination.slice(colonIndex + 1)
              : uploadFile.destination;
          const lastSlash = filePath.lastIndexOf("/");
          const fileName =
            lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
          params.push({ name: param.id, value: `file:${fileName}` });
        } else {
          params.push({ name: param.id, value: `file:${param.id}` });
        }
      } else {
        // Use default value or a placeholder
        const defaultValue =
          param.default !== undefined ? String(param.default) : "";
        params.push({ name: param.id, value: defaultValue });
      }
    }

    const paramsPath = path.join(testsDir, "params-default.json");
    fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");
  }
}
