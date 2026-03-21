import { NgZone, OnDestroy, Component, OnInit, inject, ElementRef } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { IVeExecuteMessagesResponse, ISingleExecuteMessagesResponse, IParameterValue, IVeExecuteMessage, IPlannedStep } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import { StderrDialogComponent } from './stderr-dialog.component';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatIconModule, MatButtonModule],
  templateUrl: './process-monitor.html',
  styleUrl: './process-monitor.scss',
})
export class ProcessMonitor implements OnInit, OnDestroy {
  messages: IVeExecuteMessagesResponse | undefined;
  redirectUrl?: string;
  redirectCountdown = 0;
  private sseSubscription?: Subscription;
  private redirectTimer?: number;
  private countdownInterval?: number;
  private initialExpandedState = new Map<string, boolean>();  // Track initial expanded state per group
  private veConfigurationService = inject(VeConfigurationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private dialog = inject(MatDialog);
  private el = inject(ElementRef);
  private lastSeenIndex = -1;
  private storedParams: Record<string, { name: string; value: IParameterValue }[]> = {};
  private storedVmInstallKeys: Record<string, string> = {}; // Map from restartKey to vmInstallKey

  ngOnInit() {
    // Get original parameters and vmInstallKey from navigation state
    // Try getCurrentNavigation first (during navigation), then history.state (after navigation)
    const navigation = this.router.getCurrentNavigation();
    const state = (navigation?.extras?.state || history.state) as { 
      originalParams?: { name: string; value: IParameterValue }[], 
      restartKey?: string,
      vmInstallKey?: string
    } | null;
    if (state?.originalParams && state.restartKey) {
      this.storedParams[state.restartKey] = state.originalParams;
    }
    if (state?.vmInstallKey && state.restartKey) {
      this.storedVmInstallKeys[state.restartKey] = state.vmInstallKey;
    }
    this.startStreaming();
  }

  ngOnDestroy(): void {
    this.stopStreaming();
    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  private startStreaming() {
    this.stopStreaming();
    this.sseSubscription = this.veConfigurationService.streamExecuteMessages().subscribe({
      next: (event) => {
        this.zone.run(() => {
          if (event.type === 'snapshot') {
            this.mergeMessages(event.data);
          } else {
            this.mergeSingleMessage(event.data.application, event.data.task, event.data.message);
          }
          this.checkAllFinished();
          this.scrollToActivePanel();
        });
      },
      complete: () => {
        // SSE connection permanently closed — fall back to single poll
        this.fetchMessagesFallback();
      }
    });
  }

  private stopStreaming() {
    if (this.sseSubscription) {
      this.sseSubscription.unsubscribe();
      this.sseSubscription = undefined;
    }
  }

  private resumeStreaming() {
    if (!this.sseSubscription) {
      this.startStreaming();
    }
  }

  private fetchMessagesFallback() {
    const since = this.lastSeenIndex >= 0 ? this.lastSeenIndex : undefined;
    this.veConfigurationService.getExecuteMessages(since).subscribe({
      next: (msgs) => {
        if (msgs && msgs.length > 0) {
          this.zone.run(() => {
            this.mergeMessages(msgs);
            this.checkAllFinished();
          });
        }
      },
      error: () => { /* ignore fallback errors */ }
    });
  }

  private checkAllFinished() {
    if (!this.messages || this.messages.length === 0) return;
    const anyInProgress = this.messages.some(g => this.isInProgress(g));
    if (!anyInProgress && this.sseSubscription) {
      this.stopStreaming();

      // Check for redirect URL in finished messages
      if (!this.redirectUrl) {
        for (const group of this.messages) {
          const finishedMsg = group.messages.find(m => m.finished && m.redirectUrl);
          if (finishedMsg?.redirectUrl) {
            this.startRedirect(finishedMsg.redirectUrl);
            break;
          }
        }
      }
    }
  }

  private startRedirect(url: string): void {
    this.redirectUrl = url;
    this.redirectCountdown = 10;
    this.countdownInterval = window.setInterval(() => {
      this.zone.run(() => {
        this.redirectCountdown--;
        if (this.redirectCountdown <= 0 && this.countdownInterval) {
          clearInterval(this.countdownInterval);
          this.countdownInterval = undefined;
        }
      });
    }, 1000) as unknown as number;
    this.redirectTimer = setTimeout(() => {
      window.location.href = url;
    }, 10000) as unknown as number;
  }

  redirectNow(): void {
    if (this.redirectUrl) {
      window.location.href = this.redirectUrl;
    }
  }

  private mergeSingleMessage(application: string, task: string, msg: IVeExecuteMessage) {
    // Track index
    if (msg.index !== undefined && msg.index > this.lastSeenIndex) {
      this.lastSeenIndex = msg.index;
    }

    if (!this.messages) {
      this.messages = [{ application, task, messages: [msg] }];
      return;
    }

    // Find existing group
    const groupIdx = this.messages.findIndex(
      g => g.application === application && g.task === task
    );
    if (groupIdx < 0) {
      this.messages = [...this.messages, { application, task, messages: [msg] }];
      return;
    }

    const group = this.messages[groupIdx]!;

    // Partial message (no index): find or create a partial entry by command name
    if (msg.partial) {
      const existingIdx = group.messages.findIndex(m => m.partial && m.command === msg.command);
      if (existingIdx >= 0) {
        const existingMsg = group.messages[existingIdx]!;
        const updated = {
          ...existingMsg,
          stderr: (existingMsg.stderr || '') + (msg.stderr || ''),
          result: msg.result ? (existingMsg.result || '') + msg.result : existingMsg.result,
        };
        const newMessages = [...group.messages];
        newMessages[existingIdx] = updated;
        const newGroups = [...this.messages];
        newGroups[groupIdx] = { ...group, messages: newMessages };
        this.messages = newGroups;
      } else {
        // New partial — append
        const newGroups = [...this.messages];
        newGroups[groupIdx] = { ...group, messages: [...group.messages, msg] };
        this.messages = newGroups;
      }
      return;
    }

    // Final message: replace the partial entry for the same command (if any)
    const partialIdx = group.messages.findIndex(m => m.partial && m.command === msg.command);
    if (partialIdx >= 0) {
      const partialMsg = group.messages[partialIdx]!;
      const updated = {
        ...msg,
        stderr: (partialMsg.stderr || '') + (msg.stderr || ''),
        result: msg.result || partialMsg.result,
      };
      const newMessages = [...group.messages];
      newMessages[partialIdx] = updated;
      const newGroups = [...this.messages];
      newGroups[groupIdx] = { ...group, messages: newMessages };
      this.messages = newGroups;
      return;
    }

    // Final message with index: try to find by index
    if (msg.index !== undefined) {
      const existingMsgIdx = group.messages.findIndex(m => m.index === msg.index);
      if (existingMsgIdx >= 0) {
        const existingMsg = group.messages[existingMsgIdx]!;
        const updated = {
          ...existingMsg,
          ...msg,
          stderr: (existingMsg.stderr || '') + (msg.stderr || ''),
          result: msg.result || existingMsg.result,
        };
        const newMessages = [...group.messages];
        newMessages[existingMsgIdx] = updated;
        const newGroups = [...this.messages];
        newGroups[groupIdx] = { ...group, messages: newMessages };
        this.messages = newGroups;
        return;
      }
    }

    // New message — append
    const newGroups = [...this.messages];
    newGroups[groupIdx] = { ...group, messages: [...group.messages, msg] };
    this.messages = newGroups;
  }

  private mergeMessages(newMsgs: IVeExecuteMessagesResponse) {
    // Store vmInstallKeys
    for (const group of newMsgs) {
      if (group.vmInstallKey && group.restartKey) {
        this.storedVmInstallKeys[group.restartKey] = group.vmInstallKey;
      }
    }

    // Track highest seen index for delta-polling
    for (const group of newMsgs) {
      for (const msg of group.messages) {
        if (msg.index !== undefined && msg.index > this.lastSeenIndex) {
          this.lastSeenIndex = msg.index;
        }
      }
    }

    if (!this.messages) {
      this.messages = [...newMsgs];
      return;
    }

    // Create new array (immutable update) to avoid NG0100 errors
    this.messages = this.messages.map(existing => {
      const newGroup = newMsgs.find(
        g => g.application === existing.application && g.task === existing.task
      );
      if (!newGroup) {
        return existing;
      }
      // With delta-polling, new messages are guaranteed to be new — just append
      const hasNewMessages = newGroup.messages.length > 0;
      const hasNewPlannedSteps = newGroup.plannedSteps && !existing.plannedSteps;
      if (!hasNewMessages && !newGroup.vmInstallKey && !hasNewPlannedSteps) {
        return existing;
      }
      return {
        ...existing,
        plannedSteps: newGroup.plannedSteps || existing.plannedSteps,
        vmInstallKey: newGroup.vmInstallKey || existing.vmInstallKey,
        messages: [...existing.messages, ...newGroup.messages]
      };
    });

    // Add completely new groups
    for (const newGroup of newMsgs) {
      const exists = this.messages.some(
        g => g.application === newGroup.application && g.task === newGroup.task
      );
      if (!exists) {
        this.messages = [...this.messages, { ...newGroup }];
      }
    }
  }

  hasError(group: ISingleExecuteMessagesResponse): boolean {
    const finishedMsg = group.messages.find(msg => msg.finished);
    if (finishedMsg) {
      return finishedMsg.exitCode !== 0;
    }
    return group.messages.some(msg => !msg.partial && (msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0)));
  }

  /** Check if group is still in progress (not finished and not errored) */
  isInProgress(group: ISingleExecuteMessagesResponse): boolean {
    const hasFinished = group.messages.some(msg => msg.finished);
    const hasError = group.messages.some(msg => !msg.partial && (msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0)));
    return !hasFinished && !hasError;
  }

