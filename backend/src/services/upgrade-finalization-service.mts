import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger/index.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand } from "../types.mjs";

const logger = createLogger("upgrade-finalization");

interface UpgradeMarker {
  previous_vmid?: string;
  new_vmid?: string;
  upgraded_at?: string;
  ve_context_key?: string;
}

/**
 * After a deployer self-upgrade, replace-ct.sh writes
 * `.pending-post-upgrade.json` into the NEW container's /config volume and
 * returns immediately — the old deployer keeps running until we stop it
 * here.
 *
 * On the new deployer's first boot we:
 *   1) SSH back to the PVE host and run host-stop-and-unlink-previous-
 *      deployer.sh against `previous_vmid` (pct unlock + pct stop --timeout
 *      30 + vol_unlink_persistent). This frees the static IP for us.
 *   2) Delete the marker so the procedure doesn't repeat on the next boot.
 *
 * The HTTP listener in proxvex.mts must not bind before this completes:
 * the old deployer still holds the IP until pct stop returns. The caller
 * awaits this function before app.listen.
 *
 * On failure the marker is intentionally left in place so the next start
 * tries again — that's the manual recovery path if the PVE host is
 * temporarily unreachable.
 */
export async function finalizeUpgradeIfPending(localPath: string): Promise<void> {
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

  logger.info("Post-upgrade finalization: stopping previous deployer", {
    from_vmid: marker.previous_vmid,
    to_vmid: marker.new_vmid,
    upgraded_at: marker.upgraded_at,
    ve_context_key: marker.ve_context_key,
  });

  if (!marker.previous_vmid) {
    logger.warn("Marker has no previous_vmid — cannot stop old deployer", {
      markerPath,
    });
    return;
  }

  try {
    await stopAndUnlinkPreviousDeployer(
      marker.previous_vmid,
      marker.ve_context_key,
    );
  } catch (err: any) {
    logger.error(
      "Stop+unlink of previous deployer failed — marker kept for retry on next boot",
      {
        previous_vmid: marker.previous_vmid,
        error: err?.message || String(err),
      },
    );
    return;
  }

  try {
    unlinkSync(markerPath);
    logger.info("Upgrade finalization complete; marker removed", { markerPath });
  } catch (err: any) {
    logger.warn("Failed to remove upgrade marker", {
      markerPath,
      error: err?.message,
    });
  }
}

/**
 * Run host-stop-and-unlink-previous-deployer.sh on the PVE host that owns
 * the previous deployer container.
 *
 * `veContextKey` from the marker is the preferred selector (replace-ct.sh
 * knew exactly which host it was on). If it's missing or stale (e.g. the
 * config file was rotated between deployer instances), we fall back to
 * scanning every registered VE context and using the first one where the
 * container exists.
 */
async function stopAndUnlinkPreviousDeployer(
  previousVmid: string,
  preferredContextKey: string | undefined,
): Promise<void> {
  const pm = PersistenceManager.getInstance();
  const contextManager = pm.getContextManager();
  const repositories = pm.getRepositories();

  const scriptContent = repositories.getScript({
    name: "host-stop-and-unlink-previous-deployer.sh",
    scope: "shared",
    category: "maintenance",
  });
  const libraryContent = repositories.getScript({
    name: "vol-common.sh",
    scope: "shared",
    category: "library",
  });
  if (!scriptContent || !libraryContent) {
    throw new Error(
      "host-stop-and-unlink-previous-deployer scripts not found in repositories",
    );
  }

  const candidateKeys: string[] = [];
  if (preferredContextKey) candidateKeys.push(preferredContextKey);
  for (const key of contextManager.keys()) {
    if (key.startsWith("ve_") && !candidateKeys.includes(key)) {
      candidateKeys.push(key);
    }
  }

  if (candidateKeys.length === 0) {
    throw new Error(
      "No VE contexts configured — cannot reach a PVE host to stop the previous deployer",
    );
  }

  const errors: string[] = [];
  for (const veKey of candidateKeys) {
    const veContext = contextManager.getVEContextByKey(veKey);
    if (!veContext) {
      errors.push(`${veKey}: context not found`);
      continue;
    }

    const cmd: ICommand = {
      name: "Stop and unlink previous deployer",
      execute_on: "ve",
      script: "host-stop-and-unlink-previous-deployer.sh",
      scriptContent,
      libraryContent,
      outputs: [],
    };

    const ve = new VeExecution(
      [cmd],
      [{ id: "vmid", value: String(previousVmid) }],
      veContext,
      new Map(),
      undefined,
      determineExecutionMode(),
    );

    try {
      await ve.run(null);
      logger.info("Previous deployer stopped and volumes unlinked", {
        previous_vmid: previousVmid,
        ve_context: veKey,
      });
      return;
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`${veKey}: ${msg}`);
      logger.warn(`Stop+unlink failed via ${veKey}, trying next context`, {
        error: msg,
      });
    }
  }

  throw new Error(
    `Could not stop previous deployer ${previousVmid} on any VE context: ${errors.join("; ")}`,
  );
}
