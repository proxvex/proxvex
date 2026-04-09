/**
 * VM lifecycle management for live integration tests.
 *
 * Handles the three-phase VM preparation:
 * 1. Snapshot restore (rollback to best matching snapshot)
 * 2. Pre-cleanup (reuse running VMs or destroy mismatched ones)
 * 3. Baseline rollback (for --all runs)
 */

import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, nestedSshStrict } from "./ssh-helpers.mjs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { PlannedScenario, ResolvedScenario } from "./livetest-types.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/**
 * Rollback to @baseline snapshot for --all runs.
 * Clears local context (passwords) since baseline has no stacks.
 */
export function rollbackToBaseline(
  config: { pveHost: string; vmId: number; portPveSsh: number; snapshot?: { enabled: boolean } },
  projectRoot: string,
): void {
  if (!config.snapshot?.enabled) return;

  const isLocalDeployer = true; // baseline rollback only used for dev instance
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;
  const snapMgr = new SnapshotManager(
    config.pveHost, config.vmId, config.portPveSsh,
    (msg) => logInfo(msg), localContextPath,
  );
  if (snapMgr.exists("baseline")) {
    logStep("Snapshot", "Rolling back to @baseline for --all run");
    snapMgr.rollback("baseline");
    if (localContextPath) {
      for (const f of ["storagecontext.json", "secret.txt"]) {
        const fp = path.join(localContextPath, f);
        if (existsSync(fp)) rmSync(fp);
      }
      logInfo("Local context cleared (baseline has no stacks)");
    }
  } else {
    logWarn("No @baseline snapshot found — skipping rollback");
  }
}

/**
 * Restore dependencies from the best available VM snapshot.
 * Must run BEFORE pre-cleanup so that the correct VMs are found running.
 */
export async function restoreBestSnapshot(
  planned: PlannedScenario[],
  allTests: Map<string, ResolvedScenario>,
  config: { pveHost: string; vmId: number; portPveSsh: number; deployerUrl: string; snapshot?: { enabled: boolean } },
  apiUrl: string,
  projectRoot: string,
): Promise<void> {
  const allDepIds = new Set([...allTests.values()].flatMap((s) => s.depends_on ?? []));
  const depSteps = planned.filter((p) => allDepIds.has(p.scenario.id));
  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  if (!config.snapshot?.enabled || depSteps.length === 0) return;

  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore */ }

  const snapMgr = new SnapshotManager(
    config.pveHost, config.vmId, config.portPveSsh,
    (msg) => logInfo(msg), localContextPath,
  );
  const depIds = depSteps.map((p) => p.scenario.id);
  const best = snapMgr.findBestSnapshot(depIds, buildHash);
  if (!best) return;

  try {
    logStep("Snapshot", `Restoring to @${best.name}`);
    snapMgr.rollback(best.name);

    // Stop ghost containers that are not dependencies in this run
    const depVmIds = new Set(depSteps.map((p) => p.vmId));
    try {
      const pctList = nestedSsh(config.pveHost, config.portPveSsh,
        `pct list 2>/dev/null | tail -n +2 | awk '{print $1}'`, 10000);
      for (const line of pctList.split("\n")) {
        const vmId = parseInt(line.trim(), 10);
        if (!isNaN(vmId) && !depVmIds.has(vmId)) {
          nestedSsh(config.pveHost, config.portPveSsh,
            `pct set ${vmId} --onboot 0 2>/dev/null; pct stop ${vmId} 2>/dev/null; true`, 15000);
        }
      }
    } catch {
      logInfo("Warning: ghost container cleanup failed (non-fatal)");
    }

    // Mark restored dependencies as skipped
    for (let j = 0; j <= best.index; j++) {
      depSteps[j]!.skipExecution = true;
    }

    // Reload deployer to pick up the restored context (stack passwords)
    // Retry with context re-restore if first attempt fails
    let reloaded = false;
    for (let attempt = 0; attempt < 2 && !reloaded; attempt++) {
      if (attempt > 0) {
        logInfo("Retrying context restore + reload...");
        snapMgr.restoreContextPublic();
      }
      for (const url of [apiUrl, apiUrl.replace("https://", "http://")]) {
        try {
          const r = await fetch(`${url}/api/reload`, { method: "POST", signal: AbortSignal.timeout(10000) });
          if (r.ok) { logInfo("Deployer reloaded after snapshot restore"); reloaded = true; break; }
        } catch { /* try next */ }
      }
    }
    if (!reloaded) {
      logInfo("Warning: deployer reload after snapshot restore failed — stacks may be stale");
    }

    logOk(`Dependencies restored from VM snapshot @${best.name}`);
  } catch (err) {
    logInfo(`VM snapshot restore failed, will install normally: ${err}`);
  }
}

