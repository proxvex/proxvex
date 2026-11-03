import express from "express";
import { ApiUri, IUnfinishedRebuildActionBody } from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { LogRotationService } from "../services/log-rotation-service.mjs";
import { ReplacedContainerCleanupService } from "../services/replaced-container-cleanup-service.mjs";
import { UnfinishedRebuildService } from "../services/unfinished-rebuild-service.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

let logRotationService: LogRotationService | null = null;
let replacedCleanupService: ReplacedContainerCleanupService | null = null;

export function getLogRotationService(): LogRotationService | null {
  return logRotationService;
}

export function getReplacedCleanupService(): ReplacedContainerCleanupService | null {
  return replacedCleanupService;
}

export function registerMaintenanceRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  logRotationService = new LogRotationService(storageContext);
  replacedCleanupService = new ReplacedContainerCleanupService(storageContext);
  const unfinishedRebuildService = new UnfinishedRebuildService(storageContext);

  // GET /api/maintenance/log-rotation - Log rotation status
  app.get(ApiUri.LogRotation, (_req, res) => {
    try {
      res.status(200).json(logRotationService!.getStatus());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/maintenance/log-rotation - Enable/disable log rotation
  app.post(ApiUri.LogRotation, express.json(), (req, res) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "Missing or invalid 'enabled' (boolean)" });
        return;
      }
      logRotationService!.setEnabled(enabled);
      res.status(200).json(logRotationService!.getStatus());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/maintenance/log-rotation/check - Trigger manual rotation
  app.post(ApiUri.LogRotationCheck, express.json(), async (_req, res) => {
    try {
      const result = await logRotationService!.checkAndRotate();
      res.status(200).json(result);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/maintenance/replaced-cleanup - Cleanup status
  app.get(ApiUri.ReplacedCleanup, (_req, res) => {
    try {
      res.status(200).json(replacedCleanupService!.getStatus());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/maintenance/replaced-cleanup - Toggle enabled / set grace_days
  app.post(ApiUri.ReplacedCleanup, express.json(), (req, res) => {
    try {
      const body = req.body as { enabled?: boolean; grace_days?: number };
      if (body.grace_days !== undefined) {
        replacedCleanupService!.setGraceDays(body.grace_days);
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          res
            .status(400)
            .json({ error: "Invalid 'enabled' (must be boolean)" });
          return;
        }
        replacedCleanupService!.setEnabled(body.enabled);
      }
      res.status(200).json(replacedCleanupService!.getStatus());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/maintenance/replaced-cleanup/list - List all replaced containers (no destroy)
  app.get(ApiUri.ReplacedCleanupList, async (_req, res) => {
    try {
      const result = await replacedCleanupService!.listAll();
      res.status(200).json(result);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/maintenance/replaced-cleanup/run - Trigger manual cleanup pass
  app.post(ApiUri.ReplacedCleanupRun, express.json(), async (_req, res) => {
    try {
      const result = await replacedCleanupService!.checkAndCleanup();
      res.status(200).json(result);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/maintenance/locked-containers/list - List all locked containers (no destroy)
  app.get(ApiUri.LockedCleanupList, async (_req, res) => {
    try {
      const result = await replacedCleanupService!.listLocked();
      res.status(200).json(result);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/maintenance/locked-containers/destroy-all - Destroy every locked
  // proxvex-managed container immediately, no grace period.
  app.post(
    ApiUri.LockedCleanupDestroy,
    express.json(),
    async (_req, res) => {
      try {
        const result = await replacedCleanupService!.destroyAllLocked();
        res.status(200).json(result);
      } catch (err: any) {
        sendErrorResponse(res, err);
      }
    },
  );
  // GET /api/maintenance/unfinished-rebuilds/list - Containers left between
  // clone and replace by a failed reconfigure/upgrade
  app.get(ApiUri.UnfinishedRebuildsList, async (_req, res) => {
    try {
      res.status(200).json(await unfinishedRebuildService.listAll());
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  const parseRebuildAction = (
    body: unknown,
  ): IUnfinishedRebuildActionBody | undefined => {
    const b = body as Partial<IUnfinishedRebuildActionBody> | undefined;
    if (
      typeof b?.ve_host !== "string" ||
      !Number.isInteger(b.vm_id) ||
      !Number.isInteger(b.source_vm_id)
    ) {
      return undefined;
    }
    return b as IUnfinishedRebuildActionBody;
  };

  // POST /api/maintenance/unfinished-rebuilds/finish - New container takes
  // over, source is marked replaced
  app.post(ApiUri.UnfinishedRebuildFinish, express.json(), async (req, res) => {
    const action = parseRebuildAction(req.body);
    if (!action) {
      res.status(400).json({ error: "ve_host, vm_id and source_vm_id are required" });
      return;
    }
    try {
      await unfinishedRebuildService.finish(action.ve_host, action.vm_id, action.source_vm_id);
      res.status(200).json({ success: true });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // POST /api/maintenance/unfinished-rebuilds/discard - New container is
  // destroyed, source serves again
  app.post(ApiUri.UnfinishedRebuildDiscard, express.json(), async (req, res) => {
    const action = parseRebuildAction(req.body);
    if (!action) {
      res.status(400).json({ error: "ve_host, vm_id and source_vm_id are required" });
      return;
    }
    try {
      await unfinishedRebuildService.discard(action.ve_host, action.vm_id, action.source_vm_id);
      res.status(200).json({ success: true });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}
