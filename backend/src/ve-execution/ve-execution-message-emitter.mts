import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage, IJsonError } from "../types.mjs";
import { JsonError } from "../jsonvalidator.mjs";

/**
 * Handles message emission for VeExecution.
 */
export class VeExecutionMessageEmitter {
  constructor(private eventEmitter: EventEmitter) {}

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
