import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createLogger } from "../logger/index.mjs";
import { getBearerToken } from "./bearer-token-store.mjs";

const logger = createLogger("spoke-sync");

export interface SpokeSyncResult {
  hubUrl: string;
  hubId: string;
  workspacePath: string;
  syncedAt: string;
}

/**
 * Stable per-Hub identifier derived from the Hub URL. Used to name the
 * local workspace directory for each Hub the Spoke has synced against.
 */
export function hubIdFromUrl(hubUrl: string): string {
  return crypto.createHash("sha256").update(hubUrl).digest("hex").slice(0, 12);
}

/**
 * Sync the Hub's *project state* (the `local/` tree) into a Hub-specific
 * workspace under the Spoke's configured local path. Templates/scripts/
 * applications stay in the Spoke's checked-out workspace and are NOT
 * synced — see GET /api/hub/repositories.tar.gz for the rationale.
 *
 * Extracted layout:
 *   <localPath>/.hubs/<hub-id>/local/...
 *
 * Auth uses the globally stored bearer token if present; otherwise the
 * request goes unauthenticated (Hub without OIDC accepts this).
 *
 * The caller binds the resulting `local/` path via
 * `pm.rebindRepositoriesRoot(jsonPath, <returned.workspacePath>/local)` —
 * jsonPath stays whatever the Spoke was started with.
 */
export async function syncFromHub(
  hubUrl: string,
  spokeLocalPath: string,
): Promise<SpokeSyncResult> {
  const normalizedHubUrl = hubUrl.replace(/\/$/, "");
  const hubId = hubIdFromUrl(normalizedHubUrl);
  const workspacePath = path.join(spokeLocalPath, ".hubs", hubId);
  const tmpExtract = `${workspacePath}.incoming`;

  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  fs.mkdirSync(tmpExtract, { recursive: true });

  const tarballUrl = `${normalizedHubUrl}/api/hub/repositories.tar.gz`;
  const token = getBearerToken();
  const isHttps = normalizedHubUrl.startsWith("https://");

  logger.info(`[spoke-sync] Pulling repositories from ${tarballUrl}`);

  await new Promise<void>((resolve, reject) => {
    const curlArgs: string[] = ["-s", "-f", "--max-time", "120"];
    // TOFU — for Phase A we accept any TLS cert from the Hub. A future
    // improvement pins a known CA (see plan "TOFU with fingerprint").
    if (isHttps) curlArgs.push("-k");
    if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`);
    curlArgs.push(tarballUrl);

    const curl = spawn("curl", curlArgs);
    const tar = spawn("tar", ["xzf", "-", "-C", tmpExtract]);
    curl.stdout.pipe(tar.stdin);

    let curlErr = "";
    curl.stderr.on("data", (d) => (curlErr += d.toString()));
    let tarErr = "";
    tar.stderr.on("data", (d) => (tarErr += d.toString()));

    tar.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extraction failed (code ${code}): ${tarErr}`));
    });
    curl.on("error", (err) => reject(new Error(`curl failed: ${err.message}`)));
    curl.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`curl exited with ${code}: ${curlErr}`));
      }
    });
  });

  // Atomically swap the workspace: old → .prev, new → workspace, then delete .prev
  const prev = `${workspacePath}.prev`;
  if (fs.existsSync(prev))
    fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(workspacePath)) fs.renameSync(workspacePath, prev);
  fs.renameSync(tmpExtract, workspacePath);
  fs.rmSync(prev, { recursive: true, force: true });

  const syncedAt = new Date().toISOString();
  logger.info(
    `[spoke-sync] Repositories synced from ${normalizedHubUrl} → ${workspacePath}`,
  );
  return { hubUrl: normalizedHubUrl, hubId, workspacePath, syncedAt };
}
