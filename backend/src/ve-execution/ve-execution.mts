import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage, IJsonError } from "../types.mjs";
import { IVEContext, IVMContext } from "../backend-types.mjs";
import { VariableResolver } from "../variable-resolver.mjs";
import { OutputProcessor } from "../output-processor.mjs";
import { JsonError } from "../jsonvalidator.mjs";
import { createLogger } from "../logger/index.mjs";
import {
  IProxmoxRunResult,
  IRestartInfo,
  IOutput,
  VeExecutionConstants,
  getNextMessageIndex,
  resetMessageIndex,
  ExecutionMode,
  determineExecutionMode,
} from "./ve-execution-constants.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";
import {
  VeExecutionSshExecutor,
  SshExecutorDependencies,
} from "./ve-execution-ssh-executor.mjs";
import { VeExecutionHostDiscovery } from "./ve-execution-host-discovery.mjs";
import { VeExecutionCommandProcessor } from "./ve-execution-command-processor.mjs";
import { VeExecutionStateManager } from "./ve-execution-state-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";

// Re-export for backward compatibility
export type { IOutput, IProxmoxRunResult, IRestartInfo };

/**
 * ProxmoxExecution: Executes a list of ICommand objects with variable substitution and remote/container execution.
 */
const logger = createLogger("ve-execution");

export class VeExecution extends EventEmitter {
  private commands!: ICommand[];
  private inputs!: Record<string, string | number | boolean>;
  public outputs: Map<string, string | number | boolean> = new Map();
  private outputsRaw?: { name: string; value: string | number | boolean }[];
  private scriptTimeoutMs: number;
  private variableResolver!: VariableResolver;
  private outputProcessor: OutputProcessor;
  private messageEmitter: VeExecutionMessageEmitter;
  private sshExecutor: VeExecutionSshExecutor;
  protected hostDiscovery: VeExecutionHostDiscovery;
  private commandProcessor!: VeExecutionCommandProcessor;
  private stateManager: VeExecutionStateManager;

  private executionMode: ExecutionMode;

  constructor(
    commands: ICommand[],
    inputs: { id: string; value: string | number | boolean }[],
    private veContext: IVEContext | null,
    private defaults: Map<string, string | number | boolean> = new Map(),
    protected sshCommand?: string, // Deprecated: use executionMode instead
    executionMode?: ExecutionMode, // New: preferred way to specify execution mode
  ) {
    super();
    this.commands = commands;
    this.inputs = {};
    for (const inp of inputs) {
      this.inputs[inp.id] = inp.value;
    }

    // Determine execution mode: prefer explicit executionMode, fallback to sshCommand, then auto-detect
    if (executionMode !== undefined) {
      this.executionMode = executionMode;
    } else if (sshCommand !== undefined) {
      // Backward compatibility: derive from sshCommand
      this.executionMode =
        sshCommand === "ssh" ? ExecutionMode.PRODUCTION : ExecutionMode.TEST;
    } else {
      // Auto-detect from environment
      this.executionMode = determineExecutionMode();
    }

    // Derive sshCommand for backward compatibility
    if (!this.sshCommand) {
      this.sshCommand =
        this.executionMode === ExecutionMode.TEST ? "sh" : "ssh";
    }

    // Get timeout from environment variable, default to 2 minutes
    const envTimeout = process.env.LXC_MANAGER_SCRIPT_TIMEOUT;
    if (envTimeout) {
      const parsed = parseInt(envTimeout, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.scriptTimeoutMs = parsed * 1000; // Convert seconds to milliseconds
      } else {
        this.scriptTimeoutMs = VeExecutionConstants.DEFAULT_SCRIPT_TIMEOUT_MS;
      }
    } else {
      this.scriptTimeoutMs = VeExecutionConstants.DEFAULT_SCRIPT_TIMEOUT_MS;
    }

    // Initialize helper classes
    this.initializeVariableResolver();
    this.outputProcessor = new OutputProcessor(
      this.outputs,
      this.outputsRaw,
      this.defaults,
      this.executionMode,
    );
    this.messageEmitter = new VeExecutionMessageEmitter(this);
    this.sshExecutor = new VeExecutionSshExecutor({
      veContext: this.veContext,
      sshCommand: this.sshCommand,
      executionMode: this.executionMode,
      scriptTimeoutMs: this.scriptTimeoutMs,
      messageEmitter: this.messageEmitter,
      outputProcessor: this.outputProcessor,
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
    });
    this.hostDiscovery = this.createHostDiscovery();
    this.stateManager = new VeExecutionStateManager({
      outputs: this.outputs,
      outputsRaw: this.outputsRaw,
      inputs: this.inputs,
      defaults: this.defaults,
      veContext: this.veContext,
      initializeVariableResolver: () => this.initializeVariableResolver(),
    });
  }

