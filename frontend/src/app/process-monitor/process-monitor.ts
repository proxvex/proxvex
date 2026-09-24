import { NgZone, OnDestroy, Component, OnInit, inject, ElementRef } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription, firstValueFrom } from 'rxjs';
import JSZip from 'jszip';
import { IVeExecuteMessagesResponse, ISingleExecuteMessagesResponse, IParameterValue, IVeExecuteMessage, IPlannedStep } from '../../shared/types';

/**
 * localStorage shape for the cross-redirect diagnosis rescue. One entry per
 * restartKey; the auto-download cleans up entries on success or after
 * PENDING_MAX_AGE_MS / PENDING_MAX_ATTEMPTS exhaustion. Surviving entries are
 * picked up by `tryAutoDownloadPendingDiagnosis` on the next page load.
 */
interface IPendingDiagnosisEntry {
  restartKey: string;
  application: string;
  task: string;
  /** ms-since-epoch when the entry was first written. */
  timestamp: number;
  /** Successful HTTP fetch attempts since persisting. Bounded by PENDING_MAX_ATTEMPTS. */
  attempts: number;
  /** Set after a successful zip download — entry is removed on the next sweep. */
  downloaded: boolean;
}
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
  switchoverScheduled = false;
  /** Gewaehlter Proxmox-Host — steht in der Ueberschrift, damit man sieht,
   *  wohin der Lauf geht. Leer, solange keiner gewaehlt ist. */
  targetHost = '';
  private sseSubscription?: Subscription;
  private hostSubscription?: Subscription;
  private redirectTimer?: number;
  private countdownInterval?: number;
  private initialExpandedState = new Map<string, boolean>();
  private veConfigurationService = inject(VeConfigurationService);
  private http = inject(HttpClient);
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
    this.watchHost();
    // Self-upgrade rescue: if a previous task on the OLD deployer marked its
    // diagnosis as "pending" (via persistPendingDiagnosis at completion),
    // try to fetch it from THIS deployer now. After the redirect the NEW CT
    // serves the adopted Clone bundle under the same restartKey.
    this.tryAutoDownloadPendingDiagnosis();
  }

  ngOnDestroy(): void {
    this.stopStreaming();
    this.hostSubscription?.unsubscribe();
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

  /**
   * Wechselt der Host in der Kopfzeile, zeigt der Monitor sonst weiter die
   * Meldungen des alten Ziels — der SSE-Strom haengt am veContext des alten
   * Hosts und laeuft einfach weiter. Deshalb: Strom trennen, Anzeige leeren
   * und neu verbinden. Der Zaehler lastSeenIndex gehoert zum alten Host und
   * muss mit zurueckgesetzt werden, sonst verschluckt das Delta-Polling die
   * ersten Meldungen des neuen Ziels.
   *
   * Der erste Wert kommt sofort (BehaviorSubject) und ist nur das Setzen der
   * Ueberschrift — dort wird nicht neu verbunden, das hat ngOnInit schon getan.
   */
  private watchHost() {
    let known: string | undefined;
    this.hostSubscription = this.veConfigurationService.currentHost$.subscribe(host => {
      this.zone.run(() => {
        const previous = known;
        known = host;
        this.targetHost = host;
        // Vom Nichts zu einem Host ist kein Wechsel, sondern der Start:
        // die App-Shell laedt die SSH-Konfiguration asynchron, bei einem
        // direkten Aufruf von /process-monitor trifft der Host also erst
        // nach ngOnInit ein. Wuerde das schon als Wechsel zaehlen, wuerde
        // der Monitor die gerade angezeigten Meldungen wegwerfen.
        if (previous === undefined || previous === '') {
          return;
        }
        this.stopStreaming();
        this.messages = undefined;
        this.lastSeenIndex = -1;
        this.initialExpandedState.clear();
        if (host) {
          this.startStreaming();
        }
      });
    });
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
      // On completion: stash each group's restartKey + metadata in
      // localStorage so a redirect (self-upgrade) doesn't lose the handle
      // to the diagnosis bundle. Then trigger one immediate download attempt
      // from THIS deployer — works for normal tasks and for self-upgrade IF
      // the OUTER's clone-bundle adoption (self-upgrade-orchestrator) has
      // already landed by the time we get here. On failure (404), the entry
      // stays pending; ngOnInit after redirect re-tries against the NEW CT.
      for (const group of this.messages) {
        if (group.restartKey) {
          this.persistPendingDiagnosis(group);
          void this.tryDownloadDiagnosisOnce(group.restartKey, group.application, group.task);
        }
      }
      if (!this.redirectUrl) {
        for (const group of this.messages) {
          const finishedMsg = group.messages.find(m => m.finished && m.redirectUrl);
          if (finishedMsg?.redirectUrl) {
            this.startRedirect(
              finishedMsg.redirectUrl,
              finishedMsg.switchoverScheduled === true,
            );
            break;
          }
        }
      }
    }
  }

  // ---- Pending-diagnosis localStorage rescue (cross-redirect download) ----

  private static readonly PENDING_KEY = 'proxvex_pending_diagnosis_v1';
  private static readonly PENDING_MAX_AGE_MS = 30 * 60_000; // backend retention
  private static readonly PENDING_MAX_ATTEMPTS = 5;
  /** restartKeys already probed in THIS page session — prevents the OLD-entry
   *  404 from spamming the console on every checkAllFinished tick. After a
   *  hard reload the set is empty and we get one fresh attempt per entry. */
  private attemptedThisSession = new Set<string>();

  private persistPendingDiagnosis(group: ISingleExecuteMessagesResponse): void {
    if (!group.restartKey) return;
    try {
      const list = this.readPendingList();
      const without = list.filter(e => e.restartKey !== group.restartKey);
      without.push({
        restartKey: group.restartKey,
        application: group.application,
        task: group.task,
        timestamp: Date.now(),
        attempts: 0,
        downloaded: false,
      });
      // Drop entries older than retention window to keep storage tidy.
      const fresh = without.filter(
        e => Date.now() - e.timestamp < ProcessMonitor.PENDING_MAX_AGE_MS,
      );
      localStorage.setItem(ProcessMonitor.PENDING_KEY, JSON.stringify(fresh));
    } catch {
      // localStorage can throw (quota, private browsing); never block on it.
    }
  }

  private readPendingList(): IPendingDiagnosisEntry[] {
    try {
      const raw = localStorage.getItem(ProcessMonitor.PENDING_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writePendingList(list: IPendingDiagnosisEntry[]): void {
    try {
      localStorage.setItem(ProcessMonitor.PENDING_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  private markDownloaded(restartKey: string): void {
    const list = this.readPendingList().filter(e => e.restartKey !== restartKey);
    this.writePendingList(list);
  }

  private incrementAttempt(restartKey: string): void {
    const list = this.readPendingList();
    const entry = list.find(e => e.restartKey === restartKey);
    if (entry) {
      entry.attempts++;
      this.writePendingList(list);
    }
  }

  /** Try to fetch+download the diagnosis for a known restartKey. No-op on 404. */
  private async tryDownloadDiagnosisOnce(
    restartKey: string,
    application: string,
    task: string,
  ): Promise<void> {
    // De-dupe within the page session: each restartKey gets one attempt per
    // page-load. Without this, checkAllFinished (fires per SSE batch) re-tries
    // every group's restartKey on every tick — and stale entries in
    // this.messages keep producing 404s in the console.
    if (this.attemptedThisSession.has(restartKey)) return;
    this.attemptedThisSession.add(restartKey);
    try {
      const key = encodeURIComponent(restartKey);
      const manifest = await firstValueFrom(
        this.http.get<{ files?: string[] }>(`/api/ve/debug/${key}`),
      );
      const files = manifest?.files ?? [];
      if (files.length === 0) {
        this.incrementAttempt(restartKey);
        return;
      }
      // Build a synthetic group-like object so downloadDiagnosis can reuse
      // its zip-building logic. messages/plannedSteps may be missing here
      // (after a hard redirect the in-memory state is gone) — downloadDiagnosis
      // tolerates empty arrays in those fields.
      const matched = this.messages?.find(g => g.restartKey === restartKey);
      const groupLike = matched ?? {
        application, task, restartKey,
        messages: [], plannedSteps: [],
      } as ISingleExecuteMessagesResponse;
      await this.downloadDiagnosis(groupLike);
      this.markDownloaded(restartKey);
    } catch {
      // 404 (bundle not ready yet) or network failure — keep entry pending,
      // bump attempts so we eventually give up.
      this.incrementAttempt(restartKey);
    }
  }

  /** Called from ngOnInit. Walks pending entries, fetches what's ready. */
  private tryAutoDownloadPendingDiagnosis(): void {
    const list = this.readPendingList();
    const now = Date.now();
    const stale: string[] = [];
    for (const entry of list) {
      if (entry.downloaded) { stale.push(entry.restartKey); continue; }
      if (now - entry.timestamp >= ProcessMonitor.PENDING_MAX_AGE_MS) {
        stale.push(entry.restartKey);
        continue;
      }
      if (entry.attempts >= ProcessMonitor.PENDING_MAX_ATTEMPTS) {
        stale.push(entry.restartKey);
        continue;
      }
      void this.tryDownloadDiagnosisOnce(
        entry.restartKey, entry.application, entry.task,
      );
    }
    if (stale.length > 0) {
      const remaining = list.filter(e => !stale.includes(e.restartKey));
      this.writePendingList(remaining);
    }
  }

  // Deployer self-upgrade: the new deployer needs ~15-20s to boot, SSH
  // back to the PVE host and stop the old one. The browser must wait that
  // long before navigating, otherwise it hits the old (about-to-die)
  // deployer on the shared static IP.
  private static readonly REDIRECT_COUNTDOWN_DEFAULT = 10;
  private static readonly REDIRECT_COUNTDOWN_SWITCHOVER = 25;

  private startRedirect(url: string, switchoverScheduled = false): void {
    this.redirectUrl = url;
    this.switchoverScheduled = switchoverScheduled;
    this.redirectCountdown = switchoverScheduled
      ? ProcessMonitor.REDIRECT_COUNTDOWN_SWITCHOVER
      : ProcessMonitor.REDIRECT_COUNTDOWN_DEFAULT;
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
    }, this.redirectCountdown * 1000) as unknown as number;
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

  /**
   * Bundles everything that helps debug a task — execution logs (the previous
   * downloadLogs payload) plus the backend's debug bundle (same files the
   * livetest runner pulls into `livetest-results/<runId>/<scenarioId>/`).
   *
   * The backend bundle is fetched via `GET /api/ve/debug/<restartKey>` (lists
   * files) and `GET /api/ve/debug/<restartKey>/<file>` (file content). It's
   * only populated when the task ran with `debug_level != "off"` — UI-
   * triggered runs default to `extLog` in the route handler, so the bundle
   * is usually available. Bundle is in-memory on the backend with a 30-min
   * retention; expect 404s on older runs.
   *
   * Output is a zip:
   *   logs.json           — execution log (same shape as the old export)
   *   README.txt          — short note + status of the backend bundle fetch
   *   debug/<files…>      — backend debug bundle (when available)
   */
  async downloadDiagnosis(group: ISingleExecuteMessagesResponse): Promise<void> {
    const logsBlob = {
      application: group.application,
      task: group.task,
      exportedAt: new Date().toISOString(),
      status: this.hasError(group) ? 'error' : 'success',
      restartKey: group.restartKey,
      vmInstallKey: group.vmInstallKey,
      plannedSteps: group.plannedSteps ?? [],
      messages: group.messages,
    };

    const zip = new JSZip();
    zip.file('logs.json', JSON.stringify(logsBlob, null, 2));

    let bundleNote: string;
    let bundleFileCount = 0;
    if (group.restartKey) {
      try {
        const key = encodeURIComponent(group.restartKey);
        const manifest = await firstValueFrom(
          this.http.get<{ files?: string[] }>(`/api/ve/debug/${key}`)
        );
        const files = manifest?.files ?? [];
        for (const file of files) {
          try {
            const content = await firstValueFrom(
              this.http.get(`/api/ve/debug/${key}/${file}`, {
                responseType: 'text',
              })
            );
            zip.file(`debug/${file}`, content);
            bundleFileCount++;
          } catch {
            // Skip individual file failures — keep what we have so the user
            // still gets a partial bundle rather than a hard failure.
          }
        }
        bundleNote = bundleFileCount > 0
          ? `Backend debug bundle: ${bundleFileCount} file(s) included under debug/.\nStart at debug/index.md for the per-script trace.`
          : 'Backend debug bundle was empty (debug_level=off or bundle expired).';
      } catch {
        bundleNote = 'Backend debug bundle unavailable — debug_level was off, or the 30-min retention window expired.';
      }
    } else {
      bundleNote = 'No restartKey on this task — backend debug bundle skipped.';
    }
    zip.file('README.txt',
      `Diagnosis bundle\n` +
      `================\n` +
      `Application : ${group.application}\n` +
      `Task        : ${group.task}\n` +
      `Status      : ${this.hasError(group) ? 'error' : 'success'}\n` +
      `Exported at : ${new Date().toISOString()}\n` +
      `RestartKey  : ${group.restartKey ?? '—'}\n\n` +
      `Contents:\n` +
      `  logs.json       — execution log (commands + stdout/stderr per step)\n` +
      `  debug/          — backend debug bundle (when available)\n\n` +
      bundleNote + '\n');

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${group.application}-${group.task}-diagnosis.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  close(): void {
    window.history.back();
  }
}
