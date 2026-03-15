import { ICommand, IVeExecuteMessage, IJsonError } from "../types.mjs";
import { IVEContext } from "../backend-types.mjs";
import { spawnAsync } from "../spawn-utils.mjs";
import { JsonError } from "../jsonvalidator.mjs";
import {
  VeExecutionConstants,
  getNextMessageIndex,
  ExecutionMode,
  determineExecutionMode,
} from "./ve-execution-constants.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";
import { OutputProcessor } from "../output-processor.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("execution");

export interface SshExecutorDependencies {
  veContext: IVEContext | null;
  sshCommand?: string; // Deprecated: use executionMode instead
  executionMode?: ExecutionMode; // New: preferred way to specify execution mode
  scriptTimeoutMs: number;
  messageEmitter: VeExecutionMessageEmitter;
  outputProcessor: OutputProcessor;
  outputsRaw: { name: string; value: string | number | boolean }[] | undefined;
  setOutputsRaw: (
    raw: { name: string; value: string | number | boolean }[],
  ) => void;
}

/**
 * Check if an interpreter array represents a shell (sh) interpreter.
 * Handles both direct interpreters (["sh"]) and lxc-attach wrapped interpreters
 * (["lxc-attach", "-n", "201", "--", "sh"]).
 */
function isShellInterpreter(interpreter?: string[]): boolean {
  if (!interpreter || interpreter.length === 0 || !interpreter[0]) return true;
  // For lxc-attach commands, check the interpreter after "--"
  if (interpreter[0] === "lxc-attach") {
    const sep = interpreter.indexOf("--");
    const inner = sep >= 0 ? interpreter[sep + 1] : undefined;
    return !inner || inner === "sh" || inner.endsWith("/sh");
  }
  return interpreter[0] === "sh" || interpreter[0].endsWith("/sh");
}

/**
 * Handles SSH/remote command execution for VeExecution.
 */
export class VeExecutionSshExecutor {
  private executionMode: ExecutionMode;
  private sshCommand: string; // Derived from executionMode for backward compatibility

  constructor(private deps: SshExecutorDependencies) {
    // Determine execution mode: prefer explicit executionMode, fallback to sshCommand, then auto-detect
    if (deps.executionMode !== undefined) {
      this.executionMode = deps.executionMode;
    } else if (deps.sshCommand !== undefined) {
      // Backward compatibility: derive from sshCommand
      this.executionMode =
        deps.sshCommand === "ssh"
          ? ExecutionMode.PRODUCTION
          : ExecutionMode.TEST;
    } else if (deps.veContext) {
      // If a VE context is present we almost certainly want to execute on the remote VE host.
      // This prevents running host-specific listing scripts (lsusb/lsblk/...) on the local dev machine.
      // Tests can still force local execution by passing executionMode=TEST.
      this.executionMode = ExecutionMode.PRODUCTION;
    } else {
      // Auto-detect from environment
      this.executionMode = determineExecutionMode();
    }
    // Derive sshCommand for backward compatibility
    this.sshCommand = this.executionMode === ExecutionMode.TEST ? "sh" : "ssh";
  }