  /**
   * Creates the host discovery instance. Can be overridden in tests to provide a mock.
   * @protected
   */
  protected createHostDiscovery(): VeExecutionHostDiscovery {
    return new VeExecutionHostDiscovery({
      sshExecutor: this.sshExecutor,
      outputs: this.outputs,
      variableResolver: this.variableResolver,
      runOnLxc: (vm_id, command, tmplCommand, timeoutMs?) =>
        this.runOnLxc(vm_id, command, tmplCommand, timeoutMs),
      getContextManager: () =>
        this.veContext ? (this.veContext.getStorageContext() as any) : null,
      getRepositories: () => this.resolveRepositories(),
    });
  }

  /**
   * Initializes or re-initializes the variable resolver with current state.
   */
  private initializeVariableResolver(): void {
    this.variableResolver = new VariableResolver(
      () => this.outputs,
      () => this.inputs,
      () => this.defaults,
    );
  }

  private resolveRepositories() {
    try {
      return PersistenceManager.getInstance().getRepositories();
    } catch {
      return null;
    }
  }

  /**
   * Load global VE libraries (ve-global.sh, ve-global.py) from the repository.
   * These are auto-injected into all execute_on:ve scripts.
   */
  private loadGlobalVeLibraries(): Map<string, string> {
    const libs = new Map<string, string>();
    const repos = this.resolveRepositories();
    if (!repos) return libs;

    for (const [lang, filename] of [["sh", "ve-global.sh"], ["py", "ve-global.py"]] as const) {
      const content = repos.getScript({
        name: filename,
        scope: "shared",
        category: "library",
      });
      if (content) libs.set(lang, content);
    }
    return libs;
  }

  /**
   * Updates helper modules with current state (called when state might have changed).
   */
  private updateHelperModules(): void {
    const deps: SshExecutorDependencies = {
      veContext: this.veContext,
      executionMode: this.executionMode,
      scriptTimeoutMs: this.scriptTimeoutMs,
      messageEmitter: this.messageEmitter,
      outputProcessor: this.outputProcessor,
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
    };
    // Only include sshCommand if explicitly set (for backward compatibility)
    if (this.sshCommand !== undefined) {
      deps.sshCommand = this.sshCommand;
    }
    this.sshExecutor = new VeExecutionSshExecutor(deps);
    this.hostDiscovery = new VeExecutionHostDiscovery({
      sshExecutor: this.sshExecutor,
      outputs: this.outputs,
      variableResolver: this.variableResolver,
      runOnLxc: (vm_id, cmd, tmplCmd, timeoutMs?) =>
        this.runOnLxc(vm_id, cmd, tmplCmd, timeoutMs),
      getContextManager: () =>
        this.veContext ? (this.veContext.getStorageContext() as any) : null,
      getRepositories: () => this.resolveRepositories(),
    });
    this.commandProcessor = new VeExecutionCommandProcessor({
      outputs: this.outputs,
      inputs: this.inputs,
      variableResolver: this.variableResolver,
      messageEmitter: this.messageEmitter,
      runOnLxc: (vm_id, cmd, tmplCmd, timeoutMs?) =>
        this.runOnLxc(vm_id, cmd, tmplCmd, timeoutMs),
      runOnVeHost: (input, cmd, timeout) =>
        this.runOnVeHost(input, cmd, timeout),
      executeOnHost: (hostname, cmd, tmplCmd) =>
        this.executeOnHost(hostname, cmd, tmplCmd),
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
      resolveApplicationToVmId: (appId) => this.resolveApplicationToVmId(appId),
      globalVeLibraries: this.loadGlobalVeLibraries(),
    });
    this.stateManager = new VeExecutionStateManager({
      outputs: this.outputs,
      outputsRaw: this.outputsRaw,
      inputs: this.inputs,
      defaults: this.defaults,
      veContext: this.veContext,
      initializeVariableResolver: () => this.initializeVariableResolver(),
    });
  }

