import { EventEmitter } from "events";
import { JsonError } from "@src/jsonvalidator.mjs";
import {
  IConfiguredPathes,
  IReadApplicationOptions,
  IResolvedParam,
  VEConfigurationError,
  VELoadApplicationError,
} from "@src/backend-types.mjs";
import { TaskType, ICommand, IParameter, IJsonError } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ApplicationLoader } from "@src/apploader.mjs";
import { ScriptValidator } from "@src/scriptvalidator.mjs";
import { ContextManager } from "../context-manager.mjs";
import {
  ITemplatePersistence,
  IApplicationPersistence,
} from "../persistence/interfaces.mjs";
import {
  FileSystemRepositories,
  type IRepositories,
} from "../persistence/repositories.mjs";
import {
  ExecutionMode,
  determineExecutionMode,
} from "../ve-execution/ve-execution-constants.mjs";
import { ITemplateReference } from "../backend-types.mjs";
import {
  IProcessTemplateOpts,
  IParameterWithTemplate,
  IProcessedTemplate,
  ITemplateTraceEntry,
  IParameterTraceEntry,
  ITemplateTraceInfo,
  ITemplateProcessorLoadResult,
} from "./templateprocessor-types.mjs";
import { TemplateResolver } from "./template-resolver.mjs";
import { TemplateTraceBuilder } from "./template-trace-builder.mjs";
import { EnumValuesResolver } from "./enum-values-resolver.mjs";
import { TemplateValidator } from "./template-validator.mjs";
import { TemplateOutputProcessor } from "./template-output-processor.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";

export type {
  IProcessTemplateOpts,
  IParameterWithTemplate,
  IProcessedTemplate,
  ITemplateTraceEntry,
  IParameterTraceEntry,
  ITemplateTraceInfo,
  ITemplateProcessorLoadResult,
};
export class TemplateProcessor extends EventEmitter {
  private repositories: IRepositories;
  private resolver: TemplateResolver;
  private traceBuilder: TemplateTraceBuilder;
  private enumValuesResolver: EnumValuesResolver;
  private validator: TemplateValidator;
  private outputProcessor: TemplateOutputProcessor;
  resolvedParams: IResolvedParam[] = [];
  constructor(
    private pathes: IConfiguredPathes,
    private storageContext: ContextManager,
    private persistence: IApplicationPersistence & ITemplatePersistence,
    repositories?: IRepositories,
  ) {
    super();
    this.repositories =
      repositories ?? new FileSystemRepositories(this.pathes, this.persistence);
    this.resolver = new TemplateResolver(this.repositories);
    this.traceBuilder = new TemplateTraceBuilder(this.pathes);
    this.enumValuesResolver = new EnumValuesResolver();
    this.validator = new TemplateValidator(
      this.resolver.resolveMarkdownSection.bind(this.resolver),
      this.resolveEnumValuesTemplate.bind(this),
      this.resolver.extractTemplateName.bind(this.resolver),
      this.resolver.normalizeTemplateName.bind(this.resolver),
    );
    this.outputProcessor = new TemplateOutputProcessor(
      (applicationId, templateName, category) =>
        this.resolver.resolveTemplate(applicationId, templateName, category),
      this.resolver.normalizeTemplateName.bind(this.resolver),
    );
  }
  async loadApplication(
    applicationName: string,
    task: TaskType,
    veContext?: IVEContext,
    executionMode?: ExecutionMode,
    initialInputs?: Array<{ id: string; value: string | number | boolean }>,
    enumValuesRefresh?: boolean,
  ): Promise<ITemplateProcessorLoadResult> {
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", applicationName),
      taskTemplates: [],
    };
    const appLoader = new ApplicationLoader(this.pathes, this.persistence);
    let application = appLoader.readApplicationJson(applicationName, readOpts);
    // Don't throw immediately - collect all errors first (including template processing errors)
    // Errors from readApplicationJson will be added to the errors array during template processing
    // 2. Find the application entry for the requested task
    const appEntry = readOpts.taskTemplates.find((t) => t.task === task);
    if (!appEntry) {
      const message = `Template ${task} not found in ${applicationName} application`;
      throw new VELoadApplicationError(message, applicationName, task, [
        new JsonError(message),
      ]);
    }
    application!.id = applicationName;
    // 3. Get template list for the task
    const templates: (ITemplateReference | string)[] | undefined =
      readOpts.taskTemplates.find((t) => t.task === task)?.templates;

