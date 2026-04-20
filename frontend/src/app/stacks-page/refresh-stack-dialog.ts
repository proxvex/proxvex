import { Component, inject, signal } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { IStack } from '../../shared/types';

interface IRefreshAction {
  varName: string;
  replacement:
    | 'compose-env'
    | 'lxc-config-env'
    | 'on-start-env'
    | 'rerun-template'
    | 'manual'
    | 'no-action'
    | string;
  source: { kind: 'application' | 'addon'; applicationId?: string; addonId?: string };
  composeKey?: string;
  lxcVarName?: string;
  script?: string;
  scriptVar?: string;
  template?: string;
  description?: string;
}

interface IRefreshTarget {
  vmId: number;
  hostname: string;
  applicationId: string;
  status: string;
  actions: IRefreshAction[];
}

interface IRefreshPreview {
  stackId: string;
  stacktype: string;
  varName: string;
  targets: IRefreshTarget[];
}

interface IRefreshActionResult {
  vmId: number;
  hostname: string;
  source: IRefreshAction['source'];
  replacement: string;
  status: 'ok' | 'error' | 'skipped';
  detail?: string;
}

interface IRefreshResult {
  timestamp: string;
  stackId: string;
  varName: string;
  actions: IRefreshActionResult[];
}

export interface RefreshStackDialogData {
  stack: IStack;
  preview: IRefreshPreview;
  veContextHost: string;
  /** If set, only apply refresh for this single vmId (used by Installed-List button). */
  vmIdFilter?: number;
}