  /** Get initial expanded state for a group (only computed once per group) */
  shouldBeExpanded(group: ISingleExecuteMessagesResponse): boolean {
    const key = `${group.application}:${group.task}`;
    if (!this.initialExpandedState.has(key)) {
      // First time seeing this group - store initial state based on whether it's in progress
      this.initialExpandedState.set(key, this.isInProgress(group));
    }
    return this.initialExpandedState.get(key)!;
  }

  triggerRestart(group: ISingleExecuteMessagesResponse) {
    if (!group.restartKey) return;

    // Parameters are contained in the restart context, no need to send them
    this.veConfigurationService.restartExecution(group.restartKey).subscribe({
      next: () => {
        // Clear old messages for this group to show fresh run (immutable)
        if (this.messages) {
          this.messages = this.messages.filter(
            g => !(g.application === group.application && g.task === group.task)
          );
        }
        this.lastSeenIndex = -1;
        this.resumeStreaming();
      },
      error: (err) => {
        console.error('Restart failed:', err);
      }
    });
  }

  triggerRestartFull(group: ISingleExecuteMessagesResponse) {
    if (!group.restartKey) return;
    
    // Try to get vmInstallKey from group (from backend response) or stored state
    const vmInstallKey = group.vmInstallKey || this.storedVmInstallKeys[group.restartKey];
    
    if (!vmInstallKey) {
      console.error('vmInstallKey not found for restart key:', group.restartKey);
      alert('Installation context not found. Please start installation again.');
      return;
    }
    
    // Use the new restartInstallation endpoint with vmInstallKey
    this.veConfigurationService.restartInstallation(vmInstallKey).subscribe({
      next: (response) => {
        // Update stored vmInstallKey if returned in response
        if (response.vmInstallKey && group.restartKey) {
          this.storedVmInstallKeys[group.restartKey] = response.vmInstallKey;
        }
        // Clear old messages for this group to show fresh run (immutable)
        if (this.messages) {
          this.messages = this.messages.filter(
            g => !(g.application === group.application && g.task === group.task)
          );
        }
        this.lastSeenIndex = -1;
        this.resumeStreaming();
      },
      error: (err) => {
        console.error('Restart from beginning failed:', err);
      }
    });
  }

  openStderrDialog(msg: IVeExecuteMessage): void {
    if (!msg.stderr) return;
    
    this.dialog.open(StderrDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      data: {
        command: msg.command || msg.commandtext || 'Unknown command',
        stderr: msg.stderr,
        exitCode: msg.exitCode
      }
    });
  }

  getPendingSteps(group: ISingleExecuteMessagesResponse): IPlannedStep[] {
    if (!group.plannedSteps) return [];
    const completedNames = new Set(
      group.messages.filter(m => m.exitCode === 0 || m.partial).map(m => m.command)
    );
    return group.plannedSteps.filter(step => !completedNames.has(step.name));
  }

  getCompletedCount(group: ISingleExecuteMessagesResponse): number {
    return group.messages.filter(m => m.exitCode === 0 && !m.finished).length;
  }

  private scrollToActivePanel(): void {
    setTimeout(() => {
      const container = this.el.nativeElement as HTMLElement;
      const runningItem = container.querySelector('.running-item');
      if (!runningItem) return;
      const panel = runningItem.closest('mat-expansion-panel');
      const header = panel?.querySelector('mat-expansion-panel-header');
      if (header) {
        header.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  close(): void {
    window.history.back();
  }

}