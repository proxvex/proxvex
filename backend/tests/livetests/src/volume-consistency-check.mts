/**
 * Post-rollback volume consistency check.
 *
 * Concatenates the libraries the template engine would prepend (pve-common.sh,
 * vol-common.sh) with host-check-volume-consistency.sh and pipes the combined
 * script via stdin to ssh on the nested-VM. Intended to be called after every
 * snapshot rollback to detect orphan volumes / dangling ZFS snapshots — the
 * Briefing's Cluster-1 (ZFS volume cleanup) and Cluster-3 (snapshot-restore)
 * issues both surface as orphans visible right after a rollback.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { nestedSshStrict } from "./ssh-helpers.mjs";
import { logOk, logFail, logInfo } from "./log-helpers.mjs";

/**
 * Run the volume consistency check on the PVE host.
 * Returns true on clean, false on orphans found. Never throws — diagnostic
 * output goes to logFail/logInfo so the caller can decide whether to abort.
 */
export function checkVolumeConsistency(
  pveHost: string,
  sshPort: number,
  projectRoot: string,
  context: string,
): boolean {
  const lib = path.join(projectRoot, "json/shared/scripts/library");
  const script = path.join(
    projectRoot,
    "json/shared/scripts/check/host-check-volume-consistency.sh",
  );

  let combined: string;
  try {
    combined =
      readFileSync(path.join(lib, "pve-common.sh"), "utf8") +
      readFileSync(path.join(lib, "vol-common.sh"), "utf8") +
      readFileSync(script, "utf8");
  } catch (err) {
    logInfo(`Volume consistency check skipped (script load failed): ${err}`);
    return true;
  }

  try {
    nestedSshStrict(pveHost, sshPort, "sh -s", 60000, combined);
    logOk(`Volume consistency check passed (${context})`);
    return true;
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const stderr = (e.stderr ?? "").trim();
    const stdout = (e.stdout ?? "").trim();
    logFail(`Volume consistency check FAILED (${context})`);
    if (stderr) {
      for (const line of stderr.split("\n")) logInfo(line);
    } else if (e.message) {
      logInfo(e.message);
    }
    if (stdout) logInfo(`(stdout): ${stdout}`);
    return false;
  }
}