    if (!templates) {
      const appBase = {
        name: applicationName,
        description: application?.description || "",
        icon: application?.icon,
        errors: [`Task ${task} not found in application.json`],
      };
      const err = new JsonError(`Task ${task} not found in application.json`);
      (err as any).application = appBase;
      throw err;
    }

    // 4. Track en parameters
    // Initialize resolvedParams with initialInputs (user-provided parameters)
    // This allows skip_if_all_missing to check user inputs
    const resolvedParams: IResolvedParam[] = [];
    const pendingPropertyDefaults: import("./template-output-processor.mjs").PropertyDefaultEntry[] = [];
    if (initialInputs) {
      for (const input of initialInputs) {
        // Only add non-empty values to resolvedParams
        if (
          input.value !== null &&
          input.value !== undefined &&
          input.value !== ""
        ) {
          // IResolvedParam requires 'id' and 'template'
          // We use "user_input" as template name for user-provided parameters
          // This allows skip_if_all_missing to find user inputs
          resolvedParams.push({
            id: input.id,
            template: "user_input",
          });
        }
      }
    }
    const enumValueInputs = initialInputs
      ? initialInputs.filter(
          (input) =>
            input.value !== null &&
            input.value !== undefined &&
            input.value !== "",
        )
      : undefined;
    // 5. Process each template
    // Start with errors from readApplicationJson (e.g., duplicate templates)
    const errors: IJsonError[] = readOpts.error.details
      ? [...readOpts.error.details]
      : [];
    let outParameters: IParameterWithTemplate[] = [];
    let outCommands: ICommand[] = [];
    let webuiTemplates: string[] = [];
    const processedTemplates = new Map<string, IProcessedTemplate>();
    const templateReferences = new Map<string, Set<string>>(); // template -> set of referenced templates
    const outputSources = new Map<
      string,
      { template: string; kind: "outputs" | "properties" }
    >();

    // 5a. Inject application-level parameters if defined directly in application.json
    // This takes precedence over parameters defined in templates (similar to addon approach)
    if (application?.parameters && application.parameters.length > 0) {
      for (const param of application.parameters) {
        outParameters.push({
          ...param,
          template: "application.json",
        });
      }
    }

    // 5b. Inject application-level properties if defined directly in application.json
    // Properties with 'value' mark the parameter as resolved (output)
    // Properties with 'default' only set the default value (still editable)
    if (application?.properties && application.properties.length > 0) {
      const propertiesWithValue: { id: string; value: any }[] = [];
      for (const prop of application.properties) {
        if (prop.value !== undefined) {
          // Property with explicit value - mark as resolved
          resolvedParams.push({
            id: prop.id,
            template: "application.json",
          });
          outputSources.set(prop.id, {
            template: "application.json",
            kind: "properties",
          });
          propertiesWithValue.push({ id: prop.id, value: prop.value });
        }
        if (prop.default !== undefined || prop.required !== undefined) {
          // Property with default or required override - add to pendingPropertyDefaults
          // so it gets applied after all parameters are collected
          const entry: { id: string; default?: string | number | boolean; required?: boolean } = {
            id: prop.id,
          };
          if (prop.default !== undefined) {
            entry.default = prop.default as string | number | boolean;
          }
          if (prop.required !== undefined) {
            entry.required = prop.required as boolean;
          }
          pendingPropertyDefaults.push(entry);
        }
      }
      // Add a properties command to set these values during execution
      if (propertiesWithValue.length > 0) {
        outCommands.push({
          name: "Application Properties",
          properties: propertiesWithValue,
        });
      }
    }

    // Build applicationFlags from supports array for implements checks
    const applicationFlags: Record<string, boolean> = {};
    if (application?.supports) {
      for (const flag of application.supports) {
        applicationFlags[flag] = true;
      }
    }