  /**
   * Resolves an application_id to a vm_id by finding running containers with that app-id.
   * Uses find-containers-by-app-id.py which only checks status for matching containers.
   * @throws Error if 0 or 2+ running containers match the application_id
   */
  private async resolveApplicationToVmId(appId: string): Promise<number> {
    const repositories = this.resolveRepositories();
    if (!repositories) {
      throw new Error(
        "Cannot resolve application to vm_id: repositories not available",
      );
    }

    const scriptContent = repositories.getScript({
      name: "find-containers-by-app-id.py",
      scope: "shared",
      category: "root",
    });
    if (!scriptContent) {
      throw new Error("find-containers-by-app-id.py not found");
    }

    const libraryContent = repositories.getScript({
      name: "lxc_config_parser_lib.py",
      scope: "shared",
      category: "library",
    });
    if (!libraryContent) {
      throw new Error("lxc_config_parser_lib.py not found");
    }

    // Replace template variables in script
    const stackId = String(this.inputs["stack_id"] ?? this.outputs.get("stack_id") ?? this.defaults.get("stack_id") ?? "NOT_DEFINED");
    const scriptWithAppId = scriptContent
      .replace(/\{\{\s*application_id\s*\}\}/g, appId)
      .replace(/\{\{\s*stack_id\s*\}\}/g, stackId);

    const cmd: ICommand = {
      name: "Find Containers by App ID",
      execute_on: "ve",
      script: "find-containers-by-app-id.py",
      scriptContent: scriptWithAppId,
      libraryContent,
      outputs: ["containers"],
    };

    // Execute the script to get running containers with this app_id
    const ve = new VeExecution(
      [cmd],
      [],
      this.veContext,
      new Map(),
      undefined,
      this.executionMode,
    );
    await ve.run(null);

    const containersRaw = ve.outputs.get("containers");
    const containers: Array<{ vm_id: number; application_id?: string }> =
      typeof containersRaw === "string" && containersRaw.trim().length > 0
        ? JSON.parse(containersRaw)
        : [];

    // Script already filters by application_id and returns only running containers
    if (containers.length === 0) {
      throw new Error(
        `No running container found with application_id '${appId}'. Expected exactly 1 running container, found 0.`,
      );
    }
    if (containers.length > 1) {
      const vmIds = containers.map((c) => c.vm_id).join(", ");
      throw new Error(
        `Multiple running containers found with application_id '${appId}'. Expected exactly 1 running container, found ${containers.length} (vm_ids: ${vmIds}).`,
      );
    }

    return containers[0]!.vm_id;
  }

  /**
   * Internal method that actually executes the SSH command.
   * This can be overridden by tests, but the default implementation uses sshExecutor.
   */
  private async executeSshCommand(
    input: string,
    tmplCommand: ICommand,
    timeoutMs: number,
    uniqueMarker: string,
    interpreter?: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Marker will be added in runOnVeHost where we know the interpreter
    // For backward compatibility, we still accept uniqueMarker here but don't use it
    const executionArgs = this.sshExecutor.buildExecutionArgs(interpreter);

    return await this.sshExecutor.executeWithRetry(
      executionArgs,
      input, // Pass input without marker - marker will be added in runOnVeHost
      timeoutMs,
      tmplCommand,
      input,
      interpreter,
      uniqueMarker, // Pass marker separately
    );
  }

