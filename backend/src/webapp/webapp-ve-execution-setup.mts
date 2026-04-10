import { IVEContext, IVMContext } from "@src/backend-types.mjs";
import { ICommand, IPlannedStep, IVeExecuteMessage } from "@src/types.mjs";
import { IProcessedTemplate } from "@src/templates/templateprocessor-types.mjs";
import { IRestartInfo } from "@src/ve-execution/ve-execution-constants.mjs";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";

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

    exec.on("message", (msg: IVeExecuteMessage) => {
      messageManager.handleExecutionMessage(msg, application, task, restartKey);
    });
    exec.on("finished", (msg: IVMContext) => {
      veContext.getStorageContext().setVMContext(msg);
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
    const templateInfo = new Map<string, { isShared: boolean; isLocal: boolean }>();
    if (processedTemplates) {
      for (const pt of processedTemplates) {
        const isLocal = pt.path.startsWith("local/");
        templateInfo.set(pt.name, { isShared: pt.isShared, isLocal });
        // Also map by template display name for matching against command names
        if (pt.templateData?.name) {
          templateInfo.set(pt.templateData.name, { isShared: pt.isShared, isLocal });
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
