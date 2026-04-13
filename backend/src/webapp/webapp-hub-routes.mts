import express from "express";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ApiUri } from "../types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("hub-routes");

/**
 * Hub API endpoints — always registered on every deployer.
 * In Hub mode these serve CA signing and stack data to Spokes.
 * In Spoke mode these endpoints exist but are unused (no spokes connect).
 *
 * mTLS validation is handled separately (Phase 5 adds middleware).
 * For now, these endpoints are accessible without client cert validation,
 * which is fine since no spokes exist until Phase 5.
 */
export function registerHubRoutes(app: express.Application): void {
  const pm = PersistenceManager.getInstance();

  // --- CA endpoints ---

  /**
   * POST /api/hub/ca/sign — Sign a CSR with the local CA.
   * Body: { csr: string (PEM), hostname: string }
   * Response: { cert: string (PEM base64) }
   */
  app.post(ApiUri.HubCaSign, express.json(), (req, res) => {
    try {
      const { hostname } = req.body;
      if (!hostname) {
        res.status(400).json({ error: "Missing hostname" });
        return;
      }
      const caProvider = pm.getCaProvider();
      // Use the default VE context key for CA operations
      const veContextKey = "ca_global";
      const result = caProvider.generateSelfSignedCert(veContextKey, hostname);
      logger.info("CA signed certificate for spoke", { hostname });
      res.json({ cert: result.cert, key: result.key });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  /**
   * GET /api/hub/ca/cert — Get CA public certificate (no auth required).
   * Response: PEM-encoded CA certificate (base64).
   */
  app.get(ApiUri.HubCaCert, (_req, res) => {
    try {
      const caProvider = pm.getCaProvider();
      const ca = caProvider.getCA("ca_global");
      if (!ca) {
        res.status(404).json({ error: "No CA configured" });
        return;
      }
      res.json({ cert: ca.cert });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // --- Stack endpoints (mirror local stack API for spoke access) ---

  /**
   * GET /api/hub/stacks?stacktype=xxx — List stacks.
   */
  app.get(ApiUri.HubStacks, (req, res) => {
    try {
      const stacktype = req.query.stacktype as string | undefined;
      const stackProvider = pm.getStackProvider();
      const stacks = stackProvider.listStacks(stacktype);
      res.json({ stacks });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  /**
   * GET /api/hub/stack/:id — Get single stack.
   */
  app.get(ApiUri.HubStack, (req, res) => {
    try {
      const stackProvider = pm.getStackProvider();
      const stack = stackProvider.getStack(req.params.id);
      if (!stack) {
        res.status(404).json({ error: "Stack not found" });
        return;
      }
      res.json({ stack });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  /**
   * POST /api/hub/stacks — Create stack.
   */
  app.post(ApiUri.HubStacks, express.json(), (req, res) => {
    try {
      const stackProvider = pm.getStackProvider();
      const key = stackProvider.addStack(req.body);
      res.json({ success: true, key });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  /**
   * DELETE /api/hub/stack/:id — Delete stack.
   */
  app.delete(ApiUri.HubStack, (req, res) => {
    try {
      const stackProvider = pm.getStackProvider();
      const deleted = stackProvider.deleteStack(req.params.id);
      res.json({ success: deleted, deleted });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // --- Project settings endpoint ---

  /**
   * GET /api/hub/project — Download shared project settings as tar.gz.
   * Exports local/shared/templates/ and local/shared/scripts/ from the Hub.
   * Spoke deployers fetch this at startup to get project-specific defaults.
   */
  app.get(ApiUri.HubProject, (_req, res) => {
    try {
      const pathes = pm.getPathes();
      const sharedDir = path.join(pathes.localPath, "shared");

      if (!fs.existsSync(sharedDir)) {
        res.status(404).json({ error: "No shared project settings found" });
        return;
      }

      // Create tar.gz of shared/ directory (templates + scripts)
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", "attachment; filename=project.tar.gz");

      try {
        const tarData = execSync(
          `tar -czf - -C "${pathes.localPath}" shared/`,
          { maxBuffer: 10 * 1024 * 1024 },
        );
        res.send(tarData);
      } catch (tarErr: any) {
        res.status(500).json({ error: `Failed to create tar: ${tarErr.message}` });
      }
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  // --- Spoke management ---

  /**
   * GET /api/hub/spokes — List known spokes.
   * Placeholder — will be implemented when spoke registration is added.
   */
  app.get(ApiUri.HubSpokes, (_req, res) => {
    res.json({ spokes: [] });
  });

  /**
   * DELETE /api/hub/spoke/:id — Revoke spoke access.
   * Placeholder — will be implemented when spoke registration is added.
   */
  app.delete(ApiUri.HubSpoke, (_req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  logger.info("Hub endpoints registered");
}
