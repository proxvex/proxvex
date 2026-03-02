import {
  IVeExecuteMessagesResponse,
  ISingleExecuteMessagesResponse,
  IVeExecuteMessage,
} from "@src/types.mjs";

const MESSAGE_RETENTION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Manages execution messages, including partial and final message handling,
 * message grouping, and cleanup of old messages.
 */
export class WebAppVeMessageManager {
  messages: IVeExecuteMessagesResponse = [];
  private messageTimestamps: Map<string, number> = new Map(); // key: "app/task"

  /**
   * Cleans up messages older than MESSAGE_RETENTION_MS.
   */
  cleanupOldMessages(): void {
    const now = Date.now();
    const keysToRemove: string[] = [];
    this.messageTimestamps.forEach((timestamp, key) => {
      if (now - timestamp > MESSAGE_RETENTION_MS) {
        keysToRemove.push(key);
      }
    });
    for (const key of keysToRemove) {
      const [app, task] = key.split("/");
      this.messages = this.messages.filter(
        (g) => !(g.application === app && g.task === task),
      );
      this.messageTimestamps.delete(key);
    }
  }

  /**
   * Finds or creates a message group for the given application and task.
   */
  findOrCreateMessageGroup(
    application: string,
    task: string,
    restartKey: string,
  ): ISingleExecuteMessagesResponse {
    let existing = this.messages.find(
      (g) => g.application === application && g.task === task,
    );
    if (!existing) {
      existing = {
        application,
        task,
        messages: [],
        restartKey,
      };
      this.messages.push(existing);
    } else {
      // Always update restartKey so the frontend can restart the latest execution
      existing.restartKey = restartKey;
    }
    return existing;
  }

  /**
   * Updates the error state of a message based on exitCode and error flag.
   */
  private updateErrorState(
    existingMsg: IVeExecuteMessage,
    msg: IVeExecuteMessage,
  ): void {
    // Update exitCode if provided
    if (msg.exitCode !== undefined) {
      existingMsg.exitCode = msg.exitCode;
      // Reset error flag if exitCode is 0 (success)
      if (msg.exitCode === 0) {
        existingMsg.error = undefined;
      }
    }
    // Always update error flag from msg (even if undefined, to clear old errors)
    // This ensures that partial messages without errors clear the error state
    existingMsg.error = msg.error;
  }

  /**
   * Handles a partial message by appending to an existing message.
   * Returns true if the message was handled, false otherwise.
   */
  private handlePartialMessage(
    msg: IVeExecuteMessage,
    existing: ISingleExecuteMessagesResponse,
  ): boolean {
    if (msg.partial !== true) {
      return false;
    }

    // Check index once
    if (msg.index !== undefined) {
      // Try to find existing message by index
      const existingMsg = existing.messages.find((m) => m.index === msg.index);
      if (existingMsg) {
        // Append stderr/stdout to existing message
        existingMsg.stderr = (existingMsg.stderr || "") + (msg.stderr || "");
        if (msg.result) {
          existingMsg.result = (existingMsg.result || "") + (msg.result || "");
        }
        this.updateErrorState(existingMsg, msg);
        return true; // Message handled
      }
    } else {
      // If index is undefined, all existing commands were successful
      // Mark all existing messages as final (all commands were successful)
      for (let i = existing.messages.length - 1; i >= 0; i--) {
        existing.messages[i]!.partial = false;
        existing.messages[i]!.error = undefined;
        existing.messages[i]!.exitCode = 0;
        // Try to append to last message with same command name
        const lastMsg = existing.messages[i];
        if (lastMsg && lastMsg.command === msg.command) {
          // Append stderr/stdout to last message
          lastMsg.stderr = (lastMsg.stderr || "") + (msg.stderr || "");
          if (msg.result) {
            lastMsg.result = (lastMsg.result || "") + (msg.result || "");
          }
        }
        return true; // Message handled
      }
    }

    return false; // Not handled as partial
  }

  /**
   * Handles a final (non-partial) message by replacing or updating an existing message.
   * Returns true if the message was handled, false otherwise.
   */
  private handleFinalMessage(
    msg: IVeExecuteMessage,
    existing: ISingleExecuteMessagesResponse,
  ): boolean {
    if (msg.partial === true) {
      return false;
    }

    // Only handle if message has an index and an existing message with that index exists
    if (msg.index !== undefined) {
      const existingMsg = existing.messages.find((m) => m.index === msg.index);
      if (existingMsg) {
        // Replace existing message with final values
        const index = existing.messages.indexOf(existingMsg);
        if (index >= 0) {
          existing.messages[index] = {
            ...existingMsg,
            ...msg,
            // Preserve accumulated stderr/result from partial messages
            stderr: (existingMsg.stderr || "") + (msg.stderr || ""),
            result: msg.result || existingMsg.result,
            // Reset error flag if exitCode is 0 (success)
            error:
              msg.exitCode === 0
                ? undefined
                : msg.error !== undefined
                  ? msg.error
                  : existingMsg.error,
          };
        }
        return true; // Message handled
      }

      // If no message with this index exists, mark all messages with lower index as final
      // This handles the case where partial messages without index were appended to previous messages
      for (const existingMsg of existing.messages) {
        if (existingMsg.index !== undefined && existingMsg.index < msg.index) {
          existingMsg.partial = false;
          // If exitCode is still -1 (from partial messages), set it to 0 (success) if the final message succeeded
          if (existingMsg.exitCode === -1 && msg.exitCode === 0) {
            existingMsg.exitCode = 0;
            existingMsg.error = undefined;
          }
        }
      }
    }

    return false; // Not handled as final
  }

  /**
   * Handles incoming execution messages and updates the messages array.
   * Merges partial messages with existing ones and handles final message updates.
   */
  handleExecutionMessage(
    msg: IVeExecuteMessage,
    application: string,
    task: string,
    restartKey: string,
  ): void {
    // Common: Find or create message group
    const existing = this.findOrCreateMessageGroup(
      application,
      task,
      restartKey,
    );

    // Try to handle as partial message first
    if (this.handlePartialMessage(msg, existing)) {
      return; // Message was handled
    }

    // Try to handle as final message
    if (this.handleFinalMessage(msg, existing)) {
      return; // Message was handled
    }

    // Common: Add as new message if not handled yet
    existing.messages.push(msg);
  }

  /**
   * Clears old messages for a specific application/task and sets timestamp.
   */
  clearMessagesForApplication(application: string, task: string): void {
    this.messages = this.messages.filter(
      (g) => !(g.application === application && g.task === task),
    );
    const messageKey = `${application}/${task}`;
    this.messageTimestamps.set(messageKey, Date.now());
  }

  /**
   * Finds a message group by restart key.
   */
  findMessageGroupByRestartKey(
    restartKey: string,
  ): ISingleExecuteMessagesResponse | undefined {
    return this.messages.find((g) => g.restartKey === restartKey);
  }

  /**
   * Sets vmInstallKey for a message group by application and task.
   */
  setVmInstallKeyForGroup(
    application: string,
    task: string,
    vmInstallKey: string,
  ): void {
    const group = this.messages.find(
      (g) => g.application === application && g.task === task,
    );
    if (group) {
      group.vmInstallKey = vmInstallKey;
    }
  }
}
