import os from "os";
import {
  TaskType,
  IPostVeConfigurationBody,
  IVeExecuteMessagesResponse,
  IJsonError,
  ICommand,
  ITemplate,
  IParameter,
} from "@src/types.mjs";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import {
  IVEContext,
  IVMInstallContext,
} from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { getErrorStatusCode, serializeError } from "./webapp-error-utils.mjs";
import { VMInstallContext } from "@src/context-manager.mjs";
import {
  determineExecutionMode,
  ExecutionMode,
} from "@src/ve-execution/ve-execution-constants.mjs";

/**
 * Route handler logic for VE configuration endpoints.
 * Separated from Express binding for better testability.
 */
export class WebAppVeRouteHandlers {
  private pm: PersistenceManager;

  constructor(
    private messageManager: WebAppVeMessageManager,
    private restartManager: WebAppVeRestartManager,
    private parameterProcessor: WebAppVeParameterProcessor,
    private executionSetup: WebAppVeExecutionSetup,
  ) {
    this.pm = PersistenceManager.getInstance();
  }

  /**
   * Builds a standardized error result object for handler methods.
   */
  private buildErrorResult(err: unknown): {
    success: false;
    error: string;
    errorDetails?: IJsonError;
    statusCode: number;
  } {
    const serialized = serializeError(err);
    const result: {
      success: false;
      error: string;
      errorDetails?: IJsonError;
      statusCode: number;
    } = {
      success: false,
      error:
        typeof serialized === "string"
          ? serialized
          : serialized.message || "Unknown error",
      statusCode: getErrorStatusCode(err),
    };
    if (typeof serialized === "object") {
      result.errorDetails = serialized;
    }
    return result;
  }

  /**
   * Validates request body for VeConfiguration endpoint.
   */
  validateVeConfigurationBody(body: IPostVeConfigurationBody): {
    valid: boolean;
    error?: string;
  } {
    if (!Array.isArray(body.params)) {
      return { valid: false, error: "Invalid parameters" };
    }
    if (body.outputs !== undefined && !Array.isArray(body.outputs)) {
      return { valid: false, error: "Invalid outputs" };
    }
    if (
      body.changedParams !== undefined &&
      !Array.isArray(body.changedParams)
    ) {
      return { valid: false, error: "Invalid changedParams" };
    }
    if (
      body.selectedAddons !== undefined &&
      !Array.isArray(body.selectedAddons)
    ) {
      return { valid: false, error: "Invalid selectedAddons" };
    }
    if (
      body.disabledAddons !== undefined &&
      !Array.isArray(body.disabledAddons)
    ) {
      return { valid: false, error: "Invalid disabledAddons" };
    }
    return { valid: true };
  }

  /**
   * Handles POST /api/ve-configuration/:application/:task/:veContext
   */
  async handleVeConfiguration(
    application: string,
    task: string,
    veContextKey: string,
    body: IPostVeConfigurationBody,
  ): Promise<{
    success: boolean;
    restartKey?: string;
    vmInstallKey?: string;
    error?: string;
    errorDetails?: IJsonError;
    statusCode?: number;
  }> {
    // Validate request body
    const validation = this.validateVeConfigurationBody(body);
    if (!validation.valid) {
      return {
        success: false,
        ...(validation.error && { error: validation.error }),
        statusCode: 400,
      };
    }

    try {
      // Load application (provides commands)
      const storageContext =
        this.pm.getContextManager();
      const ctx: IVEContext | null =
        storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return {
          success: false,
          error: "VE context not found",
          statusCode: 404,
        };
      }
      const veCtxToUse: IVEContext = ctx as IVEContext;
      const templateProcessor = veCtxToUse
        .getStorageContext()
        .getTemplateProcessor();

      // Determine execution mode: TEST executes locally, PRODUCTION executes via SSH to VE host.
      const executionMode = determineExecutionMode();
      const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";

      // Use changedParams if provided (even if empty), otherwise fall back to params
      // This allows restarting installation with only changed parameters
      // For normal installation, changedParams should contain all changed parameters
      const paramsToUse =
        body.changedParams !== undefined ? body.changedParams : body.params;

      // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
      // Must use body.params (all parameters), not paramsToUse (changedParams only),
      // because skip_if_all_missing needs to see all provided parameters, not just changed ones.
      const initialInputs = body.params
        .filter(
          (p) => p.value !== null && p.value !== undefined && p.value !== "",
        )
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      const loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        executionMode,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
      );
      let commands = loaded.commands;
      if (!commands || commands.length === 0) {
        return {
          success: false,
          error: "No commands to execute for this task",
          statusCode: 422,
        };
      }

