import { IVEContext, IVMContext } from "@src/backend-types.mjs";
import { ICommand, IPlannedStep, IVeExecuteMessage } from "@src/types.mjs";
import { IProcessedTemplate } from "@src/templates/templateprocessor-types.mjs";
import { IRestartInfo } from "@src/ve-execution/ve-execution-constants.mjs";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { spawnAsync } from "@src/spawn-utils.mjs";
import { Logger, createLogger } from "@src/logger/index.mjs";

const diagLogger = createLogger("diagnostics");
import type { IVeDebugEvent } from "@src/ve-execution/ve-execution-message-emitter.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import type {
  DebugLevel,
  WebAppDebugCollector,
} from "./webapp-debug-collector.mjs";
import type { AppLogMonitor } from "@src/ve-execution/app-log-monitor.mjs";

/** Marker emitted on stderr by lxc-start.sh once the container is running. */
const PCT_START_MARKER = /PROXVEX_PCT_START_EXECUTED vmid=(\d+)/;

/**
 * Sets up and configures VeExecution instances.
 */
export class WebAppVeExecutionSetup {
  /**
   * Generates a unique restart key.
   */
  generateRestartKey(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Sets up a VeExecution instance with event handlers and returns the restart key.
   */
  setupExecution(
    commands: ICommand[],
    inputs: Array<{ id: string; value: string | number | boolean }>,
    defaults: Map<string, string | number | boolean>,
    veContext: IVEContext,
    messageManager: WebAppVeMessageManager,
    restartManager: WebAppVeRestartManager,
    application: string,
    task: string,
    sshCommand: string = "ssh",
    processedTemplates?: IProcessedTemplate[],
    debugCollector?: WebAppDebugCollector,
    appLogMonitor?: AppLogMonitor,
  ): { exec: VeExecution; restartKey: string } {
    const exec = new VeExecution(
      commands,
      inputs,
      veContext,
      defaults,
      sshCommand,
    );
    const restartKey = this.generateRestartKey();

    // Clear old messages for this application/task before starting
    messageManager.clearMessagesForApplication(application, task);
    messageManager.cleanupOldMessages();

    // Pre-populate planned steps so the frontend can show all steps immediately
    const group = messageManager.findOrCreateMessageGroup(application, task, restartKey);
    group.plannedSteps = this.buildPlannedSteps(commands, processedTemplates);

    // Debug bundle wiring — only attached when debug_level != "off". The
    // logger sink is global state (single concurrent task is the current
    // assumption); a future multi-task setup needs AsyncLocalStorage.
    const debugLevel = readDebugLevelFromInputs(inputs, defaults);
    if (debugCollector && debugLevel !== "off") {
      debugCollector.start(restartKey, application, task, debugLevel);
      Logger.setDebugSink((entry) =>
        debugCollector.attachLogLine(restartKey, entry),
      );
      exec.on("debug", (event: IVeDebugEvent) => {
        debugCollector.handleDebugEvent(restartKey, event);
      });
    }

    // Finalise the debug bundle exactly once — on success ("finished" event,
    // carries the IVMContext) or on terminal failure (the "Failed" message;
    // ve-execution does NOT emit "finished" then). Without the failure path
    // the bundle would never finalise for failed scenarios — precisely when
    // the app-log timeline matters most.
    let finalized = false;
    const finalizeBundle = (ctx: IVMContext | null) => {
      if (finalized) return;
      finalized = true;
      if (ctx) veContext.getStorageContext().setVMContext(ctx);
      // Stop log followers first so no applog event arrives after the
      // bundle's finishedAt timestamp (would land in a phantom postamble).
      appLogMonitor?.stop(restartKey);
      if (debugCollector && debugLevel !== "off") {
        // Capture the LXC config for the current and (reconfigure/upgrade)
        // previous VM. Best-effort: failures land in the bundle as error
        // notes, never block finish().
        void captureLxcDiagnostics(
          debugCollector,
          restartKey,
          veContext,
          ctx,
          inputs,
          defaults,
        ).finally(() => {
          debugCollector.finish(restartKey);
          Logger.setDebugSink(null);
        });
      }
    };

    exec.on("message", (msg: IVeExecuteMessage) => {
      messageManager.handleExecutionMessage(msg, application, task, restartKey);
      // Stream stderr chunks into the debug bundle so the per-script trace
      // can interleave them with backend logger lines by timestamp.
      // Exception: kind:"skipped" messages already have a dedicated
      // `script-skipped` debug event that creates a scripts[] entry. Routing
      // them through attachStderr too would re-emit the "Skipped: …" text as
      // stderr attached to the previous script — the very misattribution
      // this kind flag is meant to prevent.
      if (
        debugCollector &&
        debugLevel !== "off" &&
        typeof msg.stderr === "string" &&
        msg.stderr.length > 0 &&
        msg.kind !== "skipped"
      ) {
        debugCollector.attachStderr(restartKey, msg.stderr);
        // The container is up — start tailing its application logs into the
        // timeline. Idempotent per (restartKey, vmId); a second marker with a
        // new vmId (container swap on reconfigure/upgrade) adds that VM too.
        if (appLogMonitor) {
          const m = PCT_START_MARKER.exec(msg.stderr);
          if (m) {
            const vmId = parseInt(m[1]!, 10);
            appLogMonitor.start(
              restartKey,
              vmId,
              veContext,
              (channel, vm, line) =>
                debugCollector.attachAppLog(restartKey, channel, vm, line),
            );
          }
        }
      }
      // Terminal failure: ve-execution emits a final "Failed" message but no
      // "finished" event. Finalise here so the bundle (with the app-log
      // timeline up to the failure) is fetchable by the test runner / UI.
      if (msg.command === "Failed" && msg.finished === true) {
        finalizeBundle(null);
      }
    });
    exec.on("finished", (msg: IVMContext) => finalizeBundle(msg));

    return { exec, restartKey };
  }

  /**
   * Sets up execution result handlers (for storing restart info).
   */
  setupExecutionResultHandlers(
    exec: VeExecution,
    restartKey: string,
    restartManager: WebAppVeRestartManager,
    fallbackRestartInfo: IRestartInfo,
    onComplete?: (exec: VeExecution) => void,
  ): void {
    exec
      .run(null)
      .then((result) => {
        // Always store result (even on error, result contains state for retry)
        if (result) {
          restartManager.storeRestartInfo(restartKey, result);
        } else {
          restartManager.storeRestartInfo(restartKey, fallbackRestartInfo);
        }
        if (onComplete) onComplete(exec);
      })
      .catch((err: Error) => {
        console.error("Execution error:", err.message);
        // Store minimal restartInfo so user can retry from beginning
        restartManager.storeRestartInfo(restartKey, fallbackRestartInfo);
      });
  }

  /**
   * Sets up restart execution result handlers.
   */
  private buildPlannedSteps(commands: ICommand[], processedTemplates?: IProcessedTemplate[]): IPlannedStep[] {
    // Build a lookup from template name to shared/local info
    const templateInfo = new Map<string, { isShared: boolean; isLocal: boolean; isHub: boolean }>();
    if (processedTemplates) {
      for (const pt of processedTemplates) {
        const isLocal = pt.path.startsWith("local/");
        const isHub = pt.path.startsWith("hub/");
        templateInfo.set(pt.name, { isShared: pt.isShared, isLocal, isHub });
        // Also map by template display name for matching against command names
        if (pt.templateData?.name) {
          templateInfo.set(pt.templateData.name, { isShared: pt.isShared, isLocal, isHub });
        }
      }
    }

    return commands.map(c => {
      const step: IPlannedStep = {
        name: c.name,
        ...(c.description && { description: c.description }),
      };
      // Try to find template info by command name (strip "(skipped)" suffix)
      const cleanName = c.name.replace(/\s*\(skipped\)\s*$/, '');
      const info = templateInfo.get(cleanName);
      if (info) {
        step.isShared = info.isShared;
        step.isLocal = info.isLocal;
        step.isHub = info.isHub;
      }
      return step;
    });
  }

  setupRestartExecutionResultHandlers(
    exec: VeExecution,
    restartKey: string,
    restartInfo: IRestartInfo,
    restartManager: WebAppVeRestartManager,
  ): void {
    exec
      .run(restartInfo)
      .then((result) => {
        // Always store result (even on error, result contains state for retry)
        restartManager.storeRestartInfo(restartKey, result || restartInfo);
      })
      .catch((err: Error) => {
        console.error("Restart execution error:", err.message);
        // Even on error, store restartInfo so user can retry
        restartManager.storeRestartInfo(restartKey, restartInfo);
      });
  }
}

function readDebugLevelFromInputs(
  inputs: Array<{ id: string; value: string | number | boolean }>,
  defaults: Map<string, string | number | boolean>,
): DebugLevel {
  const inp = inputs.find((i) => i.id === "debug_level")?.value;
  const raw =
    (typeof inp === "string" ? inp : undefined) ??
    (defaults.get("debug_level") as string | undefined) ??
    "off";
  if (raw === "extLog" || raw === "script") return raw;
  return "off";
}

/**
 * Resolve an input value by id, falling back to defaults. Returns the raw
 * value or undefined if neither source defines it.
 */
function resolveInput(
  id: string,
  inputs: Array<{ id: string; value: string | number | boolean }>,
  defaults: Map<string, string | number | boolean>,
): string | number | boolean | undefined {
  const inp = inputs.find((i) => i.id === id);
  if (inp !== undefined) return inp.value;
  return defaults.get(id);
}

function toVmId(v: string | number | boolean | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * After the task finishes, fetch the `/etc/pve/lxc/<vmid>.conf` snapshot for
 * each VM of interest and attach it to the debug bundle. Covers the current
 * vm_id plus previous_vm_id when set (reconfigure/upgrade).
 *
 * The LXC console log is NOT captured here anymore — it streams live into the
 * timeline via the AppLogMonitor. Raw logs remain on the PVE host in
 * production and are reproducible in tests.
 *
 * Best-effort: any per-VM failure is recorded as an error string in the
 * bundle rather than thrown, so a missing previous container or an SSH
 * hiccup never blocks bundle finalisation.
 */
async function captureLxcDiagnostics(
  debugCollector: WebAppDebugCollector,
  restartKey: string,
  veContext: IVEContext,
  finishedCtx: IVMContext | null,
  inputs: Array<{ id: string; value: string | number | boolean }>,
  defaults: Map<string, string | number | boolean>,
): Promise<void> {
  const targets: Array<{ vmId: number; label: string }> = [];
  const currentVmId =
    finishedCtx?.vmid || toVmId(resolveInput("vm_id", inputs, defaults));
  if (currentVmId) targets.push({ vmId: currentVmId, label: "current" });
  const prevVmId = toVmId(resolveInput("previous_vm_id", inputs, defaults));
  if (prevVmId && prevVmId !== currentVmId) {
    targets.push({ vmId: prevVmId, label: "previous" });
  }
  diagLogger.info("capture starting", {
    restartKey,
    vmids: targets.map((t) => `${t.vmId}(${t.label})`).join(",") || "(none)",
    host: `${veContext.host}:${veContext.port ?? 22}`,
  });
  if (targets.length === 0) return;

  const sshHost = buildSshTarget(veContext);

  // One short SSH call per VM: just `cat /etc/pve/lxc/<vmid>.conf`.
  await Promise.all(
    targets.map(async ({ vmId, label }) => {
      const diag: {
        vmId: number;
        label: string;
        conf?: string;
        confError?: string;
      } = { vmId, label };

      const confPath = `/etc/pve/lxc/${vmId}.conf`;
      try {
        const res = await sshExec(sshHost, `cat ${confPath} 2>&1`, 15000);
        if (res.exitCode === 0 && res.stdout.trim().length > 0) {
          diag.conf = res.stdout.trim();
        } else {
          diag.confError =
            res.stdout.trim() ||
            `ssh exit ${res.exitCode}: ${res.stderr?.trim() || "(no stderr)"}`;
        }
      } catch (err) {
        diag.confError = err instanceof Error ? err.message : String(err);
      }

      diagLogger.info("capture done", {
        restartKey,
        vmId,
        confBytes: diag.conf?.length ?? 0,
        confError: diag.confError,
      });
      debugCollector.attachDiagnostic(restartKey, diag);
    }),
  );
}

/** Resolve the ssh `[user@]host` target plus port from veContext. */
function buildSshTarget(veContext: IVEContext): { host: string; port: number } {
  let host = veContext.host;
  if (typeof host === "string" && !host.includes("@")) {
    host = `root@${host}`;
  }
  return { host, port: veContext.port || 22 };
}

async function sshExec(
  target: { host: string; port: number },
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=5",
    "-T",
    "-q",
    "-p",
    String(target.port),
    target.host,
    command,
  ];
  return spawnAsync("ssh", args, { timeout: timeoutMs });
}
