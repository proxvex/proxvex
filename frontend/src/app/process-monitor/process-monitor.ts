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
import { CommandsTableComponent } from '../shared/components/commands-table/commands-table';
import { ICommandRow } from '../shared/components/commands-table/commands-table.types';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatIconModule, MatButtonModule, CommandsTableComponent],
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
  private initialExpandedState = new Map<string, boolean>();
  private veConfigurationService = inject(VeConfigurationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private dialog = inject(MatDialog);
  private el = inject(ElementRef);
  private lastSeenIndex = -1;
  private storedParams: Record<string, { name: string; value: IParameterValue }[]> = {};
  private storedVmInstallKeys: Record<string, string> = {};

  ngOnInit() {
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

  // --- CommandsTable integration ---

  private stepBadges(name: string, step?: IPlannedStep): { label: string; cls: string }[] {
    const badges: { label: string; cls: string }[] = [];
    const isSkipped = name.includes('(skipped)');
    if (isSkipped) badges.push({ label: 'skipped', cls: 'badge-skipped' });
    if (step?.isShared !== undefined) {
      badges.push(step.isShared
        ? { label: 'shared', cls: 'badge-shared' }
        : { label: 'app', cls: 'badge-app' });
    }
    if (step?.isLocal) {
      badges.push({ label: 'local', cls: 'badge-local' });
    }
    if ((step as any)?.isHub) {
      badges.push({ label: 'hub', cls: 'badge-hub' });
    }
    return badges;
  }

  private findPlannedStep(group: ISingleExecuteMessagesResponse, cmdName: string): IPlannedStep | undefined {
    if (!group.plannedSteps) return undefined;
    return group.plannedSteps.find(s => s.name === cmdName || s.name.replace(/\s*\(skipped\)\s*$/, '') === cmdName);
  }

  buildCommandRows(group: ISingleExecuteMessagesResponse): ICommandRow[] {
    const rows: ICommandRow[] = [];
    let seq = 1;
    let prevName = '';

    for (const msg of group.messages) {
      if (msg.finished) continue;

      const cmdName = msg.command || msg.commandtext || 'Unknown';
      const cleanName = cmdName.replace(/\s*\(skipped\)\s*$/, '');

      // Collapse consecutive commands with same name (e.g. properties-only templates)
      if (cleanName === prevName && rows.length > 0) continue;
      prevName = cleanName;

      const isSkipped = cmdName.includes('(skipped)') || msg.result === 'skipped';
      const step = this.findPlannedStep(group, cmdName);

      const status = msg.partial
        ? 'running' as const
        : (msg.exitCode !== undefined && msg.exitCode !== 0)
          ? 'failed' as const
          : 'completed' as const;

      rows.push({
        seq: seq++,
        name: cleanName,
        badges: this.stepBadges(cmdName, step),
        skipped: isSkipped,
        details: [],
        status,
        hasStderr: !msg.partial && !!msg.stderr,
        liveStderr: msg.partial ? msg.stderr : undefined,
      });
    }

    // Pending steps
    prevName = rows.length > 0 ? rows[rows.length - 1]!.name : '';
    for (const step of this.getPendingSteps(group)) {
      const cleanName = step.name.replace(/\s*\(skipped\)\s*$/, '');
      if (cleanName === prevName) continue;
      prevName = cleanName;

      const isStepSkipped = step.name.includes('(skipped)');
      rows.push({
        seq: seq++,
        name: cleanName,
        badges: this.stepBadges(step.name, step),
        skipped: isStepSkipped,
        details: [],
        status: 'pending',
      });
    }

    return rows;
  }

  onStderrClick(cmd: ICommandRow, group: ISingleExecuteMessagesResponse): void {
    const msg = group.messages.find(m => (m.command || m.commandtext) === cmd.name);
    if (msg) {
      this.openStderrDialog(msg);
    }
  }

  getRunningStderr(group: ISingleExecuteMessagesResponse): string | null {
    const running = group.messages.find(m => m.partial);
    return running?.stderr || null;
  }

  getFailedMessage(group: ISingleExecuteMessagesResponse): IVeExecuteMessage | null {
    return group.messages.find(m => !m.partial && !m.finished && m.exitCode !== undefined && m.exitCode !== 0) ?? null;
  }

  getFinishedMessage(group: ISingleExecuteMessagesResponse): IVeExecuteMessage | null {
    return group.messages.find(m => m.finished) ?? null;
  }

  // --- Streaming & message management (unchanged) ---

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
        });
      },
      complete: () => {
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
    if (msg.index !== undefined && msg.index > this.lastSeenIndex) {
      this.lastSeenIndex = msg.index;
    }

    if (!this.messages) {
      this.messages = [{ application, task, messages: [msg] }];
      return;
    }

    const groupIdx = this.messages.findIndex(
      g => g.application === application && g.task === task
    );
    if (groupIdx < 0) {
      this.messages = [...this.messages, { application, task, messages: [msg] }];
      return;
    }

    const group = this.messages[groupIdx]!;

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
        const newGroups = [...this.messages];
        newGroups[groupIdx] = { ...group, messages: [...group.messages, msg] };
        this.messages = newGroups;
      }
      return;
    }

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

    const newGroups = [...this.messages];
    newGroups[groupIdx] = { ...group, messages: [...group.messages, msg] };
    this.messages = newGroups;
  }

  private mergeMessages(newMsgs: IVeExecuteMessagesResponse) {
    for (const group of newMsgs) {
      if (group.vmInstallKey && group.restartKey) {
        this.storedVmInstallKeys[group.restartKey] = group.vmInstallKey;
      }
    }

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

    this.messages = this.messages.map(existing => {
      const newGroup = newMsgs.find(
        g => g.application === existing.application && g.task === existing.task
      );
      if (!newGroup) {
        return existing;
      }
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

    for (const newGroup of newMsgs) {
      const exists = this.messages.some(
        g => g.application === newGroup.application && g.task === newGroup.task
      );
      if (!exists) {
        this.messages = [...this.messages, { ...newGroup }];
      }
    }
  }

  // --- Group state helpers ---

  hasError(group: ISingleExecuteMessagesResponse): boolean {
    const finishedMsg = group.messages.find(msg => msg.finished);
    if (finishedMsg) {
      return finishedMsg.exitCode !== 0;
    }
    return group.messages.some(msg => !msg.partial && (msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0)));
  }

  isInProgress(group: ISingleExecuteMessagesResponse): boolean {
    const hasFinished = group.messages.some(msg => msg.finished);
    const hasError = group.messages.some(msg => !msg.partial && (msg.error || (msg.exitCode !== undefined && msg.exitCode !== 0)));
    return !hasFinished && !hasError;
  }

  shouldBeExpanded(group: ISingleExecuteMessagesResponse): boolean {
    const key = `${group.application}:${group.task}`;
    if (!this.initialExpandedState.has(key)) {
      this.initialExpandedState.set(key, this.isInProgress(group));
    }
    return this.initialExpandedState.get(key)!;
  }

  // --- Actions ---

  triggerRestart(group: ISingleExecuteMessagesResponse) {
    if (!group.restartKey) return;
    this.veConfigurationService.restartExecution(group.restartKey).subscribe({
      next: () => {
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
    const vmInstallKey = group.vmInstallKey || this.storedVmInstallKeys[group.restartKey];
    if (!vmInstallKey) {
      console.error('vmInstallKey not found for restart key:', group.restartKey);
      alert('Installation context not found. Please start installation again.');
      return;
    }
    this.veConfigurationService.restartInstallation(vmInstallKey).subscribe({
      next: (response) => {
        if (response.vmInstallKey && group.restartKey) {
          this.storedVmInstallKeys[group.restartKey] = response.vmInstallKey;
        }
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

  downloadLogs(group: ISingleExecuteMessagesResponse): void {
    const data = {
      application: group.application,
      task: group.task,
      exportedAt: new Date().toISOString(),
      status: this.hasError(group) ? 'error' : 'success',
      plannedSteps: group.plannedSteps ?? [],
      messages: group.messages,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${group.application}-${group.task}-logs.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  close(): void {
    window.history.back();
  }
}