      // Insert addon templates at correct positions for each phase
      const selectedAddons = body.selectedAddons ?? [];
      const disabledAddons = body.disabledAddons ?? [];
      console.log(
        `[AddonDebug] handleVeConfiguration: task=${task}, selectedAddons=${JSON.stringify(selectedAddons)}, disabledAddons=${JSON.stringify(disabledAddons)}`,
      );
      if (selectedAddons.length > 0) {
        console.log(
          `[AddonDebug] Before insertAddonCommands: ${commands.length} commands`,
        );
        commands = await this.insertAddonCommands(
          commands,
          selectedAddons,
          task as TaskType,
        );
        console.log(
          `[AddonDebug] After insertAddonCommands: ${commands.length} commands`,
        );
      }
      if (disabledAddons.length > 0) {
        console.log(
          `[AddonDebug] Before insertAddonDisableCommands: ${commands.length} commands`,
        );
        commands = await this.insertAddonDisableCommands(
          commands,
          disabledAddons,
        );
        console.log(
          `[AddonDebug] After insertAddonDisableCommands: ${commands.length} commands`,
        );
      }

      const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

      // Load stack entries if stackId is provided
      const stackId = body.stackId;
      if (stackId) {
        const stack = storageContext.getStack(stackId);
        if (stack && stack.entries) {
          for (const entry of stack.entries) {
            defaults.set(entry.name, entry.value);
          }
        }
      }

      // Built-in context variables (available to scripts as {{ application_id }}, etc.)
      // Do not require any template parameters.
      defaults.set("application", application);
      defaults.set("application_id", application);
      defaults.set(
        "application_name",
        loaded.application &&
          typeof (loaded.application as any).name === "string"
          ? String((loaded.application as any).name)
          : application,
      );
      defaults.set("task", task);
      defaults.set("task_type", task);

      // Log viewer URL parameters for Notes links
      // Priority: OCI_LXC_DEPLOYER_URL env var > auto-generated from hostname + port
      const deployerPort = process.env.DEPLOYER_PORT || process.env.PORT || "3080";
      const deployerUrl =
        process.env.OCI_LXC_DEPLOYER_URL ||
        `http://${os.hostname()}:${deployerPort}`;
      defaults.set("deployer_base_url", deployerUrl);
      defaults.set("ve_context_key", veContextKey);

      // Icon data for embedding in notes (Data URL avoids mixed content issues)
      // Always use readApplicationIcon() which normalizes SVG size for notes display
      const iconData =
        this.pm
          .getApplicationService()
          .readApplicationIcon(application);
      if (iconData) {
        defaults.set("icon_base64", iconData.iconContent);
        defaults.set("icon_mime_type", iconData.iconType);
      }

      // Store selected addon IDs for notes update (comma-separated for shell script)
      if (selectedAddons.length > 0) {
        defaults.set("selected_addons", selectedAddons.join(","));
      }

      const contextManager =
        this.pm.getContextManager();
      // Process parameters: for upload parameters with "local:" prefix, read file and base64 encode
      const processedParams = await this.parameterProcessor.processParameters(
        paramsToUse,
        loaded.parameters,
        contextManager,
      );

      // Merge addon certtype parameters into the parameter list for cert injection
      let allCertParameters: IParameter[] = [...loaded.parameters];
      if (selectedAddons.length > 0) {
        const addonService = this.pm.getAddonService();
        for (const addonId of selectedAddons) {
          try {
            const addon = addonService.getAddon(addonId);
            if (addon.parameters) {
              allCertParameters.push(
                ...addon.parameters.filter(p => p.certtype && p.upload),
              );
            }
          } catch { /* addon not found, skip */ }
        }
      }

      // Auto-generate certificate parameters for certtype params without user upload
      this.injectCertificateRequests(processedParams, allCertParameters, contextManager, veContextKey);

