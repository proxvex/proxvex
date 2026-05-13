import { IVEContext, IVMContext } from "@src/backend-types.mjs";
import { ICommand, IPlannedStep, IVeExecuteMessage } from "@src/types.mjs";
import { IProcessedTemplate } from "@src/templates/templateprocessor-types.mjs";
import { IRestartInfo } from "@src/ve-execution/ve-execution-constants.mjs";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { Logger } from "@src/logger/index.mjs";
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
        debugCollector.finish(restartKey);
        Logger.setDebugSink(null);
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
