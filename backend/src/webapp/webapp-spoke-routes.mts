import type { Application } from "express";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { ApiUri } from "../types.mjs";
import { syncFromHub, hubIdFromUrl } from "../services/spoke-sync-service.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";
import { createLogger } from "../logger/index.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { getBearerToken } from "../services/bearer-token-store.mjs";

const logger = createLogger("spoke-routes");

/**
 * Spoke API endpoints — only meaningful when the current SSH entry has
 * isHub=true (or the HUB_URL env var is set as a fallback).
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
      const hubUrl = PersistenceManager.getInstance().getActiveHubUrl();
      if (!hubUrl) {
        res.status(400).json({
          error:
            "Spoke mode not active — mark the current SSH entry as a Hub and set its Hub API URL.",
        });
        return;
      }
      const localPath = PersistenceManager.getInstance().getPathes().localPath;
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
    const hubUrl = PersistenceManager.getInstance().getActiveHubUrl();
    if (!hubUrl) {
      res.json({ active: false });
      return;
    }
    const localPath = PersistenceManager.getInstance().getPathes().localPath;
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

  /**
   * POST /api/spoke/probe-hub — Test whether a Hub URL is reachable and
   * speaks the proxvex Hub protocol. Used by the SSH-config UI to
   * validate the user-entered Hub API URL before save.
   *
   * Body: { hubApiUrl: string }
   * Response: { ok: true, caFingerprint?: string } | { ok: false, error: string }
   */
  app.post(ApiUri.SpokeProbeHub, express.json(), async (req, res) => {
    const hubApiUrl = String((req.body ?? {}).hubApiUrl ?? "").trim();
    if (!hubApiUrl || !/^https?:\/\//.test(hubApiUrl)) {
      res.status(400).json({
        ok: false,
        error: "hubApiUrl must start with http:// or https://",
      });
      return;
    }

    const url = hubApiUrl.replace(/\/$/, "") + "/api/hub/ca/cert";
    try {
      const { spawnSync } = await import("node:child_process");
      const args = ["-s", "-f", "--max-time", "5", "-o", "-", "-w", "\n%{http_code}"];
      if (url.startsWith("https://")) args.push("-k"); // TOFU during probe
      const token = getBearerToken();
      if (token) args.push("-H", `Authorization: Bearer ${token}`);
      args.push(url);
      const r = spawnSync("curl", args, { encoding: "utf-8", timeout: 8000 });
      if (r.error) {
        res.json({ ok: false, error: `connection failed: ${r.error.message}` });
        return;
      }
      if (r.status !== 0) {
        res.json({
          ok: false,
          error: `Hub unreachable or not a deployer Hub (curl exit ${r.status})`,
        });
        return;
      }
      // Split body and trailing status code
      const parts = (r.stdout || "").trim().split(/\n/);
      const code = parts.pop() || "";
      const body = parts.join("\n");
      if (code !== "200") {
        res.json({ ok: false, error: `Hub responded with HTTP ${code}` });
        return;
      }
      let cert: string | undefined;
      try {
        const parsed = JSON.parse(body) as { cert?: string };
        cert = parsed.cert;
      } catch {
        res.json({
          ok: false,
          error: "Hub returned non-JSON — is this really a deployer Hub?",
        });
        return;
      }
      if (!cert) {
        res.json({
          ok: false,
          error: "Hub response did not contain a CA certificate",
        });
        return;
      }

      // Compute SHA-256 fingerprint of the PEM (as a stable identifier)
      const { createHash } = await import("node:crypto");
      const fingerprint = createHash("sha256")
        .update(cert, "utf-8")
        .digest("hex")
        .match(/.{2}/g)!
        .join(":")
        .toUpperCase();

      res.json({ ok: true, caFingerprint: fingerprint });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ ok: false, error: message });
    }
  });

  logger.info("Spoke endpoints registered");
}