    for (const tmpl of templates) {
      const templateCategory = this.resolver.extractTemplateCategory(tmpl);
      let ptOpts: IProcessTemplateOpts = {
        application: applicationName,
        template: tmpl,
        templatename: this.resolver.extractTemplateName(tmpl),
        resolvedParams,
        visitedTemplates: new Set<string>(),
        parameters: outParameters,
        commands: outCommands,
        errors,
        requestedIn: task,
        webuiTemplates,
        executionMode:
          executionMode !== undefined
            ? executionMode
            : determineExecutionMode(),
        ...(enumValueInputs && enumValueInputs.length > 0
          ? { enumValueInputs }
          : {}),
        enumValuesRefresh: enumValuesRefresh === true,
        processedTemplates,
        templateReferences,
        outputSources,
        templateCategory,
        pendingPropertyDefaults,
        applicationFlags,
      };
      if (veContext !== undefined) {
        ptOpts.veContext = veContext;
      }
      await this.#processTemplate(ptOpts);
    }

    // Apply deferred property defaults now that all parameters are collected.
    // Property defaults from early templates (e.g. 050-set-project-parameters)
    // can now find parameters defined in later templates (e.g. 100-conf-create-configure-lxc).
    if (pendingPropertyDefaults.length > 0) {
      this.outputProcessor.applyPropertyDefaults(pendingPropertyDefaults, outParameters);
    }

    // Look-ahead: conditionally skip create_ct and start categories
    // based on whether downstream categories have unskipped templates
    this.applyLookaheadSkipping(outCommands);

    const processedTemplatesArray =
      this.traceBuilder.buildProcessedTemplatesArray(
        processedTemplates,
        templateReferences,
      );

    const templateTrace = this.traceBuilder.buildTemplateTrace(
      processedTemplatesArray,
    );
    const parameterTrace = this.traceBuilder.buildParameterTrace(
      outParameters,
      resolvedParams,
      outputSources,
    );
    const traceInfo = this.traceBuilder.buildTraceInfo(applicationName, task);
    // Save resolvedParams for getUnresolvedParameters
    this.resolvedParams = resolvedParams;

    // Apply application-level parameter overrides
    if (application?.parameterOverrides) {
      for (const override of application.parameterOverrides) {
        const param = outParameters.find((p) => p.id === override.id);
        if (param) {
          if (override.name) param.name = override.name;
          if (override.description) param.description = override.description;
        }
      }
    }

