import express from "express";
import { ApiUri } from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { LogRotationService } from "../services/log-rotation-service.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

let logRotationService: LogRotationService | null = null;

export function getLogRotationService(): LogRotationService | null {
  return logRotationService;
}

export function registerMaintenanceRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  logRotationService = new LogRotationService(storageContext);

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
}