  /**
   * Builds execution arguments based on execution mode.
   * In PRODUCTION mode: returns SSH arguments to connect to remote host.
   * In TEST mode: returns local interpreter command (or empty for stdin).
   * @param interpreter Optional interpreter command extracted from shebang (e.g., ["python3"])
   * @param verbose If true, enables verbose SSH output for debugging (no -q, LogLevel=DEBUG)
   */
  buildExecutionArgs(interpreter?: string[], verbose?: boolean): string[] {
    if (this.executionMode === ExecutionMode.PRODUCTION) {
      // Production: SSH to remote host
      if (!this.deps.veContext)
        throw new Error("VE context required for production mode");
      let host = this.deps.veContext.host;
      // Ensure root user is used when no user is specified
      if (typeof host === "string" && !host.includes("@")) {
        host = `root@${host}`;
      }
      const port = this.deps.veContext.port || 22;
      const sshArgs = [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes", // non-interactive: fail if auth requires password
        "-o",
        "PasswordAuthentication=no", // prevent password prompt
        "-o",
        "PreferredAuthentications=publickey", // try keys only
        "-o",
        verbose ? "LogLevel=DEBUG" : "LogLevel=ERROR", // verbose mode shows SSH diagnostics
        "-o",
        "ConnectTimeout=5", // fail fast on unreachable hosts
        "-o",
        "ControlMaster=auto", // reuse SSH connections
        "-o",
        "ControlPersist=60", // keep master connection alive
        "-o",
        "ControlPath=/tmp/lxc-manager-ssh-%r@%h:%p", // shared control socket
        "-o",
        "ServerAliveInterval=30", // send keepalive every 30s
        "-o",
        "ServerAliveCountMax=3", // fail after 3 missed keepalives
        "-T", // disable pseudo-tty to avoid MOTD banners
      ];
      // Only suppress output in non-verbose mode
      if (!verbose) {
        sshArgs.push("-q");
      }
      sshArgs.push("-p", String(port), `${host}`);
      // Append interpreter if provided (e.g., ssh host python3)
      if (interpreter) {
        sshArgs.push(...interpreter);
      }
      return sshArgs;
    } else {
      // Test mode: execute locally
      // If interpreter specified (from shebang), use it directly
      // Otherwise return empty (will default to sh for stdin execution)
      return interpreter || [];
    }
  }

  /**
   * Builds SSH arguments for connecting to the VE host (backward compatibility).
   * @deprecated Use buildExecutionArgs instead
   */
  buildSshArgs(interpreter?: string[]): string[] {
    return this.buildExecutionArgs(interpreter);
  }

  /**
   * Creates a unique marker to identify where actual output starts (after SSH banners).
   */
  createUniqueMarker(): string {
    return (
      "LXC_MANAGER_JSON_START_MARKER_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2)
    );
  }