    if (errors.length > 0) {
      const appBase = {
        name: applicationName,
        description: application?.description || "",
        icon: application?.icon,
        errors: errors.map(
          (d: any) => d?.passed_message || d?.message || String(d),
        ),
      };
      const primaryMessage =
        errors.length === 1
          ? String(
              (errors[0] as any)?.passed_message ??
                (errors[0] as any)?.message ??
                "Template processing error",
            )
          : "Template processing error";

      const err = new VEConfigurationError(
        primaryMessage,
        applicationName,
        errors,
      );
      (err as any).application = appBase;
      throw err;
    }
    return {
      parameters: outParameters,
      commands: outCommands,
      resolvedParams: resolvedParams,
      webuiTemplates: webuiTemplates,
      application: application,
      processedTemplates: processedTemplatesArray,
      templateTrace,
      parameterTrace,
      traceInfo,
    };
  }
  private async resolveEnumValuesTemplate(
    enumTemplate: string,
    opts: IProcessTemplateOpts,
  ): Promise<
    | (string | { name: string; value: string | number | boolean })[]
    | null
    | undefined
  > {
    // enumValuesTemplate implies category "list" - explicitly pass it
    const resolved = this.resolver.resolveTemplate(
      opts.application,
      enumTemplate,
      "list",
    );
    const executeOn = resolved?.template?.execute_on;
    return this.enumValuesResolver.resolveEnumValuesTemplate(
      enumTemplate,
      {
        ...opts,
        templateCategory: "list", // enumValuesTemplate always uses "list" category
        ...(executeOn ? { enumValuesExecuteOn: typeof executeOn === "object" ? (executeOn as { where: string }).where : executeOn } : {}),
      },
      (innerOpts) => this.#processTemplate(innerOpts),
      (message) => this.emit("message", message),
    );
  }
  // Private method to process a template (including nested templates)
  async #processTemplate(opts: IProcessTemplateOpts): Promise<void> {
    opts.visitedTemplates = opts.visitedTemplates ?? new Set<string>();
    opts.errors = opts.errors ?? [];
    // Prevent endless recursion
    if (
      opts.visitedTemplates.has(
        this.resolver.extractTemplateName(opts.template),
      )
    ) {
      opts.errors.push(
        new JsonError(
          `Endless recursion detected for template: ${opts.template}`,
        ),
      );
      return;
    }
    const templateName = this.resolver.extractTemplateName(opts.template);
    opts.visitedTemplates.add(templateName);
    // Pass templateCategory if set (e.g., "list" for enumValuesTemplate)
    const resolvedTemplate = this.resolver.resolveTemplate(
      opts.application,
      templateName,
      opts.templateCategory!,
    );
    if (!resolvedTemplate) {
      const msg =
        `Template file not found: ${opts.template}` +
        ` (requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})`;
      opts.errors.push(new JsonError(msg));
      this.emit("message", {
        stderr: msg,
        result: null,
        exitCode: -1,
        command: String(opts.templatename || opts.template),
        execute_on: undefined,
        index: 0,
      });
      return;
    }
    const tmplData = resolvedTemplate.template;
    const tmplRef = resolvedTemplate.ref;
    opts.templateRef = tmplRef;
    // Set template category for script resolution (e.g., "list" templates use "list" scripts)
    opts.templateCategory = tmplRef.category;
    // Note: outputs on template level are no longer supported
    // All outputs should be defined on command level
    // Properties commands will be handled directly in the resolvedParams section below

    // Validate execute_on: required if template has executable commands (script, command, template)
    // Optional if template only has properties commands
    const hasExecutableCommands =
      tmplData.commands?.some(
        (cmd) =>
          cmd.script !== undefined ||
          cmd.command !== undefined ||
          cmd.template !== undefined,
      ) ?? false;
    if (hasExecutableCommands && !tmplData.execute_on) {
      opts.errors.push(
        new JsonError(
          `Template "${this.resolver.extractTemplateName(opts.template)}" has executable commands (script, command, or template) but is missing required "execute_on" property.`,
        ),
      );
    }

    // implements: if template declares a feature flag, check if application supports it.
    // Silently excluded — not tracked, not shown, not skipped.
    if (tmplData.implements) {
      if (!opts.applicationFlags?.[tmplData.implements]) {
        return;
      }
    }

    // Check if template should be skipped due to missing parameters
    // This check happens BEFORE marking outputs, so outputs from previous templates are available
    // but we don't set outputs for skipped templates
    // Include pending property defaults as "resolved" for skip_if_all_missing checks.
    // Property defaults have a value (the default) but aren't yet applied to parameters.
    const resolvedForSkipCheck = opts.pendingPropertyDefaults?.length
      ? [
          ...opts.resolvedParams,
          ...opts.pendingPropertyDefaults.map((pd) => ({
            id: pd.id,
            template: "application.json (default)",
          })),
        ]
      : opts.resolvedParams;
    const skipDecision = this.validator.shouldSkipTemplate(
      tmplData,
      resolvedForSkipCheck,
      opts.parameters,
    );
    const shouldSkip = skipDecision.shouldSkip;
    const skipReason = skipDecision.reason;

    // Determine if template is conditional (skip_if_all_missing, skip_if_property_set)
    const isConditional =
      !!(
        tmplData.skip_if_all_missing && tmplData.skip_if_all_missing.length > 0
      ) || !!tmplData.skip_if_property_set;

    // Determine if template is shared or app-specific
    const isSharedTemplate = tmplRef.scope === "shared";

    // Store template information
    if (opts.processedTemplates) {
      const normalizedName = this.resolver.normalizeTemplateName(templateName);
      opts.processedTemplates.set(normalizedName, {
        name: normalizedName,
        path: this.resolver.buildTemplateTracePath(tmplRef),
        isShared: isSharedTemplate,
        skipped: shouldSkip,
        conditional: isConditional,
        category: tmplRef.category,
        templateData: tmplData,
      });
    }

    if (shouldSkip) {
      // Replace all commands with "skipped" commands that always exit with 0
      // Only set execute_on if template has it (properties-only templates don't need it)
      for (const cmd of tmplData.commands ?? []) {
        const description =
          skipReason === "property_set"
            ? `Skipped: property '${tmplData.skip_if_property_set}' is set`
            : "Skipped: all required parameters missing";
        const skippedCommand: ICommand = {
          name: `${cmd.name || tmplData.name || "unnamed-template"} (skipped)`,
          command: "exit 0",
          description,
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
          ...(tmplData.hook_trigger_now !== undefined && { hook_trigger_now: tmplData.hook_trigger_now }),
          ...(opts.templateCategory && { category: opts.templateCategory }),
        };
        opts.commands.push(skippedCommand);
      }
      // IMPORTANT: Do NOT set outputs when template is skipped
      // This ensures that subsequent templates correctly detect missing parameters
      // IMPORTANT: We intentionally DO add parameters when the skip reason is "all_missing".
      // Rationale: The UI needs to see these parameters even when inputs start empty,
      // while commands/outputs remain skipped.
      if (skipReason === "all_missing") {
        await this.validator.validateAndAddParameters(
          opts,
          tmplData,
          templateName,
          tmplRef,
        );
      }
      return; // Exit early, don't process this template further
    }

    // Mark outputs as resolved AFTER confirming template is not skipped
    // This ensures that outputs are only set for templates that actually execute
    // Allow overwriting outputs if template only has properties commands (explicit value setting)
    // Prevent overwriting outputs from different templates with scripts/commands (prevents conflicts)
    const currentTemplateName = this.resolver.extractTemplateName(
      opts.template,
    );

    // Collect all outputs from all commands (including properties commands)
    const outputCollection = this.outputProcessor.collectOutputs(tmplData);

    // Check for duplicates and throw error if found
    if (outputCollection.duplicateIds.size > 0) {
      const duplicateList = Array.from(outputCollection.duplicateIds).join(
        ", ",
      );
      opts.errors.push(
        new JsonError(
          `Duplicate output/property IDs found in template "${currentTemplateName}": ${duplicateList}. Each ID must be unique within a template.`,
        ),
      );
      return; // Don't process further if duplicates found
    }

    // Note: outputs on template level are no longer supported
    // All outputs should be defined on command level

    // Add all collected outputs to resolvedParams
    // Check for conflicts: if another template in the same task already set this output ID, it's an error
    // UNLESS at least one of the templates is conditional (skip_if_all_missing or skip_if_property_set)
    // In that case, only one template will execute in practice, so it's not a real conflict
    this.outputProcessor.applyOutputs({
      applicationId: opts.application,
      currentTemplateName,
      isConditional,
      outputCollection,
      resolvedParams: opts.resolvedParams,
      ...(opts.outputSources ? { outputSources: opts.outputSources } : {}),
      ...(opts.processedTemplates
        ? { processedTemplates: opts.processedTemplates }
        : {}),
      ...(opts.errors ? { errors: opts.errors } : {}),
    });

    await this.validator.validateAndAddParameters(
      opts,
      tmplData,
      templateName,
      tmplRef,
    );

    // Collect property defaults for deferred application (after all templates are processed).
    // Parameters from later templates may not exist yet at this point.
    if (outputCollection.propertyDefaults.length > 0 && opts.pendingPropertyDefaults) {
      opts.pendingPropertyDefaults.push(...outputCollection.propertyDefaults);
    }

    // Add commands or process nested templates

    for (const cmd of tmplData.commands ?? []) {
      // Set command name from template name if command name is missing or empty
      // This applies to all command types: script, command, template, and properties
      // This is especially important for properties-only commands which often don't have a name field
      if (
        !cmd.name ||
        (typeof cmd.name === "string" && cmd.name.trim() === "")
      ) {
        cmd.name = `${tmplData.name || "unnamed-template"}`;
      }
      if (cmd.template !== undefined) {
        // Track template reference
        if (opts.templateReferences) {
          const currentTemplateName =
            this.resolver.normalizeTemplateName(templateName);
          const referencedTemplateName = this.resolver.normalizeTemplateName(
            cmd.template,
          );
          if (!opts.templateReferences.has(currentTemplateName)) {
            opts.templateReferences.set(currentTemplateName, new Set());
          }
          opts.templateReferences
            .get(currentTemplateName)!
            .add(referencedTemplateName);
        }

        await this.#processTemplate({
          ...opts,
          template: cmd.template,
          parentTemplate: templateName,
        });
      } else if (cmd.script !== undefined) {
        const scriptValidator = new ScriptValidator();
        // Pass template category for script resolution (e.g., "list" templates use "list" scripts)
        const scriptResolution = this.resolver.resolveScriptContent(
          opts.application,
          cmd.script,
          opts.templateCategory,
        );
        scriptValidator.validateScriptContent(
          cmd,
          opts.application,
          opts.errors,
          opts.parameters,
          opts.resolvedParams,
          scriptResolution.content,
          opts.requestedIn,
          opts.parentTemplate,
        );
        const scriptPath = this.resolver.resolveScriptPath(
          scriptResolution.ref,
        );

        // Validate and resolve library path if specified
        const commandWithLibrary: ICommand = {
          ...cmd,
          script: scriptPath || cmd.script,
          ...(scriptResolution.content !== null
            ? { scriptContent: scriptResolution.content }
            : {}),
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
          ...(tmplData.hook_trigger_now !== undefined && { hook_trigger_now: tmplData.hook_trigger_now }),
          ...(opts.templateCategory && { category: opts.templateCategory }),
        };

        if (cmd.library !== undefined) {
          const libraries = Array.isArray(cmd.library) ? cmd.library : [cmd.library];
          const allContents: string[] = [];
          let lastLibraryPath: string | undefined;

          for (const lib of libraries) {
            const libraryResolution = this.resolver.resolveLibraryContent(
              opts.application,
              lib,
            );
            scriptValidator.validateLibraryContent(
              lib,
              opts.errors,
              libraryResolution.content,
              opts.requestedIn,
              opts.parentTemplate,
            );
            const libraryPath = this.resolver.resolveLibraryPath(
              libraryResolution.ref,
            );
            if (libraryResolution.content !== null) {
              allContents.push(libraryResolution.content);
            }
            if (libraryPath) {
              lastLibraryPath = libraryPath;
            }
          }

          if (allContents.length > 0) {
            commandWithLibrary.libraryContent = allContents.join("\n\n");
          }
          if (lastLibraryPath) {
            commandWithLibrary.libraryPath = lastLibraryPath;
          }
        }

        opts.commands.push(commandWithLibrary);
      } else if (cmd.command !== undefined) {
        const scriptValidator = new ScriptValidator();
        scriptValidator.validateCommand(
          cmd,
          opts.errors,
          opts.parameters,
          opts.resolvedParams,
          opts.requestedIn,
          opts.parentTemplate,
        );
        const commandToAdd: ICommand = {
          ...cmd,
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
          ...(tmplData.hook_trigger_now !== undefined && { hook_trigger_now: tmplData.hook_trigger_now }),
          ...(opts.templateCategory && { category: opts.templateCategory }),
        };
        opts.commands.push(commandToAdd);
      } else {
        // Handle properties-only commands or other command types
        // Ensure name is set (should already be set above, but ensure it's preserved)
        // Properties-only commands don't need execute_on (they don't execute anything)
        const commandToAdd: ICommand = {
          ...cmd,
          name: cmd.name || tmplData.name || "unnamed-template",
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
          ...(tmplData.hook_trigger_now !== undefined && { hook_trigger_now: tmplData.hook_trigger_now }),
          ...(opts.templateCategory && { category: opts.templateCategory }),
        };
        opts.commands.push(commandToAdd);
      }
    }
  }
  /**
   * Look-ahead skip logic for create_ct and start categories.
   * - create_ct is skipped if pre_start has no unskipped commands
   * - start is skipped if post_start has no unskipped commands
   * - replace_ct is never skipped
   */
  private applyLookaheadSkipping(commands: ICommand[]): void {
    const hasUnskipped = (category: string): boolean =>
      commands.some(
        (c) => c.category === category && !c.name.includes("(skipped)"),
      );

    if (!hasUnskipped("pre_start")) {
      this.skipCommandsByCategory(commands, "create_ct");
    }
    if (!hasUnskipped("post_start")) {
      this.skipCommandsByCategory(commands, "start");
    }
  }

  private skipCommandsByCategory(
    commands: ICommand[],
    category: string,
  ): void {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      if (cmd.category === category && !cmd.name.includes("(skipped)")) {
        commands[i] = {
          name: `${cmd.name} (skipped)`,
          command: "exit 0",
          description: "Skipped by look-ahead: no unskipped templates in downstream category",
          ...(cmd.execute_on ? { execute_on: cmd.execute_on } : {}),
          category: cmd.category,
        };
      }
    }
  }

  async getUnresolvedParameters(
    application: string,
    task: TaskType,
    veContext?: IVEContext,
  ): Promise<IParameter[]> {
    const loaded = await this.loadApplication(
      application,
      task,
      veContext,
      undefined,
      undefined,
      true,
    );
    if (loaded.parameterTrace && loaded.parameterTrace.length > 0) {
      const traceById = new Map(
        loaded.parameterTrace.map((entry) => [entry.id, entry]),
      );
      return loaded.parameters.filter((param) => {
        if (param.type === "enum") return true;
        const trace = traceById.get(param.id);
        // Include parameters that are missing OR have only a default value
        // (both should be shown as editable in the UI)
        return trace
          ? trace.source === "missing" || trace.source === "default"
          : true;
      });
    }

    // Fallback: Only parameters whose id is not in resolvedParams.param
    return loaded.parameters.filter(
      (param) =>
        undefined ==
        loaded.resolvedParams.find(
          (rp) => rp.id == param.id && rp.template != param.template,
        ),
    );
  }

  async getParameters(
    application: string,
    task: TaskType,
    veContext?: IVEContext,
  ): Promise<IParameter[]> {
    const loaded = await this.loadApplication(application, task, veContext);
    return loaded.parameters;
  }

  async warmupEnumValuesForVeContext(
    veContext: IVEContext,
    enumTemplates: string[],
    executionMode?: ExecutionMode,
  ): Promise<void> {
    if (!veContext || enumTemplates.length === 0) return;
    const pm = PersistenceManager.getInstance();
    const allApps = pm.getApplicationService().getAllAppNames();
    const appId = allApps.keys().next().value as string | undefined;
    if (!appId) return;

    const errors: IJsonError[] = [];
    const tasks = Array.from(new Set(enumTemplates)).map(
      async (enumTemplate) => {
        try {
          const resolved = this.resolver.resolveTemplate(appId, enumTemplate, "list");
          const executeOn = resolved?.template?.execute_on;
          const opts: IProcessTemplateOpts = {
            application: appId,
            template: enumTemplate,
            templatename: enumTemplate,
            templateCategory: "list",
            resolvedParams: [],
            visitedTemplates: new Set<string>(),
            parameters: [],
            commands: [],
            errors,
            requestedIn: "enum-warmup",
            webuiTemplates: [],
            executionMode:
              executionMode !== undefined
                ? executionMode
                : determineExecutionMode(),
            veContext,
            ...(executeOn ? { enumValuesExecuteOn: typeof executeOn === "object" ? (executeOn as { where: string }).where : executeOn } : {}),
            processedTemplates: new Map(),
            templateReferences: new Map(),
            outputSources: new Map(),
          };
          await this.enumValuesResolver.resolveEnumValuesTemplate(
            enumTemplate,
            opts,
            (innerOpts) => this.#processTemplate(innerOpts),
            (message) => this.emit("message", message),
          );
        } catch {
          // Ignore warmup errors
        }
      },
    );
    await Promise.all(tasks);
  }
}
