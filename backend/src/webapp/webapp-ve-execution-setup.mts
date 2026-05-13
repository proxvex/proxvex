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
      }
    });
    exec.on("finished", (msg: IVMContext) => {
      veContext.getStorageContext().setVMContext(msg);
      if (debugCollector && debugLevel !== "off") {
        // Capture LXC console log + config for the current and (for
        // reconfigure/upgrade) previous VM. Best-effort: failures land in
        // the bundle as error notes, never block finish().
        void captureLxcDiagnostics(
          debugCollector,
          restartKey,
          veContext,
          msg,
          inputs,
          defaults,
        ).finally(() => {
          debugCollector.finish(restartKey);
          Logger.setDebugSink(null);
        });
      }
    });

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
 * After the task finishes, fetch the LXC console log (via VeLogsService —
 * same code path as the live /logs/<ve>/<vmid> endpoint) and the
 * `/etc/pve/lxc/<vmid>.conf` snapshot for each VM of interest, and attach
 * them to the debug bundle. Covers the current vm_id plus previous_vm_id
 * when set (reconfigure/upgrade).
 *
 * Best-effort: any per-VM failure is recorded as an error string in the
 * bundle rather than thrown, so a missing previous container or an SSH
 * hiccup never blocks bundle finalisation.
 */
async function captureLxcDiagnostics(
  debugCollector: WebAppDebugCollector,
  restartKey: string,
  veContext: IVEContext,
  finishedCtx: IVMContext,
  inputs: Array<{ id: string; value: string | number | boolean }>,
  defaults: Map<string, string | number | boolean>,
): Promise<void> {
  const targets: Array<{ vmId: number; label: string }> = [];
  const currentVmId = finishedCtx.vmid || toVmId(resolveInput("vm_id", inputs, defaults));
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

  // Single SSH call per VM that returns both conf and log in one go,
  // separated by sentinel lines. Avoids VeLogsService's 4-5 sequential
  // SSH round-trips (checkStatus / getHostname / findLogFile / cat) that
  // routinely exceeded the runner's 10s bundle-fetch timeout.
  await Promise.all(
    targets.map(async ({ vmId, label }) => {
      const diag: {
        vmId: number;
        label: string;
        log?: string;
        logSource?: string;
        logError?: string;
        conf?: string;
        confError?: string;
      } = { vmId, label };

      const confPath = `/etc/pve/lxc/${vmId}.conf`;
      // Try the two canonical LXC log locations directly. The first match
      // wins. tail -c limits to ~256 KB so a runaway log can't bloat the
      // bundle indefinitely.
      const remoteScript = [
        `echo "===CONF==="`,
        `cat ${confPath} 2>&1 || true`,
        `echo "===HOSTNAME==="`,
        `awk -F': *' '/^hostname:/ {print $2; exit}' ${confPath} 2>/dev/null || true`,
        `HN=$(awk -F': *' '/^hostname:/ {print $2; exit}' ${confPath} 2>/dev/null)`,
        `LOG="/var/log/lxc/$HN-${vmId}.log"`,
        `[ -n "$HN" ] && [ -f "$LOG" ] || LOG="/var/log/lxc/container-${vmId}.log"`,
        `echo "===LOGPATH==="`,
        `echo "$LOG"`,
        `echo "===LOG==="`,
        `[ -f "$LOG" ] && tail -c 262144 "$LOG" 2>/dev/null || echo "(log file missing: $LOG)"`,
      ].join("; ");

      try {
        const res = await sshExec(sshHost, remoteScript, 15000);
        if (res.exitCode === 0) {
          parseDiagnosticBlocks(res.stdout, diag, vmId);
        } else {
          diag.confError = `ssh exit ${res.exitCode}: ${res.stderr?.trim() || "(no stderr)"}`;
          diag.logError = diag.confError;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diag.confError = msg;
        diag.logError = msg;
      }

      diagLogger.info("capture done", {
        restartKey,
        vmId,
        confBytes: diag.conf?.length ?? 0,
        logBytes: diag.log?.length ?? 0,
        confError: diag.confError,
        logError: diag.logError,
      });
      debugCollector.attachDiagnostic(restartKey, diag);
    }),
  );
}

function parseDiagnosticBlocks(
  stdout: string,
  diag: {
    log?: string;
    logSource?: string;
    logError?: string;
    conf?: string;
    confError?: string;
  },
  vmId: number,
): void {
  const sections = stdout.split(/^===(CONF|HOSTNAME|LOGPATH|LOG)===\s*$/m);
  // sections: ["", "CONF", "<conf>", "HOSTNAME", "<hostname>", "LOGPATH", "<path>", "LOG", "<log>"]
  const map = new Map<string, string>();
  for (let i = 1; i + 1 < sections.length; i += 2) {
    map.set(sections[i]!, sections[i + 1] ?? "");
  }
  const conf = map.get("CONF")?.trim();
  if (conf) diag.conf = conf;
  else diag.confError = `/etc/pve/lxc/${vmId}.conf not readable`;
  const logPath = map.get("LOGPATH")?.trim();
  if (logPath) diag.logSource = logPath;
  const log = map.get("LOG");
  if (log && !log.startsWith("(log file missing")) {
    diag.log = log;
  } else {
    diag.logError = log?.trim() || "log not captured";
  }
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
