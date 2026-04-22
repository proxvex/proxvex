import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("upgrade-finalization");

interface UpgradeMarker {
  previous_vmid?: string;
  new_vmid?: string;
  upgraded_at?: string;
}

/**
 * After a deployer self-upgrade, a marker file is written into the /config
 * volume of the NEW container by schedule-deployer-upgrade.sh. When the new
 * deployer starts for the first time, this function detects the marker and
 * runs whatever post-upgrade tasks are needed, then deletes the marker.
 *
 * Tasks today:
 *   - log the upgrade event
 *
 * Planned additions (deferred to keep this hook minimal):
 *   - re-run post-update-version-from-docker on own VMID (update Notes version)
 *   - emit a one-time toast in the UI informing about the completed upgrade
 *   - optional automatic cleanup of the previous container (pct destroy)
 *
 * The marker is intentionally removed only on successful processing — if we
 * crash before cleanup, the next start tries again.
 */
export function finalizeUpgradeIfPending(localPath: string): void {
  // localPath is the --local argument (e.g. /config). The marker lives at the
  // root of that directory so it's always reachable regardless of subdir layout.
  const markerPath = path.join(localPath, ".pending-post-upgrade.json");
  if (!existsSync(markerPath)) return;

  let marker: UpgradeMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf-8")) as UpgradeMarker;
  } catch (err: any) {
    logger.warn("Upgrade marker found but could not be parsed", {
      markerPath,
      error: err?.message,
    });
    return;
  }

  logger.info("Post-upgrade finalization: deployer was upgraded", {
    from_vmid: marker.previous_vmid,
    to_vmid: marker.new_vmid,
    upgraded_at: marker.upgraded_at,
  });

  try {
    unlinkSync(markerPath);
    logger.info("Upgrade marker removed", { markerPath });
  } catch (err: any) {
    logger.warn("Failed to remove upgrade marker", {
      markerPath,
      error: err?.message,
    });
  }
}
