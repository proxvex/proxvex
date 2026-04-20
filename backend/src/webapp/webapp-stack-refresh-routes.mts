import express from "express";
import fs from "node:fs";
import path from "node:path";
import { ApiUri } from "../types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { IStackProvider } from "../services/stack-provider.mjs";
import {
  findRefreshTargets,
  executeRefresh,
  IStackRefreshPreview,
  IStackRefreshExecutionResult,
} from "../services/stack-refresh-service.mjs";

export class WebAppStackRefresh {
  private pm: PersistenceManager;

  constructor(
    private app: express.Application,
    private stackProvider: IStackProvider,
  ) {
    this.pm = PersistenceManager.getInstance();
  }

  init(): void {
    // POST /api/stack/:id/refresh-preview
    // body: { varName?: string, vmId?: number }
    this.app.post(
      ApiUri.StackRefreshPreview,
      express.json(),
      async (req, res) => {
        try {
          const { id } = req.params as { id: string };
          const varName = (req.body?.varName as string | undefined) ?? undefined;
          const vmIdFilter = req.body?.vmId as number | undefined;

          const stack = this.stackProvider.getStack(id);
          if (!stack) {
            res.status(404).json({ error: `Stack not found: ${id}` });
            return;
          }
          const veContext = this.pm
            .getContextManager()
            .getCurrentVEContext();
          if (!veContext) {
            res
              .status(400)
              .json({ error: "no current VE context selected" });
            return;
          }
          const preview: IStackRefreshPreview = await findRefreshTargets(
            this.pm,
            veContext,
            stack,
            varName,
            vmIdFilter,
          );
          res.json({ preview, veContextHost: veContext.host });
        } catch (err: any) {
          res.status(500).json({ error: err?.message ?? String(err) });
        }
      },
    );

    // POST /api/stack/:id/refresh
    // body: { varName: string, newValue: string, oldValue?: string, vmId?: number }
    this.app.post(
      ApiUri.StackRefreshApply,
      express.json(),
      async (req, res) => {
        try {
          const { id } = req.params as { id: string };
          const varName = req.body?.varName as string | undefined;
          const newValue = req.body?.newValue as string | undefined;
          const oldValue = (req.body?.oldValue as string | undefined) ?? "";
          const vmIdFilter = req.body?.vmId as number | undefined;
          if (!varName || newValue === undefined) {
            res
              .status(400)
              .json({ error: "Missing required fields: varName, newValue" });
            return;
          }

          const stack = this.stackProvider.getStack(id);
          if (!stack) {
            res.status(404).json({ error: `Stack not found: ${id}` });
            return;
          }
          const veContext = this.pm
            .getContextManager()
            .getCurrentVEContext();
          if (!veContext) {
            res
              .status(400)
              .json({ error: "no current VE context selected" });
            return;
          }

          const preview = await findRefreshTargets(
            this.pm,
            veContext,
            stack,
            varName,
            vmIdFilter,
          );
          const result: IStackRefreshExecutionResult = await executeRefresh(
            this.pm,
            veContext,
            preview,
            newValue,
            oldValue,
          );

          // Update stack entry with new value only if at least one action succeeded.
          // Clear the `dirty` flag once ALL refresh actions across the whole
          // stack have completed without errors — partial refreshes keep the
          // stack dirty so the UI still nudges the user.
          const anyOk = result.actions.some((a) => a.status === "ok");
          const anyError = result.actions.some((a) => a.status === "error");
          if (anyOk) {
            const entry = stack.entries.find((e) => e.name === varName);
            if (entry) {
              entry.value = newValue;
            } else {
              stack.entries.push({ name: varName, value: newValue });
            }
            if (!anyError) {
              stack.dirty = false;
            }
            this.stackProvider.addStack(stack);
          }

          this.appendAuditLog(result);

          res.json({ result, veContextHost: veContext.host });
        } catch (err: any) {
          res.status(500).json({ error: err?.message ?? String(err) });
        }
      },
    );
  }

  /**
   * Appends an execution result to refresh-history.json next to
   * storagecontext.json. Creates the file if it does not yet exist.
   * Failures are logged but never block the HTTP response.
   */
  private appendAuditLog(entry: IStackRefreshExecutionResult): void {
    try {
      const localPath = this.pm.getPathes().localPath;
      const logPath = path.join(localPath, "refresh-history.json");
      let log: IStackRefreshExecutionResult[] = [];
      if (fs.existsSync(logPath)) {
        try {
          const raw = fs.readFileSync(logPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) log = parsed;
        } catch {
          /* corrupt/truncated — start fresh */
        }
      }
      log.push(entry);
      // Cap at last 500 entries to avoid unbounded growth.
      if (log.length > 500) log = log.slice(log.length - 500);
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
    } catch (err) {
      console.warn("[stack-refresh] audit log write failed:", err);
    }
  }
}