      // Start ProxmoxExecution
      const inputs = processedParams.map((p) => ({
        id: p.id,
        value: p.value,
      }));

      const { exec, restartKey } = this.executionSetup.setupExecution(
        commands,
        inputs,
        defaults,
        veCtxToUse,
        this.messageManager,
        this.restartManager,
        application,
        task,
        sshCommand,
      );

      // Respond immediately with restartKey, run execution in background
      const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(
        body.params,
      );
      this.executionSetup.setupExecutionResultHandlers(
        exec,
        restartKey,
        this.restartManager,
        fallbackRestartInfo,
      );

      return {
        success: true,
        restartKey,
      };
    } catch (err: any) {
      return this.buildErrorResult(err);
    }
  }

  /**
   * Handles GET /api/ve/execute/:veContext
   */
  handleGetMessages(veContext: IVEContext): IVeExecuteMessagesResponse {
    // Add vmInstallKey to each message group if it exists
    const messages = this.messageManager.messages.map((group) => {
      // If vmInstallKey is already set, keep it
      if (group.vmInstallKey) {
        return group;
      }
      // Try to find vmInstallContext by looking up VE contexts
      const contextManager =
        this.pm.getContextManager();

      const vmInstallContext =
        contextManager.getVMInstallContextByHostnameAndApplication(
          veContext.host,
          group.application,
        );
      if (vmInstallContext) {
        const vmInstallKey = `vminstall_${veContext.host}_${group.application}`;
        // Update the group with vmInstallKey
        group.vmInstallKey = vmInstallKey;
      }

      return group;
    });
    return messages;
  }

  /**
   * Handles POST /api/ve/restart/:restartKey/:veContext
   */
  async handleVeRestart(
    restartKey: string,
    veContextKey: string,
  ): Promise<{
    success: boolean;
    restartKey?: string;
    vmInstallKey?: string;
    error?: string;
    errorDetails?: IJsonError;
    statusCode?: number;
  }> {
    const restartInfo = this.restartManager.getRestartInfo(restartKey);
    if (!restartInfo) {
      return {
        success: false,
        error: "Restart info not found",
        statusCode: 404,
      };
    }

    const contextManager = this.pm.getContextManager();
    const ctx = contextManager.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get application/task from the message group that has this restartKey
    const messageGroup =
      this.messageManager.findMessageGroupByRestartKey(restartKey);
    if (!messageGroup) {
      return {
        success: false,
        error: "No message group found for this restart key",
        statusCode: 404,
      };
    }

    const { application, task } = messageGroup;
    const veCtxToUse = ctx as IVEContext;

    const executionMode = determineExecutionMode();
    const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";

    // Reload application to get commands
    const templateProcessor = veCtxToUse
      .getStorageContext()
      .getTemplateProcessor();
    let loaded;
    try {
      // Use parameters from restartInfo.inputs for skip_if_all_missing checks
      const initialInputs = restartInfo.inputs
        .filter(
          (p) => p.value !== null && p.value !== undefined && p.value !== "",
        )
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        executionMode,
        initialInputs,
      );
    } catch (err: any) {
      return this.buildErrorResult(err);
    }
    const commands = loaded.commands;
    const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

    // Process parameters from restartInfo.inputs
    const paramsFromRestartInfo = restartInfo.inputs.map((p) => ({
      name: p.name,
      value: p.value,
    }));

    const processedParams = await this.parameterProcessor.processParameters(
      paramsFromRestartInfo,
      loaded.parameters,
      this.pm.getContextManager(),
    );

    const inputs = processedParams.map((p) => ({
      id: p.id,
      value: p.value,
    }));

    // Create execution with reloaded commands but use restartInfo for state
    const { exec, restartKey: newRestartKey } =
      this.executionSetup.setupExecution(
        commands,
        inputs,
        defaults,
        veCtxToUse,
        this.messageManager,
        this.restartManager,
        application,
        task,
        sshCommand,
      );

    this.executionSetup.setupRestartExecutionResultHandlers(
      exec,
      newRestartKey,
      restartInfo,
      this.restartManager,
    );

    // Try to find vmInstallContext for this installation to return vmInstallKey
    const hostname =
      typeof veCtxToUse.host === "string"
        ? veCtxToUse.host
        : (veCtxToUse.host as any)?.host || "unknown";
    const vmInstallContext =
      contextManager.getVMInstallContextByHostnameAndApplication(
        hostname,
        application,
      );
    const vmInstallKey = vmInstallContext
      ? `vminstall_${hostname}_${application}`
      : undefined;

    return {
      success: true,
      restartKey: newRestartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }

  /**
   * Handles POST /api/ve/restart-installation/:vmInstallKey/:veContext
   * Restarts an installation from scratch using the vmInstallContext.
   */
  async handleVeRestartInstallation(
    vmInstallKey: string,
    veContextKey: string,
  ): Promise<{
    success: boolean;
    restartKey?: string;
    vmInstallKey?: string;
    error?: string;
    errorDetails?: IJsonError;
    statusCode?: number;
  }> {
    const contextManager = this.pm.getContextManager();
    const ctx = contextManager.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get vmInstallContext
    const vmInstallContextValue =
      contextManager.getVMInstallContextByVmInstallKey(vmInstallKey);
    if (
      !vmInstallContextValue ||
      !(vmInstallContextValue instanceof VMInstallContext)
    ) {
      return {
        success: false,
        error: "VM install context not found",
        statusCode: 404,
      };
    }

    const installCtx = vmInstallContextValue as IVMInstallContext;
    const veCtxToUse = ctx as IVEContext;
    const templateProcessor = veCtxToUse
      .getStorageContext()
      .getTemplateProcessor();

    const executionMode = determineExecutionMode();
    const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";

    // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
    const initialInputs = installCtx.changedParams
      .filter(
        (p) => p.value !== null && p.value !== undefined && p.value !== "",
      )
      .map((p) => ({
        id: p.name,
        value: p.value,
      }));

    // Load application to get commands (with initialInputs for skip_if_all_missing checks)
    let loaded;
    try {
      loaded = await templateProcessor.loadApplication(
        installCtx.application,
        installCtx.task,
        veCtxToUse,
        executionMode,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
      );
    } catch (err: any) {
      return this.buildErrorResult(err);
    }
    const commands = loaded.commands;
    const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

    // Use changedParams from vmInstallContext as inputs
    const processedParams = await this.parameterProcessor.processParameters(
      installCtx.changedParams,
      loaded.parameters,
      this.pm.getContextManager(),
    );

    const inputs = processedParams.map((p) => ({
      id: p.id,
      value: p.value,
    }));

    const { exec, restartKey } = this.executionSetup.setupExecution(
      commands,
      inputs,
      defaults,
      veCtxToUse,
      this.messageManager,
      this.restartManager,
      installCtx.application,
      installCtx.task,
      sshCommand,
    );

    // Respond immediately with restartKey, run execution in background
    const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(
      installCtx.changedParams,
    );
    this.executionSetup.setupExecutionResultHandlers(
      exec,
      restartKey,
      this.restartManager,
      fallbackRestartInfo,
    );

    // Set vmInstallKey in message group if it exists
    if (vmInstallKey) {
      this.messageManager.setVmInstallKeyForGroup(
        installCtx.application,
        installCtx.task,
        vmInstallKey,
      );
    }

    return {
      success: true,
      restartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }

  /**
   * Maps task types to addon configuration keys.
   */
  private getAddonKeyForTask(
    task: TaskType,
  ): "installation" | "reconfigure" | "upgrade" | null {
    switch (task) {
      case "installation":
        return "installation";
      case "addon-reconfigure":
        return "reconfigure";
      case "copy-upgrade":
        return "upgrade";
      default:
        return null;
    }
  }

  /**
   * Loads addon commands for a specific phase (pre_start or post_start).
   * Returns an array of ICommand objects ready for execution.
   */
  private async loadAddonCommandsForPhase(
    addonIds: string[],
    task: TaskType,
    phase: "pre_start" | "post_start",
  ): Promise<ICommand[]> {
    const addonKey = this.getAddonKeyForTask(task);
    if (!addonKey) {
      return [];
    }

    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();
    const commands: ICommand[] = [];

    for (const addonId of addonIds) {
      let addon;
      try {
        addon = addonService.getAddon(addonId);
      } catch {
        console.warn(`Addon not found: ${addonId}, skipping`);
        continue;
      }

      // Get templates for the phase from the appropriate addon key
      let templateRefs;
      if (addonKey === "upgrade") {
        // upgrade is flat (only has one phase)
        templateRefs = phase === "post_start" ? addon.upgrade : undefined;
      } else {
        // installation and reconfigure have nested structure
        const addonConfig = addon[addonKey];
        console.log(
          `[AddonDebug] addon=${addonId}, addonKey=${addonKey}, addonConfig=${JSON.stringify(addonConfig)}, phase=${phase}`,
        );
        templateRefs = addonConfig?.[phase];
      }

      console.log(
        `[AddonDebug] templateRefs for ${addonId}/${phase}: ${JSON.stringify(templateRefs)}`,
      );

      if (!templateRefs || templateRefs.length === 0) {
        console.log(`[AddonDebug] No templates for ${addonId}/${phase}, skipping`);
        continue;
      }

      // Add addon properties as commands first (only for pre_start to avoid duplicates)
      if (phase === "pre_start" && addon.properties && addon.properties.length > 0) {
        const propertiesCommand: ICommand = {
          name: `${addon.name} Properties`,
          properties: addon.properties.map((prop) => ({
            id: prop.id,
            value: prop.value as string | number | boolean,
          })),
        };
        commands.push(propertiesCommand);
      }

      // Load templates and build commands
      // Map phase to template category directory
      const categoryMap: Record<string, string> = {
        pre_start: "pre_start",
        post_start: "post_start",
      };
      const category = categoryMap[phase];

      for (const templateRef of templateRefs) {
        const templateName =
          typeof templateRef === "string" ? templateRef : templateRef.name;

        try {
          console.log(
            `[AddonDebug] Loading template: ${templateName}, category: ${category}`,
          );
          const template = repositories.getTemplate({
            name: templateName,
            scope: "shared",
            ...(category && { category }),
          }) as ITemplate | null;

          console.log(
            `[AddonDebug] Template ${templateName} found: ${!!template}, commands: ${template?.commands?.length ?? 0}`,
          );

          if (template && template.commands) {
            for (const cmd of template.commands) {
              const command: ICommand = { ...cmd };

              // Set command name from template name if missing (same logic as TemplateProcessor)
              if (!command.name || command.name.trim() === "") {
                command.name = template.name || templateName;
              }

              // Set execute_on from template if not on command
              if (!command.execute_on && template.execute_on) {
                command.execute_on = template.execute_on;
              }

              // Resolve script content (scripts are in same category subdirectory as templates)
              if (cmd.script && !cmd.scriptContent) {
                const scriptContent = repositories.getScript({
                  name: cmd.script,
                  scope: "shared",
                  ...(category && { category }),
                });
                if (scriptContent) {
                  command.scriptContent = scriptContent;
                }
              }

              // Resolve library content (libraries are in library/ subdirectory)
              if (cmd.library && !cmd.libraryContent) {
                const libraryContent = repositories.getScript({
                  name: cmd.library,
                  scope: "shared",
                  category: "library",
                });
                if (libraryContent) {
                  command.libraryContent = libraryContent;
                }
              }

              commands.push(command);
            }
          }
        } catch (e) {
          console.error(`Failed to load addon template ${templateName}:`, e);
        }
      }
    }

    return commands;
  }

  /**
   * Adds notes update commands for all selected addons.
   */
  private addAddonNotesCommands(
    commands: ICommand[],
    addonIds: string[],
  ): void {
    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();

    const notesUpdateScript = repositories.getScript({
      name: "host-update-lxc-notes-addon.py",
      scope: "shared",
    });
    const notesUpdateLibrary = repositories.getScript({
      name: "lxc_config_parser_lib.py",
      scope: "shared",
    });

    if (notesUpdateScript && notesUpdateLibrary) {
      for (const addonId of addonIds) {
        let addon;
        try {
          addon = addonService.getAddon(addonId);
        } catch {
          continue;
        }
        commands.push({
          name: `Update LXC Notes with Addon: ${addon.name}`,
          execute_on: "ve",
          script: "host-update-lxc-notes-addon.py",
          scriptContent: notesUpdateScript,
          libraryContent: notesUpdateLibrary,
          properties: [{ id: "addon_id", value: addonId }],
          outputs: ["success"],
        });
      }
    }
  }

  /**
   * Finds the insertion index for addon commands based on phase.
   * pre_start commands go BEFORE "Start LXC Container" (the start phase).
   * post_start commands go AFTER the last post_start command (at the end before completion).
   */
  private findAddonInsertionIndex(
    commands: ICommand[],
    phase: "pre_start" | "post_start",
  ): number {
    if (phase === "pre_start") {
      // Insert BEFORE "Start LXC Container" - this marks the start phase
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        if (!cmd) continue;
        const name = cmd.name || "";

        // Look for the start phase marker
        if (
          name.includes("Start LXC Container") ||
          name.includes("Start LXC") ||
          name === "Start LXC Container"
        ) {
          return i;
        }
      }
    }

    // For post_start, or if no start marker found: append at the end
    return commands.length;
  }

  /**
   * Inserts addon commands at the correct position for the given phase.
   */
  async insertAddonCommands(
    commands: ICommand[],
    addonIds: string[],
    task: TaskType,
  ): Promise<ICommand[]> {
    if (addonIds.length === 0) {
      return commands;
    }

    const result = [...commands];

    // Load and insert pre_start commands
    console.log(`[AddonDebug] insertAddonCommands: loading pre_start for task=${task}`);
    const preStartCommands = await this.loadAddonCommandsForPhase(
      addonIds,
      task,
      "pre_start",
    );
    console.log(`[AddonDebug] pre_start commands loaded: ${preStartCommands.length}`);
    if (preStartCommands.length > 0) {
      const preStartIndex = this.findAddonInsertionIndex(result, "pre_start");
      console.log(`[AddonDebug] Inserting ${preStartCommands.length} pre_start commands at index ${preStartIndex}`);
      result.splice(preStartIndex, 0, ...preStartCommands);
    }

    // Load and insert post_start commands
    console.log(`[AddonDebug] insertAddonCommands: loading post_start for task=${task}`);
    const postStartCommands = await this.loadAddonCommandsForPhase(
      addonIds,
      task,
      "post_start",
    );
    console.log(`[AddonDebug] post_start commands loaded: ${postStartCommands.length}`);
    if (postStartCommands.length > 0) {
      const postStartIndex = this.findAddonInsertionIndex(result, "post_start");
      console.log(`[AddonDebug] Inserting ${postStartCommands.length} post_start commands at index ${postStartIndex}`);
      result.splice(postStartIndex, 0, ...postStartCommands);
    }

    // Add notes update commands at the very end
    if (preStartCommands.length > 0 || postStartCommands.length > 0) {
      this.addAddonNotesCommands(result, addonIds);
    }

    return result;
  }

  /**
   * Inserts addon disable commands and notes removal commands for disabled addons.
   * Disable commands only use post_start phase (container is already running).
   */
  async insertAddonDisableCommands(
    commands: ICommand[],
    disabledAddonIds: string[],
  ): Promise<ICommand[]> {
    if (disabledAddonIds.length === 0) {
      return commands;
    }

    const result = [...commands];
    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();
    const disableCommands: ICommand[] = [];

    for (const addonId of disabledAddonIds) {
      let addon;
      try {
        addon = addonService.getAddon(addonId);
      } catch {
        console.warn(`Addon not found for disable: ${addonId}, skipping`);
        continue;
      }

      const templateRefs = addon.disable?.post_start;
      if (!templateRefs || templateRefs.length === 0) {
        console.log(`[AddonDebug] No disable templates for ${addonId}, skipping`);
        continue;
      }

      for (const templateRef of templateRefs) {
        const templateName =
          typeof templateRef === "string" ? templateRef : templateRef.name;

        try {
          const template = repositories.getTemplate({
            name: templateName,
            scope: "shared",
            category: "post_start",
          }) as ITemplate | null;

          if (template && template.commands) {
            for (const cmd of template.commands) {
              const command: ICommand = { ...cmd };

              if (!command.name || command.name.trim() === "") {
                command.name = template.name || templateName;
              }
              if (!command.execute_on && template.execute_on) {
                command.execute_on = template.execute_on;
              }
              if (cmd.script && !cmd.scriptContent) {
                const scriptContent = repositories.getScript({
                  name: cmd.script,
                  scope: "shared",
                  category: "post_start",
                });
                if (scriptContent) {
                  command.scriptContent = scriptContent;
                }
              }
              if (cmd.library && !cmd.libraryContent) {
                const libraryContent = repositories.getScript({
                  name: cmd.library,
                  scope: "shared",
                  category: "library",
                });
                if (libraryContent) {
                  command.libraryContent = libraryContent;
                }
              }

              disableCommands.push(command);
            }
          }
        } catch (e) {
          console.error(`Failed to load addon disable template ${templateName}:`, e);
        }
      }
    }

    // Append disable commands at end (post_start position)
    if (disableCommands.length > 0) {
      result.push(...disableCommands);
    }

    // Add notes removal commands for disabled addons
    this.addAddonNotesRemovalCommands(result, disabledAddonIds);

    return result;
  }

  /**
   * Adds notes removal commands for disabled addons.
   */
  private addAddonNotesRemovalCommands(
    commands: ICommand[],
    addonIds: string[],
  ): void {
    const pm = this.pm;
    const addonService = pm.getAddonService();
    const repositories = pm.getRepositories();

    const notesUpdateScript = repositories.getScript({
      name: "host-update-lxc-notes-addon.py",
      scope: "shared",
    });
    const notesUpdateLibrary = repositories.getScript({
      name: "lxc_config_parser_lib.py",
      scope: "shared",
    });

    if (notesUpdateScript && notesUpdateLibrary) {
      for (const addonId of addonIds) {
        let addon;
        try {
          addon = addonService.getAddon(addonId);
        } catch {
          continue;
        }
        commands.push({
          name: `Remove Addon from Notes: ${addon.name}`,
          execute_on: "ve",
          script: "host-update-lxc-notes-addon.py",
          scriptContent: notesUpdateScript,
          libraryContent: notesUpdateLibrary,
          properties: [
            { id: "addon_id", value: addonId },
            { id: "addon_action", value: "remove" },
          ],
          outputs: ["success"],
        });
      }
    }
  }

  /**
   * Injects cert_requests, ca_key_b64, ca_cert_b64 into processedParams
   * when certtype parameters exist and user didn't upload their own certs.
   */
  private injectCertificateRequests(
    processedParams: Array<{ id: string; value: string | number | boolean }>,
    loadedParameters: IParameter[],
    contextManager: import("@src/context-manager.mjs").ContextManager,
    veContextKey: string,
  ): void {
    // SSL is enabled whenever certtype parameters are present (from SSL addon)
    const certParams = loadedParameters.filter((p) => p.certtype && p.upload);
    if (certParams.length === 0) return;

    const inputMap = new Map(processedParams.map((p) => [p.id, p.value]));
    const certLines: string[] = [];

    for (const param of certParams) {
      const userValue = inputMap.get(param.id);
      const hasValue = userValue && userValue !== "" && String(userValue) !== "NOT_DEFINED";
      if (hasValue) continue; // User uploaded own cert

      const volumeKey = this.resolveVolumeKeyForCert(param);
      certLines.push(`${param.id}|${param.certtype}|${volumeKey}`);
    }

    if (certLines.length > 0) {
      const caService = new CertificateAuthorityService(contextManager);
      const ca = caService.ensureCA(veContextKey);
      processedParams.push({ id: "cert_requests", value: certLines.join("\n") });
      processedParams.push({ id: "ca_key_b64", value: ca.key });
      processedParams.push({ id: "ca_cert_b64", value: ca.cert });
      processedParams.push({ id: "domain_suffix", value: caService.getDomainSuffix(veContextKey) });
    }
  }

  /**
   * Resolves the volume key for a cert parameter.
   * Looks at parameter ID pattern for volume hints, defaults to "secret".
   */
  private resolveVolumeKeyForCert(param: IParameter): string {
    // If param id contains a volume key hint (e.g. upload_certs_server_crt_content)
    // try to extract volume key from the id pattern
    const id = param.id || "";
    if (id.includes("certs")) return "certs";
    if (id.includes("secret")) return "secret";
    if (id.includes("ssl") || id.includes("tls")) return "certs";
    return "secret";
  }
}