  /**
   * Executes a command with retry logic for connection errors.
   * @param executionArgs Arguments for execution (SSH args in production, interpreter args in test)
   * @param input Script content (without marker - marker will be added based on interpreter)
   * @param timeoutMs Timeout in milliseconds
   * @param tmplCommand Template command being executed
   * @param originalInput Original input string (for logging)
   * @param interpreter Optional interpreter extracted from shebang (for test mode)
   * @param uniqueMarker Marker to identify output start
   */
  async executeWithRetry(
    executionArgs: string[],
    input: string,
    timeoutMs: number,
    tmplCommand: ICommand,
    originalInput: string,
    interpreter?: string[],
    uniqueMarker?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    logger.debug("Starting SSH execution", {
      host: this.deps.veContext?.host,
      command: tmplCommand.name,
      timeoutMs,
      executionMode: this.executionMode,
      sshCommand:
        this.executionMode === ExecutionMode.PRODUCTION
          ? `ssh ${executionArgs.join(" ")}`
          : undefined,
    });

    // Build marker and determine command structure
    // Strategy: Use "echo 'MARKER' && interpreter" as shell command in TEST mode
    // The script content is passed via stdin, and interpreter will read it
    // This works for all interpreters (Python, Perl, shell, etc.)
    const marker = uniqueMarker || this.createUniqueMarker();
    const maxRetries = VeExecutionConstants.MAX_RETRIES;
    let proc;
    let retryCount = 0;

    // Determine actual command, args, and input to use
    let actualCommand: string;
    let actualArgs: string[];
    let actualInput: string;

    if (this.executionMode === ExecutionMode.PRODUCTION) {
      // Production: use ssh with executionArgs (which contains SSH args + optional interpreter)
      actualCommand = "ssh";
      // For production, prepend marker to script for shell scripts
      if (isShellInterpreter(interpreter)) {
        actualArgs = executionArgs;
        actualInput = `export LC_ALL=C LANG=C\necho "${marker}"\n${input}`;
      } else {
        // For non-shell interpreters in production, run interpreter via sh -c so we can export locale
        const baseArgs = this.buildExecutionArgs(undefined);
        const interpreterCmd = interpreter!.join(" ");
        actualArgs = [
          ...baseArgs,
          "sh",
          "-c",
          `echo "${marker}" && export LC_ALL=C LANG=C; ${interpreterCmd}`,
        ];
        actualInput = input;
      }
    } else {
      // Test mode: use sh -c with "echo 'MARKER' && interpreter" for non-shell interpreters
      if (isShellInterpreter(interpreter)) {
        // Shell script: just prepend echo marker
        actualCommand = "sh";
        actualArgs = [];
        actualInput = `echo "${marker}"\n${input}`;
      } else {
        // For non-shell interpreters: use sh -c with "echo 'MARKER' && interpreter"
        // The script content goes via stdin to this command
        // Format: sh -c 'echo "MARKER" && python3' < script.py
        const interpreterCmd = interpreter!.join(" ");
        actualCommand = "sh";
        actualArgs = ["-c", `echo "${marker}" && ${interpreterCmd}`];
        // Script content goes via stdin (separate from the -c argument)
        actualInput = input;
      }
    }

    while (retryCount < maxRetries) {
      proc = await spawnAsync(actualCommand, actualArgs, {
        timeout: timeoutMs,
        input: actualInput,
        onStdout: (chunk: string) => {
          // Emit partial message for real-time output (especially useful for hanging scripts)
          this.deps.messageEmitter.emitPartialMessage(
            tmplCommand,
            originalInput,
            chunk,
            "",
          );
        },
        onStderr: (chunk: string) => {
          // Emit partial message for real-time error output
          this.deps.messageEmitter.emitPartialMessage(
            tmplCommand,
            originalInput,
            null,
            chunk,
          );
        },
      });

      // Exit 255 = SSH or lxc-attach connection issue, retry only for real SSH connections
      // In test environments, don't retry as there's no real network connection
      if (
        proc.exitCode === VeExecutionConstants.SSH_EXIT_CODE_CONNECTION_ERROR &&
        this.executionMode === ExecutionMode.PRODUCTION
      ) {
        retryCount++;
        if (retryCount < maxRetries) {
          // Log stderr from failed attempt if available
          if (proc.stderr && proc.stderr.trim()) {
            logger.warn("SSH connection failed - stderr output", {
              stderr: proc.stderr,
            });
          }

          logger.warn("SSH connection failed, retrying with verbose mode", {
            attempt: retryCount,
            maxRetries,
            delayMs: VeExecutionConstants.RETRY_DELAY_MS,
            host: this.deps.veContext?.host,
            command: tmplCommand.name,
          });

          // Rebuild args with verbose=true for retry (removes -q, sets LogLevel=DEBUG)
          const verboseArgs = this.buildExecutionArgs(interpreter, true);
          if (isShellInterpreter(interpreter)) {
            actualArgs = verboseArgs;
          } else {
            const interpreterCmd = interpreter!.join(" ");
            actualArgs = [
              ...this.buildExecutionArgs(undefined, true),
              "sh",
              "-c",
              `echo "${marker}" && export LC_ALL=C LANG=C; ${interpreterCmd}`,
            ];
          }

          // Log the full SSH command for debugging
          logger.debug("SSH retry command", {
            command: `ssh ${actualArgs.join(" ")}`,
          });

          await new Promise((resolve) =>
            setTimeout(resolve, VeExecutionConstants.RETRY_DELAY_MS),
          );
          continue;
        }
      }
      break;
    }

    logger.debug("SSH execution completed", {
      command: tmplCommand.name,
      exitCode: proc!.exitCode,
      hasStdout: !!proc!.stdout,
      stderrLength: proc!.stderr?.length || 0,
    });

    // Log error details if execution failed
    if (proc!.exitCode !== 0) {
      logger.warn("SSH command failed", {
        command: tmplCommand.name,
        exitCode: proc!.exitCode,
        stderr: proc!.stderr?.slice(0, 500), // Truncate for logging
        host: this.deps.veContext?.host,
      });
    }

    return {
      stdout: proc!.stdout || "",
      stderr: proc!.stderr || "",
      exitCode: proc!.exitCode,
    };
  }