/**
 * Pre-test cleanup: smart handling of dependencies vs targets.
 * - Dependencies: reuse if running + managed + correct app/stack, destroy otherwise
 * - Targets: always destroy (unless replace_ct task)
 */
export function prepareVms(
  planned: PlannedScenario[],
  config: { pveHost: string; portPveSsh: number },
  appStacktypes: Map<string, string | string[]>,
): void {
  for (const p of planned) {
    if (p.skipExecution) continue;

    let status: string;
    try {
      status = nestedSshStrict(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
    } catch (err: any) {
      logFail(`SSH connection failed during pre-cleanup: ${err.message}`);
      process.exit(1);
    }

    const task = p.scenario.task || "installation";
    if (p.isDependency && status.includes("running")) {
      let isManaged = false;
      let matchesApp = false;
      try {
        const notes = nestedSsh(config.pveHost, config.portPveSsh,
          `pct config ${p.vmId} 2>/dev/null | grep -a 'description:' | head -1`, 5000);
        isManaged = /oci-lxc-deployer(%3A|:)managed/.test(notes);
        if (isManaged) {
          const appMatch = notes.match(/application-id\s+(\S+)/);
          const appId = appMatch?.[1]?.replace(/%20/g, " ");
          const rawSt = appStacktypes.get(p.scenario.application);
          const sts = rawSt ? (Array.isArray(rawSt) ? rawSt : [rawSt]) : [];
          const expectedStackId = sts.length > 0 ? `${sts[0]}_${p.stackName}` : p.stackName;
          const stackMatch = notes.match(/stack-id\s+(\S+)/);
          const stackId = stackMatch?.[1]?.replace(/%20/g, " ");
          matchesApp = appId === p.scenario.application && (!stackId || stackId === expectedStackId);
        }
      } catch { /* treat as not managed */ }
      if (isManaged && matchesApp) {
        logOk(`Dependency VM ${p.vmId} (${p.scenario.id}) running — reusing`);
        p.skipExecution = true;
      } else if (isManaged) {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) running but wrong app/stack — destroying`);
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
          30000);
      } else {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) running but not managed — destroying`);
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
          30000);
      }
    } else if (REPLACE_CT_TASKS.includes(task) && status.includes("running")) {
      logOk(`VM ${p.vmId} (${p.scenario.id}) running — ${task} in place`);
    } else if (!p.isDependency || status.includes("status:")) {
      logInfo(`Destroying VM ${p.vmId} (${p.scenario.id})...`);
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
        30000);
    }

    if (!p.skipExecution && !REPLACE_CT_TASKS.includes(task)) {
      nestedSsh(config.pveHost, config.portPveSsh,
        `find /rpool/data -maxdepth 4 -type d -name ${JSON.stringify(p.hostname)} -path "*/volumes/*" -exec rm -rf {} + 2>/dev/null || true`,
        15000);
    }

    if (!p.skipExecution && !p.isDependency && !REPLACE_CT_TASKS.includes(task)) {
      const verify = nestedSsh(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
      if (verify.includes("status:")) {
        logFail(`Failed to destroy VM ${p.vmId} — aborting`);
        process.exit(1);
      }
    }
  }
}
