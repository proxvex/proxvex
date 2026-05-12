import { spawn, SpawnOptionsWithoutStdio } from "node:child_process";

export interface SpawnAsyncOptions extends SpawnOptionsWithoutStdio {
  input?: string;
  /**
   * Legacy hard timeout in ms. If set without idleTimeoutMs, behaves as the
   * old absolute kill timer. Prefer idleTimeoutMs + hardTimeoutMs for new
   * code.
   */
  timeout?: number;
  /**
   * Kill the process if no stdout/stderr output is observed for this many ms.
   * Watchdog runs every ~2s and checks elapsed silence. Each new chunk resets
   * the idle counter. Long-running commands that keep emitting progress are
   * unaffected; truly hung commands die on time.
   */
  idleTimeoutMs?: number;
  /**
   * Absolute upper bound regardless of output. Catches infinite loops that
   * keep printing. Optional — if omitted no hard cap is applied beyond what
   * `timeout` may set.
   */
  hardTimeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnAsyncResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Reason for forced termination, if any. */
  killedBy?: "idle" | "hard" | "timeout";
}

/**
 * Spawns a process asynchronously with timeout support and optional input/output handlers.
 * Automatically kills the process with SIGTERM on timeout, and with SIGKILL if SIGTERM doesn't work.
 */
export function spawnAsync(
  cmd: string,
  args: string[],
  options: SpawnAsyncOptions,
): Promise<SpawnAsyncResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...options, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let killedBy: SpawnAsyncResult["killedBy"];

    if (options.input) {
      // EPIPE can be thrown synchronously from write() when the child closed
      // stdin before the call (race common in fast-exit tools). The exit code
      // from `close` is the useful signal — swallow EPIPE here and let the
      // close handler resolve the promise. Error-event listener handles the
      // async case.
      proc.stdin?.on("error", () => {});
      try {
        proc.stdin?.write(options.input);
      } catch {
        // EPIPE / ERR_STREAM_DESTROYED — child already closed stdin
      }
      try {
        proc.stdin?.end();
      } catch {
        // Same as above
      }
    }

    let lastOutputTs = Date.now();
    proc.stdout?.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      lastOutputTs = Date.now();
      if (options.onStdout) {
        options.onStdout(chunk);
      }
    });
    proc.stderr?.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      lastOutputTs = Date.now();
      if (options.onStderr) {
        options.onStderr(chunk);
      }
    });

    let killTimeoutId: NodeJS.Timeout | undefined;
    let hardTimeoutId: NodeJS.Timeout | undefined;
    let legacyTimeoutId: NodeJS.Timeout | undefined;
    let idleWatchdogId: NodeJS.Timeout | undefined;

    const kill = (reason: NonNullable<SpawnAsyncResult["killedBy"]>) => {
      if (killedBy) return; // already kill-pending
      killedBy = reason;
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
      // If process doesn't terminate within 2 seconds after SIGTERM, force kill with SIGKILL
      killTimeoutId = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may already be dead, ignore
        }
      }, 2000);
    };

    // Idle timeout: poll every ~2s, kill if no output for idleTimeoutMs
    if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
      const idleLimit = options.idleTimeoutMs;
      const pollInterval = Math.min(2000, Math.max(500, idleLimit / 4));
      idleWatchdogId = setInterval(() => {
        if (Date.now() - lastOutputTs >= idleLimit) {
          kill("idle");
        }
      }, pollInterval);
    }

    // Hard timeout: absolute upper bound regardless of output
    if (options.hardTimeoutMs && options.hardTimeoutMs > 0) {
      hardTimeoutId = setTimeout(() => kill("hard"), options.hardTimeoutMs);
    }

    // Legacy timeout: kept for callers that haven't migrated. Behaves like the
    // original absolute timeout, but reports killedBy="timeout" so logs can
    // tell them apart.
    if (
      options.timeout &&
      options.timeout > 0 &&
      !options.idleTimeoutMs &&
      !options.hardTimeoutMs
    ) {
      legacyTimeoutId = setTimeout(() => kill("timeout"), options.timeout);
    }

    const cleanup = () => {
      if (idleWatchdogId) clearInterval(idleWatchdogId);
      if (hardTimeoutId) clearTimeout(hardTimeoutId);
      if (legacyTimeoutId) clearTimeout(legacyTimeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
    };

    proc.on("close", (exitCode) => {
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
        ...(killedBy ? { killedBy } : {}),
      });
    });

    proc.on("error", () => {
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: -1,
        ...(killedBy ? { killedBy } : {}),
      });
    });
  });
}