  /**
   * Creates a message object from execution results.
   */
  createMessageFromResult(
    input: string,
    tmplCommand: ICommand,
    stdout: string,
    stderr: string,
    exitCode: number,
  ): IVeExecuteMessage {
    const message: IVeExecuteMessage = {
      stderr: structuredClone(stderr),
      commandtext: structuredClone(input),
      result: structuredClone(stdout),
      exitCode,
      command: structuredClone(tmplCommand.name),
    };
    if (tmplCommand.execute_on) {
      message.execute_on = structuredClone(tmplCommand.execute_on);
    }
    return message;
  }

  /**
   * Handles empty output case.
   */
  handleEmptyOutput(
    msg: IVeExecuteMessage,
    tmplCommand: ICommand,
    exitCode: number,
    stderr: string,
    eventEmitter: { emit: (event: string, data: any) => void },
  ): IVeExecuteMessage | null {
    msg.command = tmplCommand.name;
    msg.result = VeExecutionConstants.RESULT_OK;
    msg.exitCode = exitCode;
    if (exitCode === 0) {
      msg.result = VeExecutionConstants.RESULT_OK;
      msg.index = getNextMessageIndex();
      msg.partial = false;
      eventEmitter.emit("message", msg);
      return msg;
    } else {
      msg.result = VeExecutionConstants.RESULT_ERROR;
      msg.index = getNextMessageIndex();
      msg.stderr = stderr;
      msg.error = new JsonError(
        `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
      );
      msg.exitCode = exitCode;
      msg.command = tmplCommand.name;
      msg.partial = false;
      eventEmitter.emit("message", msg);
      return null;
    }
  }

  /**
   * Executes a command on the Proxmox host via SSH, with timeout. Parses stdout as JSON and updates outputs.
   * @param input The command to execute
   * @param tmplCommand The template command
   * @param timeoutMs Timeout in milliseconds (defaults to scriptTimeoutMs if not provided)
   * @param eventEmitter EventEmitter for emitting messages
   * @param interpreter Optional interpreter extracted from shebang (e.g., ["python3"])
   */
  async runOnVeHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs: number,
    eventEmitter: { emit: (event: string, data: any) => void },
    interpreter?: string[],
  ): Promise<IVeExecuteMessage> {
    const uniqueMarker = this.createUniqueMarker();
    const executionArgs = this.buildExecutionArgs(interpreter);

    const { stdout, stderr, exitCode } = await this.executeWithRetry(
      executionArgs,
      input,
      timeoutMs,
      tmplCommand,
      input,
      interpreter,
      uniqueMarker, // Pass marker to be added based on interpreter
    );

    const msg = this.createMessageFromResult(
      input,
      tmplCommand,
      stdout,
      stderr,
      exitCode,
    );

    try {
      if (stdout.trim().length === 0) {
        const result = this.handleEmptyOutput(
          msg,
          tmplCommand,
          exitCode,
          stderr,
          eventEmitter,
        );
        if (result) return result;
      } else {
        // Parse and update outputs
        this.deps.outputProcessor.parseAndUpdateOutputs(
          stdout,
          tmplCommand,
          uniqueMarker,
        );
        // Check if outputsRaw was updated
        const outputsRawResult =
          this.deps.outputProcessor.getOutputsRawResult();
        if (outputsRawResult) {
          this.deps.setOutputsRaw(outputsRawResult);
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
      eventEmitter.emit("message", msg);
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
    eventEmitter.emit("message", msg);
    return msg;
  }
}
