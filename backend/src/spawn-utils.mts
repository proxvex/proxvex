import { spawn, SpawnOptionsWithoutStdio } from "node:child_process";

export interface SpawnAsyncOptions extends SpawnOptionsWithoutStdio {
  input?: string;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnAsyncResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
    let timeoutId: NodeJS.Timeout | undefined;

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

    proc.stdout?.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (options.onStdout) {
        options.onStdout(chunk);
      }
    });
    proc.stderr?.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (options.onStderr) {
        options.onStderr(chunk);
      }
    });

    let killTimeoutId: NodeJS.Timeout | undefined;
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
        // If process doesn't terminate within 2 seconds after SIGTERM, force kill with SIGKILL
        killTimeoutId = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Process may already be dead, ignore
          }
        }, 2000);
      }, options.timeout);
    }

    proc.on("close", (exitCode) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
    });

    proc.on("error", () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}
