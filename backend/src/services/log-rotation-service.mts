import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ILogRotationStatus, ICommand } from "../types.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("log-rotation");

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STATE_KEY = "log_rotation";

interface StoredLogRotationState {
  enabled: boolean;
  last_check?: string | undefined;
  last_rotated_count?: number | undefined;
  last_deleted_count?: number | undefined;
  last_error?: string | undefined;
}

export class LogRotationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private contextManager: ContextManager) {}

  private getState(): StoredLogRotationState {
    return this.contextManager.get<StoredLogRotationState>(STATE_KEY) || { enabled: false };
  }

  private setState(state: StoredLogRotationState): void {
    this.contextManager.set(STATE_KEY, state);
  }

  private getVeContextKeys(): string[] {
    return this.contextManager.keys().filter((k) => k.startsWith("ve_"));
  }

  isEnabled(): boolean {
    return this.getState().enabled;
  }

  setEnabled(enabled: boolean): void {
    const state = this.getState();
    state.enabled = enabled;
    this.setState(state);
    logger.info("Log rotation state changed", { enabled });

    if (enabled && !this.timer) {
      this.startTimer();
    } else if (!enabled && this.timer) {
      this.stop();
    }
  }

  getStatus(): ILogRotationStatus {
    const state = this.getState();
    const lastCheck = state.last_check ? new Date(state.last_check) : undefined;
    const nextCheck = lastCheck
      ? new Date(lastCheck.getTime() + CHECK_INTERVAL_MS).toISOString()
      : undefined;

    return {
      enabled: state.enabled,
      last_check: state.last_check,
      next_check: state.enabled ? nextCheck : undefined,
      last_rotated_count: state.last_rotated_count,
      last_deleted_count: state.last_deleted_count,
      last_error: state.last_error,
    };
  }

  startTimer(): void {
    if (this.timer) return;

    logger.info("Starting log rotation timer", { intervalMs: CHECK_INTERVAL_MS });
    this.timer = setInterval(() => {
      this.checkAndRotate().catch((err) => {
        logger.error("Log rotation check failed", { error: err?.message || String(err) });
      });
    }, CHECK_INTERVAL_MS);

    // Run an initial check 60 seconds after startup
    setTimeout(() => {
      if (this.isEnabled()) {
        this.checkAndRotate().catch((err) => {
          logger.error("Initial log rotation check failed", { error: err?.message || String(err) });
        });
      }
    }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Log rotation timer stopped");
    }
  }

  async checkAndRotate(): Promise<ILogRotationStatus> {
    if (this.running) {
      logger.info("Log rotation already in progress, skipping");
      return this.getStatus();
    }

    this.running = true;
    const state = this.getState();

    try {
      const veKeys = this.getVeContextKeys();
      if (veKeys.length === 0) {
        logger.info("No VE contexts configured, skipping log rotation");
        state.last_check = new Date().toISOString();
        state.last_error = undefined;
        state.last_rotated_count = 0;
        state.last_deleted_count = 0;
        this.setState(state);
        return this.getStatus();
      }

      let totalRotated = 0;
      let totalDeleted = 0;

      for (const veKey of veKeys) {
        try {
          const result = await this.rotateLogsForContext(veKey);
          totalRotated += result.rotated;
          totalDeleted += result.deleted;
        } catch (err: any) {
          const veContext = this.contextManager.getVEContextByKey(veKey);
          const host = veContext?.host || veKey.replace(/^ve_/, "");
          logger.warn(`Log rotation failed for ${host}`, { error: err?.message });
        }
      }

      const now = new Date().toISOString();
      state.last_check = now;
      state.last_error = undefined;
      state.last_rotated_count = totalRotated;
      state.last_deleted_count = totalDeleted;
      this.setState(state);

      if (totalRotated > 0 || totalDeleted > 0) {
        logger.info(`Log rotation: ${totalRotated} rotated, ${totalDeleted} deleted`);
      } else {
        logger.info("Log rotation: nothing to rotate or delete");
      }

      return this.getStatus();
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      logger.error("Log rotation check failed", { error: errorMsg });
      state.last_check = new Date().toISOString();
      state.last_error = errorMsg;
      this.setState(state);
      return this.getStatus();
    } finally {
      this.running = false;
    }
  }

  private async rotateLogsForContext(
    veContextKey: string,
  ): Promise<{ rotated: number; deleted: number }> {
    const veContext = this.contextManager.getVEContextByKey(veContextKey);
    if (!veContext) throw new Error(`VE context not found: ${veContextKey}`);

    const pm = PersistenceManager.getInstance();
    const repositories = pm.getRepositories();
    const scriptContent = repositories.getScript({
      name: "host-rotate-lxc-logs.sh",
      scope: "shared",
      category: "maintenance",
    });
    if (!scriptContent) throw new Error("host-rotate-lxc-logs.sh not found");

    const cmd: ICommand = {
      name: "Rotate LXC Logs",
      execute_on: "ve",
      script: "host-rotate-lxc-logs.sh",
      scriptContent,
      outputs: ["log_rotation_result"],
    };

    const ve = new VeExecution(
      [cmd],
      [],
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );
    await ve.run(null);

    const resultRaw = ve.outputs.get("log_rotation_result");
    if (!resultRaw || typeof resultRaw !== "string") {
      return { rotated: 0, deleted: 0 };
    }

    // Parse "rotated:3,deleted:1"
    const rotatedMatch = resultRaw.match(/rotated:(\d+)/);
    const deletedMatch = resultRaw.match(/deleted:(\d+)/);
    return {
      rotated: rotatedMatch?.[1] ? parseInt(rotatedMatch[1], 10) : 0,
      deleted: deletedMatch?.[1] ? parseInt(deletedMatch[1], 10) : 0,
    };
  }
}