@Component({
  selector: 'app-refresh-stack-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    RouterModule,
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>autorenew</mat-icon>
      Refresh stack "{{ data.stack.name }}"
    </h2>
    <div class="context-bar">
      <mat-icon>dns</mat-icon>
      <span>Host: <strong>{{ data.veContextHost }}</strong></span>
    </div>
    <mat-dialog-content>
      @if (executionResult()) {
        <!-- Result view -->
        <h3>Refresh complete</h3>
        <p class="summary">
          {{ successCount() }} succeeded · {{ skippedCount() }} skipped · {{ errorCount() }} failed
        </p>
        @if (checksDispatched() > 0) {
          <p class="check-dispatch-note">
            <mat-icon>health_and_safety</mat-icon>
            Health checks dispatched for {{ checksDispatched() }} container{{ checksDispatched() !== 1 ? 's' : '' }}
            — see <a routerLink="/monitor" mat-dialog-close>Process Monitor</a> for details.
          </p>
        }
        <div class="result-list">
          @for (action of executionResult()!.actions; track $index) {
            <div class="result-row" [class.ok]="action.status === 'ok'"
                                    [class.skipped]="action.status === 'skipped'"
                                    [class.error]="action.status === 'error'">
              <mat-icon class="status-icon">
                {{ action.status === 'ok' ? 'check_circle' :
                   action.status === 'skipped' ? 'remove_circle_outline' : 'error' }}
              </mat-icon>
              <div class="result-body">
                <div class="result-head">
                  <span class="hostname">{{ action.hostname }}</span>
                  <span class="vmid">vmid {{ action.vmId }}</span>
                  <span class="replacement">{{ action.replacement }}</span>
                </div>
                @if (action.detail) {
                  <div class="detail">{{ action.detail }}</div>
                }
              </div>
            </div>
          }
        </div>
      } @else {
        <!-- Preview view -->
        @if (data.preview.targets.length === 0) {
          <p class="empty-state">
            <mat-icon>info</mat-icon>
            No installed containers declare usage of this stack.
            Nothing to refresh.
          </p>
        } @else {
          <p class="intro">
            The following {{ data.preview.targets.length }} container(s) will be updated with the
            current stack values. Entries with method <strong>manual</strong> are listed for
            your information but are not modified automatically.
          </p>
          <div class="target-list">
            @for (target of data.preview.targets; track target.vmId) {
              <div class="target">
                <div class="target-head">
                  <mat-icon>dns</mat-icon>
                  <span class="hostname">{{ target.hostname }}</span>
                  <span class="vmid">vmid {{ target.vmId }}</span>
                  <span class="app">{{ target.applicationId }}</span>
                  <span class="status" [class.running]="target.status === 'running'">{{ target.status }}</span>
                </div>
                <table class="action-table">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th>Method</th>
                      <th>Target</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (action of target.actions; track $index) {
                      <tr [class.manual]="action.replacement === 'manual'"
                          [class.no-action]="action.replacement === 'no-action'"
                          [matTooltip]="action.description ?? ''"
                          matTooltipPosition="above">
                        <td class="var">{{ action.varName }}</td>
                        <td>
                          <span class="method method-{{ action.replacement }}">{{ action.replacement }}</span>
                        </td>
                        <td class="target-col">
                          @if (action.replacement === 'compose-env' && action.composeKey) {
                            <span class="mono">{{ action.composeKey }}</span>
                          }
                          @if (action.replacement === 'lxc-config-env') {
                            <span class="mono">{{ action.lxcVarName ?? action.varName }}</span>
                          }
                          @if (action.replacement === 'on-start-env') {
                            <span class="mono two-line">
                              <span>{{ action.script }}</span>
                              <span>{{ action.scriptVar ?? action.varName }}</span>
                            </span>
                          }
                          @if (action.replacement === 'rerun-template' && action.template) {
                            <span class="mono">{{ action.template }} (deprecated)</span>
                          }
                          @if (action.replacement === 'manual' || action.replacement === 'no-action') {
                            <span class="dim">—</span>
                          }
                        </td>
                        <td class="source">
                          {{ action.source.kind === 'application' ? 'app:' + action.source.applicationId
                                                                  : 'addon:' + action.source.addonId }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (executionResult()) {
        <button mat-flat-button color="primary" mat-dialog-close>Close</button>
      } @else {
        <button mat-button mat-dialog-close [disabled]="applying()">Cancel</button>
        <button mat-flat-button color="primary"
                (click)="apply()"
                [disabled]="data.preview.targets.length === 0 || applying()">
          @if (applying()) {
            <mat-spinner diameter="20"></mat-spinner>
          } @else {
            Apply
          }
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    :host {
      display: block;
    }

    mat-dialog-content {
      min-width: 720px;
      max-width: none;
      max-height: 72vh;
    }

    h2 {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .context-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: -0.5rem 1.5rem 0.75rem;
      padding: 0.5rem 0.75rem;
      background: #f5f5f5;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #444;
    }

    .context-bar mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }

    .intro {
      color: #555;
      font-size: 0.9rem;
      margin: 0 0 1rem 0;
    }

    .empty-state {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #666;
      padding: 1rem 0;
    }

    .target-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .target {
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      padding: 0.75rem;
      background: #fafafa;
    }

    .target-head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.95rem;
      margin-bottom: 0.5rem;
    }

    .target-head .hostname {
      font-weight: 500;
    }

    .target-head .vmid,
    .target-head .app {
      color: #666;
      font-size: 0.85rem;
    }

    .target-head .status {
      margin-left: auto;
      padding: 0.1rem 0.5rem;
      border-radius: 10px;
      font-size: 0.75rem;
      background: #eee;
      color: #555;
    }

    .target-head .status.running {
      background: #c8e6c9;
      color: #2e7d32;
    }

    .action-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      background: white;
      border-radius: 3px;
      overflow: hidden;
    }

    .action-table thead th {
      text-align: left;
      font-weight: 500;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #777;
      padding: 0.35rem 0.6rem;
      border-bottom: 1px solid #e0e0e0;
      background: #fafafa;
    }

    .action-table tbody td {
      padding: 0.4rem 0.6rem;
      vertical-align: top;
      border-bottom: 1px solid #f0f0f0;
    }

    .action-table tbody tr:last-child td {
      border-bottom: none;
    }

    .action-table tbody tr.manual,
    .action-table tbody tr.no-action {
      opacity: 0.75;
    }

    /* Column widths: var narrow, method medium, target wide, source medium */
    .action-table thead th:nth-child(1),
    .action-table tbody td:nth-child(1) { width: 22%; }
    .action-table thead th:nth-child(2),
    .action-table tbody td:nth-child(2) { width: 20%; white-space: nowrap; }
    .action-table thead th:nth-child(3),
    .action-table tbody td:nth-child(3) { width: 36%; }
    .action-table thead th:nth-child(4),
    .action-table tbody td:nth-child(4) { width: 22%; color: #777; font-size: 0.8rem; }

    .action-table td.var {
      font-family: monospace;
      font-weight: 500;
    }

    .action-table .method {
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      font-size: 0.75rem;
      font-weight: 500;
      display: inline-block;
    }

    .action-table .mono {
      font-family: monospace;
      font-size: 0.8rem;
      color: #333;
    }

    .action-table .mono.two-line {
      display: inline-flex;
      flex-direction: column;
      line-height: 1.25;
    }

    .action-table .dim {
      color: #bbb;
    }

    .method-compose-env {
      background: #e3f2fd;
      color: #1565c0;
    }

    .method-lxc-config-env {
      background: #fff3e0;
      color: #e65100;
    }

    .method-on-start-env {
      background: #e8f5e9;
      color: #2e7d32;
    }

    .method-rerun-template {
      background: #f3e5f5;
      color: #6a1b9a;
    }

    .method-manual {
      background: #fff9c4;
      color: #f9a825;
    }

    .method-no-action {
      background: #eeeeee;
      color: #757575;
    }

    .summary {
      font-size: 0.9rem;
      color: #555;
      margin: 0 0 0.25rem 0;
    }

    .check-dispatch-note {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.85rem;
      color: #555;
      margin: 0 0 1rem 0;
      padding: 0.4rem 0.6rem;
      background: #e8f5e9;
      border-radius: 4px;
    }

    .check-dispatch-note mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: #2e7d32;
    }

    .check-dispatch-note a {
      color: #1565c0;
      text-decoration: underline;
      cursor: pointer;
    }

    .result-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .result-row {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.5rem;
      border-radius: 4px;
      border: 1px solid transparent;
    }

    .result-row.ok {
      background: #e8f5e9;
      border-color: #c8e6c9;
    }

    .result-row.skipped {
      background: #f5f5f5;
      border-color: #e0e0e0;
    }

    .result-row.error {
      background: #ffebee;
      border-color: #ffcdd2;
    }

    .status-icon {
      flex: 0 0 auto;
    }

    .result-row.ok .status-icon { color: #2e7d32; }
    .result-row.skipped .status-icon { color: #757575; }
    .result-row.error .status-icon { color: #c62828; }

    .result-body {
      flex: 1 1 auto;
      min-width: 0;
    }

    .result-head {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      font-size: 0.9rem;
    }

    .result-head .hostname { font-weight: 500; }
    .result-head .vmid { color: #666; font-size: 0.8rem; }
    .result-head .replacement { margin-left: auto; color: #555; font-size: 0.8rem; }

    .detail {
      color: #555;
      font-size: 0.8rem;
      margin-top: 0.2rem;
      font-family: monospace;
      word-break: break-word;
    }

    mat-spinner {
      display: inline-block;
    }

    mat-dialog-actions button {
      min-width: 88px;
    }
  `]
})
export class RefreshStackDialog {
  dialogRef = inject(MatDialogRef<RefreshStackDialog>);
  data = inject<RefreshStackDialogData>(MAT_DIALOG_DATA);
  private configService = inject(VeConfigurationService);
  private errorHandler = inject(ErrorHandlerService);

  applying = signal(false);
  executionResult = signal<IRefreshResult | null>(null);
  checksDispatched = signal<number>(0);

  successCount = () =>
    this.executionResult()?.actions.filter((a) => a.status === 'ok').length ?? 0;
  skippedCount = () =>
    this.executionResult()?.actions.filter((a) => a.status === 'skipped').length ?? 0;
  errorCount = () =>
    this.executionResult()?.actions.filter((a) => a.status === 'error').length ?? 0;

  apply(): void {
    const stack = this.data.stack;
    if (!stack.entries.length) {
      this.dialogRef.close();
      return;
    }

    this.applying.set(true);
    const mergedActions: IRefreshActionResult[] = [];
    let remaining = stack.entries.length;
    const vmIdFilter = this.data.vmIdFilter;

    for (const entry of stack.entries) {
      this.configService
        .applyStackRefresh(
          stack.id,
          entry.name,
          String(entry.value),
          vmIdFilter !== undefined ? { vmId: vmIdFilter } : undefined,
        )
        .subscribe({
          next: (res) => {
            const r = res.result as IRefreshResult;
            if (r?.actions) mergedActions.push(...r.actions);
            if (--remaining === 0) this.finishApply(mergedActions);
          },
          error: (err) => {
            mergedActions.push({
              vmId: 0,
              hostname: entry.name,
              source: { kind: 'application' },
              replacement: 'error',
              status: 'error',
              detail: err?.message ?? 'request failed',
            });
            if (--remaining === 0) this.finishApply(mergedActions);
          },
        });
    }
  }

  private finishApply(actions: IRefreshActionResult[]): void {
    this.applying.set(false);
    this.executionResult.set({
      timestamp: new Date().toISOString(),
      stackId: this.data.stack.id,
      varName: '*',
      actions,
    });
    this.dispatchHealthChecks(actions);
  }

  /**
   * After a successful refresh-apply, fire the existing `check`-task for each
   * container that had at least one OK action. Fire-and-forget: the dialog
   * does not wait. Results stream into the VE-Execute log and are visible in
   * the Process Monitor.
   *
   * applicationId is taken from the preview (not from the action — the
   * execution result doesn't carry it).
   */
  private dispatchHealthChecks(actions: IRefreshActionResult[]): void {
    const veContextKey = `ve_${this.data.veContextHost}`;

    const appByVmId = new Map<number, string>();
    for (const t of this.data.preview.targets) {
      appByVmId.set(t.vmId, t.applicationId);
    }

    // Unique targets with at least one successful action
    const targetInfo = new Map<number, { hostname: string; applicationId: string }>();
    for (const a of actions) {
      if (a.status !== 'ok' || a.vmId <= 0) continue;
      const applicationId = appByVmId.get(a.vmId);
      if (!applicationId) continue;
      if (!targetInfo.has(a.vmId)) {
        targetInfo.set(a.vmId, { hostname: a.hostname, applicationId });
      }
    }

    let dispatched = 0;
    for (const [vmId, info] of targetInfo) {
      this.configService
        .dispatchCheckTask(info.applicationId, veContextKey, vmId, info.hostname)
        .subscribe({
          next: () => { /* fire-and-forget, result visible in Process Monitor */ },
          error: (err) => {
            // Don't surface the error in the dialog — the refresh itself
            // succeeded; the user can still see dispatch failures in dev tools.
            console.warn('[refresh] check-task dispatch failed for vm', vmId, err);
          },
        });
      dispatched++;
    }
    this.checksDispatched.set(dispatched);
  }
}
