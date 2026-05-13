import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage, IJsonError } from "../types.mjs";
import { JsonError } from "../jsonvalidator.mjs";
import type { IVarSubstitution } from "../variable-resolver.mjs";

/**
 * Debug events emitted on the `"debug"` channel of the VeExecution
 * EventEmitter. Consumed by the DebugCollector to assemble the per-task
 * markdown bundle.
 */
export type IVeDebugEvent =
  | {
      type: "script-start";
      index: number;
      command: string;
      executeOn: string | undefined;
      template?: string;
      redactedScript: string;
      substitutions: IVarSubstitution[];
      ts: number;
    }
  | {
      type: "script-end";
      index: number;
      command: string;
      exitCode: number;
      ts: number;
    }
  | {
      type: "script-skipped";
      index: number;
      command: string;
      executeOn: string | undefined;
      template?: string;
      reason: string;
      ts: number;
    };

/**
 * Handles message emission for VeExecution.
 */
export class VeExecutionMessageEmitter {
  /**
   * Sequential script index. Owned by the emitter (which lives for the
   * entire VeExecution lifetime) rather than the command processor, because
   * `updateHelperModules` recreates the command processor on every state
   * change and a counter on the processor would reset to 1 each time.
   */
  private scriptCounter = 0;

  constructor(private eventEmitter: EventEmitter) {}

  /**
   * Emits a debug event recording that a script is about to execute. Carries
   * the redacted twin and the substitution list so the DebugCollector can
   * file the script into its bundle. Returns the assigned script index so
   * the caller can pair it with `emitDebugScriptEnd`.
   */
  emitDebugScriptStart(
    cmd: ICommand,
    redactedScript: string,
    substitutions: IVarSubstitution[],
  ): number {
    const index = ++this.scriptCounter;
    const sourceTemplate = (cmd as unknown as { _sourceTemplate?: string })
      ._sourceTemplate;
    const event: IVeDebugEvent = {
      type: "script-start",
      index,
      command: cmd.name ?? "",
      executeOn: typeof cmd.execute_on === "string" ? cmd.execute_on : undefined,
      ...(sourceTemplate ? { template: sourceTemplate } : {}),
      redactedScript,
      substitutions,
      ts: Date.now(),
    };
    this.eventEmitter.emit("debug", event);
    return index;
  }

  /**
   * Emits a debug event marking the end of a script execution window, used
   * by the DebugCollector to close the per-script trace bucket.
   */
  emitDebugScriptEnd(cmd: ICommand, index: number, exitCode: number): void {
    const event: IVeDebugEvent = {
      type: "script-end",
      index,
      command: cmd.name ?? "",
      exitCode,
      ts: Date.now(),
    };
    this.eventEmitter.emit("debug", event);
  }

  /**
   * Emits a debug event recording that a command was skipped because its
   * skip_if_all_missing condition matched. Shares the script counter with
   * real script-start events so skipped commands interleave in chronological
   * index order. Returns the assigned index for symmetry with `emitDebugScriptStart`.
   */
  emitDebugScriptSkipped(cmd: ICommand, reason: string): number {
    const index = ++this.scriptCounter;
    const sourceTemplate = (cmd as unknown as { _sourceTemplate?: string })
      ._sourceTemplate;
    const event: IVeDebugEvent = {
      type: "script-skipped",
      index,
      command: cmd.name ?? "",
      executeOn: typeof cmd.execute_on === "string" ? cmd.execute_on : undefined,
      ...(sourceTemplate ? { template: sourceTemplate } : {}),
      reason,
      ts: Date.now(),
    };
    this.eventEmitter.emit("debug", event);
    return index;
  }

  /**
   * Emits a partial message for streaming output.
   */
  emitPartialMessage(
    tmplCommand: ICommand,
    input: string,
    result: string | null,
    stderr: string,
  ): void {
    this.eventEmitter.emit("message", {
      command: tmplCommand.name || "streaming",
      commandtext: input,
      stderr,
      result,
      exitCode: -1, // Not finished yet
      execute_on: tmplCommand.execute_on || undefined,
      partial: true,
    } as IVeExecuteMessage);
  }

  /**
   * Creates and emits a standard message.
   */
  emitStandardMessage(
    cmd: ICommand,
    stderr: string,
    result: string | null,
    exitCode: number,
    index: number,
    hostname?: string,
    kind?: "skipped",
  ): void {
    const sourceTemplate = (cmd as unknown as { _sourceTemplate?: string })._sourceTemplate;
    this.eventEmitter.emit("message", {
      stderr,
      result,
      exitCode,
      command: cmd.name,
      execute_on: (cmd as any).execute_on || undefined,
      host: hostname,
      index,
      partial: false,
      ...(sourceTemplate ? { template: sourceTemplate } : {}),
      ...(kind ? { kind } : {}),
    } as unknown as IVeExecuteMessage);
  }

  /**
   * Emits an error message for a failed command.
   */
  emitErrorMessage(
    cmd: ICommand,
    error: any,
    msgIndex: number,
    hostname?: string,
  ): void {
    const msg = String(error?.message ?? error);
    // If error is a JsonError, preserve its details in the error field
    const errorObj: IJsonError | undefined =
      error instanceof JsonError ? error : undefined;
    const sourceTemplate = (cmd as unknown as { _sourceTemplate?: string })._sourceTemplate;
    this.eventEmitter.emit("message", {
      stderr: msg,
      result: null,
      exitCode: -1,
      command: cmd.name,
      execute_on: (cmd as any).execute_on || undefined,
      host: hostname,
      index: msgIndex,
      partial: false,
      error: errorObj,
      ...(sourceTemplate ? { template: sourceTemplate } : {}),
    } as IVeExecuteMessage);
  }
}
