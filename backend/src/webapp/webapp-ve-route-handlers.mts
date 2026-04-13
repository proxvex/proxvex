import os from "os";
import {
  TaskType,
  ICommand,
  IPostVeConfigurationBody,
  IVeExecuteMessagesResponse,
  IJsonError,
  IParameter,
} from "@src/types.mjs";
import { CertificateAuthorityService } from "@src/services/certificate-authority-service.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { WebAppVeAddonCommandBuilder } from "./webapp-ve-addon-command-builder.mjs";
import { WebAppVeCertificateInjector } from "./webapp-ve-certificate-injector.mjs";
import {
  IVEContext,
  IVMInstallContext,
} from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { getErrorStatusCode, serializeError } from "./webapp-error-utils.mjs";
import { buildInfo } from "./webapp-version-routes.mjs";
import { VMInstallContext, type ContextManager } from "@src/context-manager.mjs";
import { createLogger } from "@src/logger/index.mjs";
import type { VeExecution } from "@src/ve-execution/ve-execution.mjs";
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
  private addonCommandBuilder: WebAppVeAddonCommandBuilder;
  private certificateInjector: WebAppVeCertificateInjector;
  private logger = createLogger("ve-route-handlers");

  constructor(
    private messageManager: WebAppVeMessageManager,
    private restartManager: WebAppVeRestartManager,
    private parameterProcessor: WebAppVeParameterProcessor,
    private executionSetup: WebAppVeExecutionSetup,
  ) {
    this.pm = PersistenceManager.getInstance();
    this.addonCommandBuilder = new WebAppVeAddonCommandBuilder();
    this.certificateInjector = new WebAppVeCertificateInjector();
  }

  /**
   * Builds a standardized error result object for handler methods.
   */
  /**
   * Collect provides_* outputs from a completed execution and store them in the stack.
   */
  private collectAndStoreProvides(
    exec: VeExecution,
    stackIds: string[],
    applicationId: string,
    storageContext: ContextManager,
  ): void {
    const provides: Array<{ name: string; value: string }> = [];
    for (const [key, value] of exec.outputs) {
      if (key.startsWith("provides_") && value !== undefined && value !== null && String(value) !== "NOT_DEFINED") {
        provides.push({
          name: key.replace(/^provides_/, "").toUpperCase(),
          value: String(value),
        });
      }
    }
    if (provides.length === 0 || stackIds.length === 0) return;

    const firstStackId = stackIds[0]!;
    const stack = storageContext.getStack(firstStackId);
    if (!stack) return;

    // Remove stale provides from this application (keys may have changed)
    const newNames = new Set(provides.map((p) => p.name));
    let existingProvides = (stack.provides ?? []).filter(
      (e) => e.application !== applicationId || newNames.has(e.name),
    );
    let changed = existingProvides.length !== (stack.provides ?? []).length;

    for (const p of provides) {
      const existing = existingProvides.find((e) => e.name === p.name);
      if (existing) {
        if (existing.value !== p.value) {
          this.logger.warn(`Stack provides changed: ${p.name} (${existing.value} → ${p.value})`, { application: applicationId, stack: firstStackId });
          existing.value = p.value;
          existing.application = applicationId;
          changed = true;
        }
      } else {
        existingProvides.push({ name: p.name, value: p.value, application: applicationId });
        changed = true;
      }
    }

    if (changed) {
      stack.provides = existingProvides;
      storageContext.set(`stack_${stack.id}`, stack);
      this.logger.info("Stack provides updated", { stack: firstStackId, provides: provides.map((p) => p.name) });
    }
  }

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
   * Handles POST /api/ve-configuration/:application/:veContext (task in body)
   */
  async handleVeConfiguration(
    application: string,
    task: string,
    veContextKey: string,
    body: IPostVeConfigurationBody,
    userAccessToken?: string,
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

      // Always use all params for execution — changedParams is only relevant for
      // the restart flow (separate code path). Using changedParams here would lose
      // unchanged preset values (e.g. previous_vm_id) that templates still need.
      const paramsToUse = body.params;

      // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
      // Must use body.params (all parameters), not paramsToUse (changedParams only),
      // because skip_if_all_missing needs to see all provided parameters, not just changed ones.
      const initialInputs: Array<{ id: string; value: string | number | boolean }> = body.params
        .filter(
          (p) => p.value !== null && p.value !== undefined && p.value !== "",
        )
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      // Pre-inject backend-generated values so skip_if_all_missing can see them
      // during template loading (before defaults are set post-load).
      // Collect all stack IDs (new array format + legacy single format)
      const allStackIds = [...(body.stackIds ?? [])];
      if (body.stackId && !allStackIds.includes(body.stackId)) {
        allStackIds.unshift(body.stackId);
      }

      // Add addon stacktypes to allStackIds so dependency resolution
      // can find containers in addon stacks (e.g. addon-oidc → zitadel in oidc_default)
      const addonStackIds = body.selectedAddons ?? [];
      if (addonStackIds.length > 0) {
        try {
          const addonSvc = this.pm.getAddonService();
          const storageContext = this.pm
            .getContextManager();
          for (const addonId of addonStackIds) {
            try {
              const addon = addonSvc.getAddon(addonId);
              if (addon?.stacktype) {
                const addonTypes = Array.isArray(addon.stacktype) ? addon.stacktype : [addon.stacktype];
                for (const st of addonTypes) {
                  // Find existing stacks of this type and add their IDs
                  const stacks = storageContext.listStacks(st);
                  for (const stack of stacks) {
                    if (!allStackIds.includes(stack.id)) {
                      allStackIds.push(stack.id);
                    }
                  }
                }
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }

      const firstStackId = allStackIds[0];
      if (firstStackId) {
        initialInputs.push({ id: "stack_id", value: firstStackId });
      }
      if (allStackIds.length > 0) {
        initialInputs.push({ id: "all_stack_ids", value: JSON.stringify(allStackIds) });
      }

      // Read application + addon dependencies for dependency-host-discovery
      let appConfig: any = null;
      try {
        appConfig = this.pm.getRepositories().getApplication(application);
        const appDeps = (appConfig as any)?.dependencies as { application: string }[] | undefined;
        const allDeps = [...(appDeps ?? [])];

        // Merge stacktype dependencies (e.g. postgres stacktype → postgres app)
        const appStacktype = (appConfig as any)?.stacktype;
        const stacktypes = appStacktype ? (Array.isArray(appStacktype) ? appStacktype : [appStacktype]) : [];
        if (stacktypes.length > 0) {
          const stacktypeData = this.pm.getStacktypes();
          for (const stName of stacktypes) {
            const st = stacktypeData.find((s: any) => s.name === stName);
            if (st?.dependencies) {
              for (const dep of st.dependencies) {
                if (dep.application !== application && !allDeps.some(d => d.application === dep.application)) {
                  allDeps.push(dep);
                }
              }
            }
          }
        }

        // Merge addon dependencies
        const addonIds = body.selectedAddons ?? [];
        if (addonIds.length > 0) {
          const addonSvc = this.pm.getAddonService();
          for (const addonId of addonIds) {
            try {
              const addon = addonSvc.getAddon(addonId);
              if (addon?.dependencies) {
                for (const dep of addon.dependencies) {
                  if (!allDeps.some(d => d.application === dep.application)) {
                    allDeps.push(dep);
                  }
                }
              }
            } catch { /* ignore unknown addon */ }
          }
        }

        if (allDeps.length > 0) {
          initialInputs.push({ id: "app_dependencies", value: JSON.stringify(allDeps) });
        }
      } catch {
        // Ignore - getApplication may fail for some apps
      }

      // Pre-inject ca_key_b64 marker so skip_if_all_missing in template 156
      // does not skip cert generation when addon-ssl is selected.
      // The actual CA key is injected later by certificateInjector.
      // Merge required_addons (always active, cannot be deselected by user)
      const appRequiredAddons = ((appConfig as any)?.required_addons ?? []) as string[];
      const allRequestedAddons = [...new Set([...(body.selectedAddons ?? []), ...appRequiredAddons])];
      if (allRequestedAddons.some((a: string) => a === "addon-ssl" || a === "addon-acme")) {
        if (!initialInputs.some(p => p.id === "ca_key_b64")) {
          initialInputs.push({ id: "ca_key_b64", value: "pending" });
        }
      }

      // For in-place upgrade/reconfigure without create_ct: vm_id = previouse_vm_id
      if (!initialInputs.some(p => p.id === "vm_id") && initialInputs.some(p => p.id === "previouse_vm_id")) {
        const prev = initialInputs.find(p => p.id === "previouse_vm_id");
        if (prev) {
          initialInputs.push({ id: "vm_id", value: prev.value });
        }
      }

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
      // For reconfigure with installedAddons: only inject changed addons (delta)
      const installedAddons = body.installedAddons ?? [];
      let selectedAddons = [...new Set([...(body.selectedAddons ?? []), ...appRequiredAddons])];
      let disabledAddons = body.disabledAddons ?? [];

      if (installedAddons.length > 0 && task === "reconfigure") {
        // Delta injection: separate addons into new, kept, and removed
        const installedSet = new Set(installedAddons);
        const selectedSet = new Set(selectedAddons);

        // New addons = selected but not installed
        const newAddons = selectedAddons.filter(a => !installedSet.has(a));
        // Kept addons = both installed and selected (reconfigure with full flow)
        const keptAddons = selectedAddons.filter(a => installedSet.has(a));
        // Removed addons = installed but not selected (merge with explicitly disabled)
        const removedAddons = installedAddons.filter(a => !selectedSet.has(a));
        disabledAddons = [...new Set([...disabledAddons, ...removedAddons])]
          .filter(a => !appRequiredAddons.includes(a)); // required_addons cannot be disabled
        // Inject templates for both new and kept addons
        selectedAddons = [...new Set([...newAddons, ...keptAddons, ...appRequiredAddons])];
      }

      if (selectedAddons.length > 0) {
        commands = await this.addonCommandBuilder.insertAddonCommands(
          commands,
          selectedAddons,
          task as TaskType,
          loaded.application,
        );
      }
      if (disabledAddons.length > 0) {
        commands = await this.addonCommandBuilder.insertAddonDisableCommands(
          commands,
          disabledAddons,
          loaded.application,
        );
      }

      const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

      // Load entries from all stacks (app + addon stacktypes)
      for (const sid of allStackIds) {
        const stack = storageContext.getStack(sid);
        if (stack) {
          if (!defaults.has("stack_id")) {
            defaults.set("stack_id", sid);
          }
          if (stack.entries) {
            for (const entry of stack.entries) {
              defaults.set(entry.name, entry.value);
            }
          }
          // Load provides as defaults (connection info from providers)
          if (stack.provides) {
            for (const p of stack.provides) {
              if (!defaults.has(p.name)) {
                defaults.set(p.name, p.value);
              }
            }
          }
        }
      }

      // Build stack_secret_names for compose template sanitization
      // Format: NAME=VALUE,NAME=VALUE (allows upload script to replace resolved values with {{ NAME }})
      {
        const secretPairs: string[] = [];
        for (const sid of allStackIds) {
          const stack = storageContext.getStack(sid);
          if (stack?.entries) {
            for (const entry of stack.entries) {
              if (entry.value !== undefined && entry.value !== "") {
                secretPairs.push(`${entry.name}=${entry.value}`);
              }
            }
          }
        }
        if (secretPairs.length > 0) {
          defaults.set("stack_secret_names", secretPairs.join(","));
        }
      }

      // Inject application + addon dependencies for dependency-host-discovery script
      {
        const appDependencies = (loaded.application as any)?.dependencies as { application: string }[] | undefined;
        const allDeps = [...(appDependencies ?? [])];
        // Merge stacktype dependencies
        const loadedStacktype = (loaded.application as any)?.stacktype;
        const loadedStacktypes = loadedStacktype ? (Array.isArray(loadedStacktype) ? loadedStacktype : [loadedStacktype]) : [];
        if (loadedStacktypes.length > 0) {
          const stacktypeData = this.pm.getStacktypes();
          for (const stName of loadedStacktypes) {
            const st = stacktypeData.find((s: any) => s.name === stName);
            if (st?.dependencies) {
              for (const dep of st.dependencies) {
                if (dep.application !== application && !allDeps.some(d => d.application === dep.application)) {
                  allDeps.push(dep);
                }
              }
            }
          }
        }
        if (selectedAddons.length > 0) {
          const addonSvc = this.pm.getAddonService();
          for (const addonId of selectedAddons) {
            try {
              const addon = addonSvc.getAddon(addonId);
              if (addon?.dependencies) {
                for (const dep of addon.dependencies) {
                  if (!allDeps.some(d => d.application === dep.application)) {
                    allDeps.push(dep);
                  }
                }
              }
            } catch { /* ignore */ }
          }
        }
        if (allDeps.length > 0) {
          defaults.set("app_dependencies", JSON.stringify(allDeps));
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

      // For in-place upgrade/reconfigure: vm_id = previouse_vm_id if not explicitly set
      if (!defaults.has("vm_id")) {
        const prevParam = paramsToUse.find(p => p.name === "previouse_vm_id");
        if (prevParam && prevParam.value !== undefined && prevParam.value !== "") {
          defaults.set("vm_id", String(prevParam.value));
        }
      }

      // Log viewer URL parameters for Notes links
      // Priority: OCI_LXC_DEPLOYER_URL env var > auto-generated from hostname + port
      const deployerPort = process.env.DEPLOYER_PORT || process.env.PORT || "3080";
      const deployerUrl =
        process.env.OCI_LXC_DEPLOYER_URL ||
        `http://${os.hostname()}:${deployerPort}`;
      defaults.set("deployer_base_url", deployerUrl);
      defaults.set("ve_context_key", veContextKey);

      // Extract OCI image tag from application properties (e.g., "postgres:16-alpine" → "16-alpine")
      // During fresh install, this is overwritten by the image download script output.
      // During reconfigure, image scripts don't run, so this default is used for notes.
      const ociImageProp = loaded.application?.properties?.find(
        (p: { id: string }) => p.id === "oci_image",
      );
      const ociImageValue = ociImageProp?.value ? String(ociImageProp.value) : "";
      const ociImageTag = ociImageValue.includes(":")
        ? ociImageValue.split(":").pop() ?? ""
        : ociImageValue;
      defaults.set("oci_image_tag", ociImageTag || buildInfo.version);

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

      // Mark deployer-instance for self-reconfigure support
      if (application === "oci-lxc-deployer") {
        defaults.set("is_deployer", "true");
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
                ...addon.parameters.filter(p => p.certtype),
              );
            }
          } catch { /* addon not found, skip */ }
        }
      }

      // Auto-generate certificate parameters for certtype params without user upload
      const caProvider = new CertificateAuthorityService(contextManager);
      this.certificateInjector.injectCertificateRequests(processedParams, allCertParameters, caProvider, veContextKey);

      // Start ProxmoxExecution
      const inputs = processedParams.map((p) => ({
        id: p.id,
        value: p.value,
      }));

      // Inject user's access token for OIDC addon scripts (delegated access)
      if (selectedAddons.includes("addon-oidc") && userAccessToken) {
        inputs.push({ id: "ZITADEL_PAT", value: userAccessToken });
        this.logger.info("[ve-route-handlers] Injected user access token for OIDC addon");
      }

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
        loaded.processedTemplates,
      );

      // Persist shared_volpath per VE context whenever it appears in outputs
      exec.on("finished", (msg: import("@src/backend-types.mjs").IVMContext) => {
        const sharedVolpath = msg.outputs?.shared_volpath;
        if (sharedVolpath && typeof sharedVolpath === "string") {
          const caService = new CertificateAuthorityService(storageContext);
          caService.setSharedVolpath(veContextKey, sharedVolpath);
        }
      });

      // Respond immediately with restartKey, run execution in background
      const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(
        body.params,
      );
      this.executionSetup.setupExecutionResultHandlers(
        exec,
        restartKey,
        this.restartManager,
        fallbackRestartInfo,
        // Collect provides_* outputs and write to stack after execution
        (completedExec) => {
          this.collectAndStoreProvides(completedExec, allStackIds, application, storageContext);
        },
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
  handleGetMessages(veContext: IVEContext, since?: number): IVeExecuteMessagesResponse {
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

    // Delta-polling: if since is provided, only return messages with index > since
    if (since !== undefined && !isNaN(since)) {
      return messages.map(group => ({
        ...group,
        messages: group.messages.filter(m => m.index !== undefined && m.index > since),
      }));
    }
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
        loaded.processedTemplates,
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
      loaded.processedTemplates,
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
}
