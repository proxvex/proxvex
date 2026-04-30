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
   * Body: { hostname: string, extraSans?: string[] }
   * Response: { cert: string, key: string } (both base64 PEM)
   */
  app.post(ApiUri.HubCaSign, express.json(), (req, res) => {
    try {
      const { hostname, extraSans } = req.body;
      if (!hostname) {
        res.status(400).json({ error: "Missing hostname" });
        return;
      }
      if (extraSans !== undefined && !Array.isArray(extraSans)) {
        res.status(400).json({ error: "extraSans must be an array of strings" });
        return;
      }
      const caProvider = pm.getCaProvider();
      // Use the default VE context key for CA operations
      const veContextKey = "ca_global";
      const result = caProvider.generateSelfSignedCert(veContextKey, hostname, extraSans);
      logger.info("CA signed certificate for spoke", { hostname, extraSans: extraSans ?? [] });
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

  // --- Full repositories tarball (for Spoke sync) ---

  /**
   * GET /api/hub/repositories.tar.gz — Download the Hub's *project state*
   * (the `local/` tree) as a gzip-compressed tar archive.
   *
   * Only `local/` is shipped. Templates, scripts, addons and applications
   * (the `json/` tree) live in the Spoke's checked-out workspace and are
   * NOT served by the Hub — that way the Spoke always runs against the
   * code revision the user has on disk, while still pulling project
   * settings and secrets atomically from the Hub.
   *
   * Extracted layout at the Spoke:
   *   <spoke-workspace>/local/...
   */
  app.get(ApiUri.HubRepositoriesTarball, (_req, res) => {
    try {
      const pathes = pm.getPathes();
      const localDir = pathes.localPath;
      if (!fs.existsSync(localDir)) {
        res.status(404).json({ error: "No local/ directory on this Hub" });
        return;
      }

      // Stage so the tarball has a predictable top-level name regardless of
      // where the source path lives on the Hub filesystem.
      const stageRoot = fs.mkdtempSync(path.join("/tmp", "hub-repo-"));
      try {
        fs.symlinkSync(localDir, path.join(stageRoot, "local"));

        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Disposition", "attachment; filename=repositories.tar.gz");
        const tarData = execSync(
          `tar -czhf - -C "${stageRoot}" local`,
          { maxBuffer: 200 * 1024 * 1024 },
        );
        res.send(tarData);
      } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
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
