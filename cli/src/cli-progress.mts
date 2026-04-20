import type { IVeExecuteMessage } from "@shared/types.mjs";
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
  private lastSeenIndex = -1;
  private totalSteps?: number;
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
        const since = this.lastSeenIndex >= 0 ? this.lastSeenIndex : undefined;
        const response = await this.client.getExecuteMessages(this.veContext, since);
        // Response is array of ISingleExecuteMessagesResponse
        const latest = response[response.length - 1];
        messages = latest?.messages ?? [];
        // Capture total steps from plannedSteps on first response
        if (this.totalSteps === undefined && latest?.plannedSteps) {
          this.totalSteps = latest.plannedSteps.length;
        }
        // Track highest seen index for delta-polling
        for (const msg of messages) {
          if (msg.index !== undefined && msg.index > this.lastSeenIndex) {
            this.lastSeenIndex = msg.index;
          }
        }
        retryCount = 0;
      } catch (err) {
        retryCount++;
        if (retryCount > maxRetries) throw err;
        await sleep(5000);
        continue;
      }

      // With delta-polling, all returned messages are new
      for (const msg of messages) {
        this.renderMessage(msg, this.seenMessages);
        this.seenMessages++;

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
            if (msg.completionInfo) {
              const info = msg.completionInfo;
              const line = "=".repeat(60);
              process.stderr.write(`\n${line}\n`);
              process.stderr.write(`  ${info.header}\n`);
              process.stderr.write(`${line}\n`);
              if (info.details) {
                for (const l of info.details.split("\n")) {
                  process.stderr.write(`  ${l}\n`);
                }
              }
              if (info.url) {
                process.stderr.write(`\n  URL: ${info.url}\n`);
              }
              process.stderr.write(`${line}\n`);
            }
          }
          const result: { vmId?: number; success: boolean } = { success: true };
          if (msg.vmId !== undefined) result.vmId = msg.vmId;
          return result;
        }
      }

      await sleep(3000);
    }

    throw new TimeoutError(
      `Execution timed out after ${this.options.timeout}s`,
    );
  }

  private renderMessage(
    msg: IVeExecuteMessage,
    index: number,
  ): void {
    if (this.options.json) {
      process.stdout.write(JSON.stringify(msg) + "\n");
      return;
    }

    // Skip partial streaming messages
    if (msg.partial) return;

    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const step = this.totalSteps ? `[${index + 1}/${this.totalSteps}]` : `[${index + 1}]`;
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

    // In quiet mode: show step headers (above) but skip logs — except on failure
    if (this.options.quiet) {
      if (msg.exitCode !== 0 && msg.stderr) {
        for (const line of msg.stderr.split("\n")) {
          if (line) process.stderr.write(`    ${line}\n`);
        }
      }
      return;
    }

    if ((this.options.verbose || msg.exitCode !== 0) && msg.stderr) {
      for (const line of msg.stderr.split("\n")) {
        if (line) process.stderr.write(`    ${line}\n`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
