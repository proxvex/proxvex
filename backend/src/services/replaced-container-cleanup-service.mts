import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand, IReplacedCleanupStatus } from "../types.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("replaced-cleanup");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STATE_KEY = "replaced_cleanup";
const DEFAULT_GRACE_DAYS = 2;

interface StoredState {
  enabled: boolean;
  grace_days: number;
  last_check?: string | undefined;
  last_destroyed?: string[] | undefined;
  last_error?: string | undefined;
}

interface ReplacedContainer {
  vm_id: number;
  hostname?: string;
  replaced_at: string;
  replaced_by?: string;
  lock?: string;
}

export class ReplacedContainerCleanupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private contextManager: ContextManager) {}

  private getState(): StoredState {
    return (
      this.contextManager.get<StoredState>(STATE_KEY) || {
        enabled: false,
        grace_days: DEFAULT_GRACE_DAYS,
      }
    );
  }

  private setState(state: StoredState): void {
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
    logger.info("Replaced-container cleanup state changed", { enabled });

    if (enabled && !this.timer) {
      this.startTimer();
    } else if (!enabled && this.timer) {
      this.stop();
    }
  }

  setGraceDays(days: number): void {
    if (!Number.isFinite(days) || days < 0) {
      throw new Error("grace_days must be a non-negative number");
    }
    const state = this.getState();
    state.grace_days = days;
    this.setState(state);
    logger.info("Replaced-container cleanup grace_days changed", { days });
  }

  getStatus(): IReplacedCleanupStatus {
    const state = this.getState();
    const lastCheck = state.last_check ? new Date(state.last_check) : undefined;
    const nextCheck = lastCheck
      ? new Date(lastCheck.getTime() + CHECK_INTERVAL_MS).toISOString()
      : undefined;

    return {
      enabled: state.enabled,
      grace_days: state.grace_days,
      last_check: state.last_check,
      next_check: state.enabled ? nextCheck : undefined,
      last_destroyed: state.last_destroyed,
      last_error: state.last_error,
    };
  }

  startTimer(): void {
    if (this.timer) return;

    logger.info("Starting replaced-container cleanup timer", {
      intervalMs: CHECK_INTERVAL_MS,
    });
    this.timer = setInterval(() => {
      this.checkAndCleanup().catch((err) => {
        logger.error("Replaced-container cleanup check failed", {
          error: err?.message || String(err),
        });
      });
    }, CHECK_INTERVAL_MS);

    setTimeout(() => {
      if (this.isEnabled()) {
        this.checkAndCleanup().catch((err) => {
          logger.error("Initial replaced-container cleanup check failed", {
            error: err?.message || String(err),
          });
        });
      }
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Replaced-container cleanup timer stopped");
    }
  }

  /**
   * List all replaced containers across all VE contexts (no destroy).
   * Used by the status endpoint and the manual run preview.
   */
  async listAll(): Promise<{ veKey: string; containers: ReplacedContainer[] }[]> {
    const out: { veKey: string; containers: ReplacedContainer[] }[] = [];
    for (const veKey of this.getVeContextKeys()) {
      try {
        const containers = await this.listReplacedForContext(veKey);
        out.push({ veKey, containers });
      } catch (err: any) {
        logger.warn(`Listing replaced containers failed for ${veKey}`, {
          error: err?.message,
        });
      }
    }
    return out;
  }

  async checkAndCleanup(): Promise<IReplacedCleanupStatus> {
    if (this.running) {
      logger.info("Replaced-container cleanup already in progress, skipping");
      return this.getStatus();
    }

    this.running = true;
    const state = this.getState();

    try {
      const veKeys = this.getVeContextKeys();
      if (veKeys.length === 0) {
        logger.info("No VE contexts configured, skipping replaced-cleanup");
        state.last_check = new Date().toISOString();
        state.last_error = undefined;
        state.last_destroyed = [];
        this.setState(state);
        return this.getStatus();
      }

      const cutoffMs =
        Date.now() - state.grace_days * 24 * 60 * 60 * 1000;
      const destroyed: string[] = [];

      for (const veKey of veKeys) {
        const veContext = this.contextManager.getVEContextByKey(veKey);
        const host = veContext?.host || veKey.replace(/^ve_/, "");
        try {
          const containers = await this.listReplacedForContext(veKey);
          for (const c of containers) {
            const t = Date.parse(c.replaced_at);
            if (!Number.isFinite(t)) {
              logger.warn(
                `Skipping container ${c.vm_id}@${host}: invalid replaced_at "${c.replaced_at}"`,
              );
              continue;
            }
            if (t < cutoffMs) {
              try {
                await this.destroyForContext(veKey, c.vm_id);
                destroyed.push(`${c.vm_id}@${host}`);
              } catch (err: any) {
                logger.warn(
                  `Destroy of replaced container ${c.vm_id}@${host} failed`,
                  { error: err?.message },
                );
              }
            }
          }
        } catch (err: any) {
          logger.warn(`Replaced-cleanup failed for ${host}`, {
            error: err?.message,
          });
        }
      }

      const now = new Date().toISOString();
      state.last_check = now;
      state.last_error = undefined;
      state.last_destroyed = destroyed;
      this.setState(state);

      if (destroyed.length > 0) {
        logger.info(
          `Replaced-container cleanup destroyed ${destroyed.length}: ${destroyed.join(", ")}`,
        );
      } else {
        logger.info("Replaced-container cleanup: nothing past grace period");
      }

      return this.getStatus();
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      logger.error("Replaced-container cleanup check failed", {
        error: errorMsg,
      });
      state.last_check = new Date().toISOString();
      state.last_error = errorMsg;
      this.setState(state);
      return this.getStatus();
    } finally {
      this.running = false;
    }
  }

  private async listReplacedForContext(
    veContextKey: string,
  ): Promise<ReplacedContainer[]> {
    const veContext = this.contextManager.getVEContextByKey(veContextKey);
    if (!veContext) throw new Error(`VE context not found: ${veContextKey}`);

    const pm = PersistenceManager.getInstance();
    const repositories = pm.getRepositories();
    const scriptContent = repositories.getScript({
      name: "host-list-replaced-containers.py",
      scope: "shared",
      category: "list",
    });
    const libraryContent = repositories.getScript({
      name: "lxc_config_parser_lib.py",
      scope: "shared",
      category: "library",
    });
    if (!scriptContent || !libraryContent) {
      throw new Error("host-list-replaced-containers scripts not found");
    }

    const cmd: ICommand = {
      name: "List Replaced Containers",
      execute_on: "ve",
      script: "host-list-replaced-containers.py",
      scriptContent,
      libraryContent,
      outputs: ["replaced_containers"],
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

    const raw = ve.outputs.get("replaced_containers");
    if (typeof raw !== "string" || raw.trim().length === 0) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReplacedContainer[]) : [];
  }

  private async destroyForContext(
    veContextKey: string,
    vmId: number,
  ): Promise<void> {
    const veContext = this.contextManager.getVEContextByKey(veContextKey);
    if (!veContext) throw new Error(`VE context not found: ${veContextKey}`);

    const pm = PersistenceManager.getInstance();
    const repositories = pm.getRepositories();
    const scriptContent = repositories.getScript({
      name: "host-destroy-replaced-container.sh",
      scope: "shared",
      category: "maintenance",
    });
    const libraryContent = repositories.getScript({
      name: "vol-common.sh",
      scope: "shared",
      category: "library",
    });
    if (!scriptContent || !libraryContent) {
      throw new Error("host-destroy-replaced-container scripts not found");
    }

    const cmd: ICommand = {
      name: "Destroy Replaced Container",
      execute_on: "ve",
      script: "host-destroy-replaced-container.sh",
      scriptContent,
      libraryContent,
      outputs: [],
    };

    const ve = new VeExecution(
      [cmd],
      [{ id: "vmid", value: String(vmId) }],
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );
    await ve.run(null);
  }
}
