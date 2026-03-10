import { NgZone, OnDestroy, Component, OnInit, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { IVeExecuteMessagesResponse, ISingleExecuteMessagesResponse, IParameterValue, IVeExecuteMessage } from '../../shared/types';
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
  private pollInterval?: number;
  private redirectTimer?: number;
  private countdownInterval?: number;
  private initialExpandedState = new Map<string, boolean>();  // Track initial expanded state per group
  private veConfigurationService = inject(VeConfigurationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private dialog = inject(MatDialog);
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
    this.startPolling();
  }

  ngOnDestroy(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  startPolling() {
    // Fetch immediately, then poll every 5 seconds
    this.fetchMessages();
    this.pollInterval = setInterval(() => this.fetchMessages(), 5000);
  }

  private resumePolling() {
    if (!this.pollInterval) {
      this.startPolling();
    }
  }

  private fetchMessages() {
    this.veConfigurationService.getExecuteMessages().subscribe({
      next: (msgs) => {
        if (msgs && msgs.length > 0) {
          this.zone.run(() => {
            this.mergeMessages(msgs);
            this.checkAllFinished();
          });
        }
      },
      error: () => {
        // Optionally handle error
      }
    });
  }

  private checkAllFinished() {
    if (!this.messages || this.messages.length === 0) return;
    const anyInProgress = this.messages.some(g => this.isInProgress(g));
    if (!anyInProgress && this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;

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
    this.countdownInterval = setInterval(() => {
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

  private mergeMessages(newMsgs: IVeExecuteMessagesResponse) {
    // Store vmInstallKeys
    for (const group of newMsgs) {
      if (group.vmInstallKey && group.restartKey) {
        this.storedVmInstallKeys[group.restartKey] = group.vmInstallKey;
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
      // Merge new messages
      const existingIndices = new Set(existing.messages.map(m => m.index));
      const newMessages = newGroup.messages.filter(m => !existingIndices.has(m.index));
      if (newMessages.length === 0 && !newGroup.vmInstallKey) {
        return existing;
      }
      return {
        ...existing,
        vmInstallKey: newGroup.vmInstallKey || existing.vmInstallKey,
        messages: [...existing.messages, ...newMessages]
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
      // finished with non-zero exit code is an error
      return finishedMsg.exitCode !== 0;
    }
    return group.messages.some(msg => msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0));
  }

  /** Check if group is still in progress (not finished and not errored) */
  isInProgress(group: ISingleExecuteMessagesResponse): boolean {
    const hasFinished = group.messages.some(msg => msg.finished);
    const hasError = group.messages.some(msg => msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0));
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
        this.resumePolling();
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
        this.resumePolling();
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

  close(): void {
    window.history.back();
  }

}