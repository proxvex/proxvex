import type { IVeExecuteMessage } from "../types.mjs";
import type { CliApiClient } from "./cli-api-client.mjs";
import { TimeoutError, ExecutionFailedError } from "./cli-types.mjs";

export interface ProgressOptions {
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
  timeout: number;
}

export class CliProgress {
  private seenMessages = 0;
  private startTime = Date.now();

  constructor(
    private client: CliApiClient,
    private veContext: string,
    private options: ProgressOptions,
  ) {}

  async poll(): Promise<{ vmId?: number; success: boolean }> {
    const deadline = Date.now() + this.options.timeout * 1000;
    let retryCount = 0;
    const maxRetries = 3;

    while (Date.now() < deadline) {
      let messages: IVeExecuteMessage[];
      try {
        const response = await this.client.getExecuteMessages(this.veContext);
        // Response is array of ISingleExecuteMessagesResponse
        const latest = response[response.length - 1];
        messages = latest?.messages ?? [];
        retryCount = 0;
      } catch (err) {
        retryCount++;
        if (retryCount > maxRetries) throw err;
        await sleep(5000);
        continue;
      }

      // Process new messages
      for (let i = this.seenMessages; i < messages.length; i++) {
        const msg = messages[i]!;
        this.renderMessage(msg, i, messages.length);

        if (msg.finished) {
          const success = msg.exitCode === 0;
          if (!success) {
            throw new ExecutionFailedError(
              `Execution failed at step '${msg.command}' (exit code ${msg.exitCode})`,
            );
          }
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          if (!this.options.quiet && !this.options.json) {
            process.stderr.write(
              `\nCompleted. VMID: ${msg.vmId ?? "N/A"}, Duration: ${elapsed}s\n`,
            );
          }
          const result: { vmId?: number; success: boolean } = { success: true };
          if (msg.vmId !== undefined) result.vmId = msg.vmId;
          return result;
        }
      }
      this.seenMessages = messages.length;

      await sleep(3000);
    }

    throw new TimeoutError(
      `Execution timed out after ${this.options.timeout}s`,
    );
  }

  private renderMessage(
    msg: IVeExecuteMessage,
    index: number,
    total: number,
  ): void {
    if (this.options.json) {
      process.stdout.write(JSON.stringify(msg) + "\n");
      return;
    }

    if (this.options.quiet) return;

    // Skip partial streaming messages for standard output
    if (msg.partial) return;

    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const step = `[${index + 1}/${total}]`;
    const status =
      msg.exitCode === 0
        ? "OK"
        : msg.finished
          ? `FAILED (exit ${msg.exitCode})`
          : "...";
    const extra = msg.vmId ? ` (VMID: ${msg.vmId})` : "";
    const name = msg.command;

    process.stderr.write(
      `[${time}] ${step} ${name} ${"."
        .repeat(Math.max(1, 40 - name.length))} ${status}${extra}\n`,
    );

    if (this.options.verbose && msg.stderr) {
      for (const line of msg.stderr.split("\n")) {
        if (line) process.stderr.write(`    ${line}\n`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
