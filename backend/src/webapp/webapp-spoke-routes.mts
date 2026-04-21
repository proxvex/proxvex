import type { Application } from "express";
import fs from "node:fs";
import path from "node:path";
import { ApiUri } from "../types.mjs";
import { syncFromHub, hubIdFromUrl } from "../services/spoke-sync-service.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("spoke-routes");

/**
 * Spoke API endpoints — only meaningful when HUB_URL is set.
 *
 * The sync trigger is idempotent: each call fetches the latest repositories
 * tarball from the Hub and atomically swaps <local>/.hubs/<hub-id>/. The
 * deployer then needs to be restarted with --local pointing at that workspace
 * to pick up the new artefacts (Phase A — live hot-swap is Phase B).
 */
export function registerSpokeRoutes(app: Application): void {
  /**
   * POST /api/spoke/sync — Pull repositories from the Hub into a per-Hub
   * workspace directory. Returns the workspace path + sync timestamp.
   */
  app.post(ApiUri.SpokeSync, async (_req, res) => {
    try {
      const hubUrl = process.env.HUB_URL;
      if (!hubUrl) {
        res
          .status(400)
          .json({ error: "Spoke mode not active (HUB_URL not set)" });
        return;
      }
      const localPath = process.env.LXC_MANAGER_LOCAL_PATH || process.cwd();
      const result = await syncFromHub(hubUrl, localPath);
      res.json({
        ok: true,
        ...result,
        note: "Restart the deployer with --local <workspacePath>/local --jsonPath <workspacePath>/json to load Hub repositories.",
      });
    } catch (err) {
      sendErrorResponse(res, err as Error);
    }
  });

  /**
   * GET /api/spoke/sync — Report whether a workspace exists for the current
   * Hub, when it was last synced (mtime of the workspace dir).
   */
  app.get(ApiUri.SpokeSync, (_req, res) => {
    const hubUrl = process.env.HUB_URL;
    if (!hubUrl) {
      res.json({ active: false });
      return;
    }
    const localPath = process.env.LXC_MANAGER_LOCAL_PATH || process.cwd();
    const hubId = hubIdFromUrl(hubUrl.replace(/\/$/, ""));
    const workspacePath = path.join(localPath, ".hubs", hubId);
    if (!fs.existsSync(workspacePath)) {
      res.json({ active: true, hubUrl, hubId, workspacePath, synced: false });
      return;
    }
    const stat = fs.statSync(workspacePath);
    res.json({
      active: true,
      hubUrl,
      hubId,
      workspacePath,
      synced: true,
      syncedAt: stat.mtime.toISOString(),
    });
  });

  logger.info("Spoke endpoints registered");
}