  /**
   * Executes a command on the Proxmox host via SSH, with timeout. Parses stdout as JSON and updates outputs.
   * @param input The command to execute
   * @param tmplCommand The template command
   * @param timeoutMs Timeout in milliseconds (defaults to scriptTimeoutMs if not provided)
   */
  protected async runOnVeHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs?: number,
  ): Promise<IVeExecuteMessage> {
    const startedAt = process.hrtime.bigint();
    // Use provided timeout or fall back to scriptTimeoutMs
    const actualTimeout =
      timeoutMs !== undefined ? timeoutMs : this.scriptTimeoutMs;

    // Update sshExecutor for helper methods
    this.updateHelperModules();
    const uniqueMarker = this.sshExecutor.createUniqueMarker();

    // Extract interpreter from command if available (set by loadCommandContent from shebang)
    const interpreter = (tmplCommand as any)._interpreter;

    try {
      const { stdout, stderr, exitCode } = await this.executeSshCommand(
        input,
        tmplCommand,
        actualTimeout,
        uniqueMarker,
        interpreter,
      );

      const msg = this.sshExecutor.createMessageFromResult(
        input,
        tmplCommand,
        stdout,
        stderr,
        exitCode,
      );

      try {
        if (stdout.trim().length === 0) {
          const result = this.sshExecutor.handleEmptyOutput(
            msg,
            tmplCommand,
            exitCode,
            stderr,
            this,
          );
          if (result) return result;
        } else {
          // Parse and update outputs
          this.outputProcessor.parseAndUpdateOutputs(
            stdout,
            tmplCommand,
            uniqueMarker,
          );
          // Check if outputsRaw was updated
          const outputsRawResult = this.outputProcessor.getOutputsRawResult();
          if (outputsRawResult) {
            this.outputsRaw = outputsRawResult;
          }
        }
      } catch (e: any) {
        msg.index = getNextMessageIndex();
        if (e instanceof JsonError) {
          msg.error = e;
        } else {
          msg.error = new JsonError(e.message);
        }
        msg.exitCode = -1;
        msg.partial = false;
        this.emit("message", msg);
        // Non-fatal: log warning instead of aborting execution
        logger.warn("Output validation error", {
          command: tmplCommand.name,
          error: e.message,
          ...(e instanceof JsonError && e.details ? { details: e.details.map((d: IJsonError) => d.message) } : {}),
        });
      }
      if (exitCode !== 0) {
        throw new Error(
          `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
        );
      } else msg.index = getNextMessageIndex();
      msg.partial = false;
      this.emit("message", msg);
      return msg;
    } finally {
      if (process.env.CACHE_TRACE === "1") {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const templateName = String(tmplCommand?.name ?? "unknown");
        console.info(
          `[runOnVeHost] ${durationMs.toFixed(1)}ms template=${templateName}`,
        );
      }
    }
  }

  /**
   * Executes a command inside an LXC container via lxc-attach on the Proxmox host.
   * @param vm_id Container ID
   * @param command Command to execute
   * @param tmplCommand The template command
   * @param timeoutMs Timeout in ms (defaults to scriptTimeoutMs if not provided)
   */
  protected async runOnLxc(
    vm_id: string | number,
    command: string,
    tmplCommand: ICommand,
    execUid?: number,
    execGid?: number,
    timeoutMs?: number,
  ): Promise<IVeExecuteMessage> {
    // In test mode, lxc-attach is not needed - execute locally
    if (this.executionMode === ExecutionMode.TEST) {
      // Execute command locally (simulating LXC execution)
      return await this.runOnVeHost(command, tmplCommand, timeoutMs);
    }

    // Production: use lxc-attach with optional uid/gid
    const lxcCmd = ["lxc-attach", "-n", String(vm_id)];
    if (execUid !== undefined && !isNaN(execUid)) lxcCmd.push("--uid", String(execUid));
    if (execGid !== undefined && !isNaN(execGid)) lxcCmd.push("--gid", String(execGid));
    lxcCmd.push("--");

    // In production mode, we need to execute via SSH with lxc-attach
    // But interpreter from shebang should still be respected
    const interpreter = (tmplCommand as any)._interpreter;

    // Build SSH command with lxc-attach and optional interpreter
    const actualTimeout =
      timeoutMs !== undefined ? timeoutMs : this.scriptTimeoutMs;
    this.updateHelperModules();
    const uniqueMarker = this.sshExecutor.createUniqueMarker();
    const inputWithMarker = `echo "${uniqueMarker}"\n${command}`;

    // For LXC execution in production, we need: ssh host lxc-attach -n vm_id -- interpreter < script
    // But since we're using stdin, we need to handle this differently
    // The lxcCmd already contains the "--" terminator; append interpreter after it.
    let finalLxcCmd = [...lxcCmd];
    if (interpreter) {
      finalLxcCmd.push(...interpreter);
    } else {
      finalLxcCmd.push("sh"); // Default to sh if no interpreter
    }

    const executionArgs = this.sshExecutor.buildExecutionArgs(finalLxcCmd);
    const { stdout, stderr, exitCode } =
      await this.sshExecutor.executeWithRetry(
        executionArgs,
        inputWithMarker,
        actualTimeout,
        tmplCommand,
        command,
        finalLxcCmd,
      );

    const msg = this.sshExecutor.createMessageFromResult(
      command,
      tmplCommand,
      stdout,
      stderr,
      exitCode,
    );

    try {
      if (stdout.trim().length === 0) {
        const result = this.sshExecutor.handleEmptyOutput(
          msg,
          tmplCommand,
          exitCode,
          stderr,
          this,
        );
        if (result) return result;
      } else {
        // Parse and update outputs
        this.outputProcessor.parseAndUpdateOutputs(
          stdout,
          tmplCommand,
          uniqueMarker,
        );
        const outputsRawResult = this.outputProcessor.getOutputsRawResult();
        if (outputsRawResult) {
          this.outputsRaw = outputsRawResult;
        }
      }
    } catch (e: any) {
      msg.index = getNextMessageIndex();
      if (e instanceof JsonError) {
        msg.error = e;
      } else {
        msg.error = new JsonError(e.message);
      }
      msg.exitCode = -1;
      msg.partial = false;
      this.emit("message", msg);
      // Non-fatal: log warning instead of aborting execution
      logger.warn("Output validation error", {
          command: tmplCommand.name,
          error: e.message,
          ...(e instanceof JsonError && e.details ? { details: e.details.map((d: IJsonError) => d.message) } : {}),
        });
    }
    if (exitCode !== 0) {
      throw new Error(
        `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
      );
    } else msg.index = getNextMessageIndex();
    msg.partial = false;
    this.emit("message", msg);
    return msg;
  }

  /**
   * Executes host discovery flow: calls write-vmids-json.sh on VE host, parses used_vm_ids,
   * resolves VMContext by hostname, validates pve and vmid, then runs the provided command inside LXC.
   */
  protected async executeOnHost(
    hostname: string,
    command: string,
    tmplCommand: ICommand,
  ): Promise<void> {
    // Update helper modules in case state changed
    this.updateHelperModules();
    return await this.hostDiscovery.executeOnHost(
      hostname,
      command,
      tmplCommand,
      this,
    );
  }

  /**
   * Runs all commands, replacing variables from inputs/outputs, and executes them on the correct target.
   * Returns the index of the last successfully executed command.
   */
  async run(
    restartInfo: IRestartInfo | null = null,
  ): Promise<IRestartInfo | undefined> {
    // Update all helper modules with current state
    this.updateHelperModules();

    let rcRestartInfo: IRestartInfo | undefined = undefined;
    const startIdx = this.stateManager.restoreStateFromRestartInfo(restartInfo);
    // Initialize msgIndex based on startIdx: each command (including skipped and properties) produces one message
    // This ensures properties commands get the correct index even after a restart
    // Note: We use msgIndex (not getNextMessageIndex) for properties commands to ensure consistency
    // Reset global message index to startIdx to keep it in sync with msgIndex
    if (restartInfo) {
      resetMessageIndex();
      // Set global message index to startIdx so getNextMessageIndex() returns correct values
      for (let j = 0; j < startIdx; j++) {
        getNextMessageIndex();
      }
    }
    let msgIndex = startIdx;
    outerloop: for (let i = startIdx; i < this.commands.length; ++i) {
      const cmd = this.commands[i];
      if (!cmd || typeof cmd !== "object") continue;

      // Update helper modules in case state changed during execution
      this.updateHelperModules();

      // Check if this command is part of a template with execute_on: "host:hostname"
      // If so, group all commands with the same hostname and execute them as a separate VeExecution instance
      // This check must happen BEFORE handling skipped commands, so we can group all template commands together
      const executeOn = cmd.execute_on;
      if (
        executeOn &&
        typeof executeOn === "string" &&
        /^host:.*/.test(executeOn)
      ) {
        const hostname = executeOn.split(":")[1] ?? "";

        // Collect all consecutive commands with the same execute_on: "host:hostname"
        // This includes skipped commands, as they are part of the template
        const templateCommands: ICommand[] = [];
        let j = i;
        while (j < this.commands.length) {
          const nextCmd = this.commands[j];
          if (!nextCmd || typeof nextCmd !== "object") break;
          if (nextCmd.execute_on === cmd.execute_on) {
            templateCommands.push(nextCmd);
            j++;
          } else {
            break;
          }
        }

        // Execute the template as a separate VeExecution instance
        try {
          await this.hostDiscovery.executeTemplateOnHost(
            hostname,
            templateCommands,
            this,
            this.veContext,
            this.sshCommand,
          );

          // Update message index and restart info
          msgIndex += templateCommands.length;
          rcRestartInfo = this.stateManager.buildRestartInfo(j - 1);

          // Skip past all commands that were executed
          i = j - 1; // Will be incremented by the for loop
          continue;
        } catch (err: any) {
          // Handle execution errors
          this.messageEmitter.emitErrorMessage(
            cmd,
            err,
            getNextMessageIndex(),
            hostname,
          );
          // Only set restartInfo if we've executed at least one command successfully
          if (i > startIdx) {
            rcRestartInfo = this.stateManager.buildRestartInfo(i - 1);
          }
          break outerloop;
        }
      }

      // Check if this is a skipped command (has "(skipped)" in name)
      // This is now AFTER the template check, so skipped commands within templates are handled by executeTemplateOnHost
      if (cmd.name && cmd.name.includes("(skipped)")) {
        msgIndex = this.commandProcessor.handleSkippedCommand(cmd, msgIndex);
        // Update restart info for skipped commands too
        // This ensures allSuccessful check passes when the last command is skipped
        rcRestartInfo = this.stateManager.buildRestartInfo(i);
        continue;
      }

      try {
        if (cmd.properties !== undefined) {
          // Handle properties: replace variables in values, set as outputs
          msgIndex = this.commandProcessor.handlePropertiesCommand(
            cmd,
            msgIndex,
          );
          // Build restart info for successful properties command
          // This ensures that if properties is the last command, allSuccessful check passes
          rcRestartInfo = this.stateManager.buildRestartInfo(i);
          continue; // Skip execution, only set properties
        }

        // Load command content
        const rawStr = this.commandProcessor.loadCommandContent(cmd);
        if (!rawStr) {
          // Update restart info even when skipping unknown command type
          rcRestartInfo = this.stateManager.buildRestartInfo(i);
          continue; // Skip unknown command type
        }

        // Resolve {{ }} markers inside base64-encoded inputs and outputs (e.g., compose_file)
        this.variableResolver.resolveBase64Inputs(this.inputs, this.outputs);

        // Execute command based on target
        let lastMsg: IVeExecuteMessage | undefined;
        try {
          lastMsg = await this.commandProcessor.executeCommandByTarget(
            cmd,
            rawStr,
          );
        } catch (err: any) {
          // Handle execution errors
          if (
            cmd.execute_on &&
            typeof cmd.execute_on === "string" &&
            /^host:.*/.test(cmd.execute_on)
          ) {
            const hostname = cmd.execute_on.split(":")[1] ?? "";
            this.messageEmitter.emitErrorMessage(
              cmd,
              err,
              getNextMessageIndex(),
              hostname,
            );
          } else {
            this.messageEmitter.emitErrorMessage(
              cmd,
              err,
              getNextMessageIndex(),
            );
          }
          // Only set restartInfo if we've executed at least one command successfully
          if (i > startIdx) {
            rcRestartInfo = this.stateManager.buildRestartInfo(i - 1);
          }
          break outerloop;
        }

        // Fallback: if no outputs were produced, try to parse echo JSON
        this.commandProcessor.parseFallbackOutputs(lastMsg);

        // Build restart info for successful execution
        rcRestartInfo = this.stateManager.buildRestartInfo(i);
      } catch (e) {
        // Handle any other errors
        this.messageEmitter.emitErrorMessage(cmd, e, getNextMessageIndex());
        // Set restartInfo even on error so restart is possible, but only if we've executed at least one command
        if (i > startIdx) {
          rcRestartInfo = this.stateManager.buildRestartInfo(i - 1);
        }
        break outerloop;
      }
    }
    // Check if all commands completed successfully
    const allSuccessful =
      rcRestartInfo !== undefined &&
      rcRestartInfo.lastSuccessfull === this.commands.length - 1;

    if (allSuccessful) {
      // Send a final success message with VMID if available
      const vmId = rcRestartInfo?.vm_id;
      const resultText = vmId
        ? `All commands completed successfully. Created container: ${vmId}`
        : "All commands completed successfully";

      const redirectUrl = this.outputs.get("redirect_url") as string | undefined;

      this.emit("message", {
        command: "Completed",
        execute_on: "ve",
        exitCode: 0,
        result: resultText,
        stderr: "",
        finished: true,
        index: getNextMessageIndex(),
        partial: false,
        vmId: vmId, // Include VMID in message for E2E tests
        redirectUrl: redirectUrl || undefined,
      } as IVeExecuteMessage);

      if (restartInfo == undefined) {
        this.emit("finished", this.buildVmContext());
      }
    } else {
      // Send a final failure message so CLI/polling clients stop waiting
      const vmId = rcRestartInfo?.vm_id;

      this.emit("message", {
        command: "Failed",
        execute_on: "ve",
        exitCode: 1,
        result: null,
        stderr: "Execution failed",
        finished: true,
        index: getNextMessageIndex(),
        partial: false,
        vmId: vmId,
      } as IVeExecuteMessage);
    }
    return rcRestartInfo;
  }

  buildVmContext(): IVMContext {
    // Update helper modules in case state changed
    this.updateHelperModules();
    return this.stateManager.buildVmContext();
  }

  /**
   * Replaces {{var}} in a string with values from inputs or outputs.
   * @internal For backward compatibility and testing
   */
  private replaceVars(str: string): string {
    return this.variableResolver.replaceVars(str);
  }

  /**
   * Replace variables using a provided context map first (e.g., vmctx.data),
   * then fall back to outputs, inputs, and defaults.
   * @internal For backward compatibility
   */
  protected replaceVarsWithContext(
    str: string,
    ctx: Record<string, any>,
  ): string {
    return this.variableResolver.replaceVarsWithContext(str, ctx);
  }
}
