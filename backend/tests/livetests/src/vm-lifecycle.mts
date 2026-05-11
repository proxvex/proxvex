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
import { checkVolumeConsistency } from "./volume-consistency-check.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/**
 * Write the project-defaults template into the deployer LXC and trigger
 * `/api/reload` so post-start-dockerd.sh sees `docker_registry_mirror` +
 * `ghcr_registry_mirror` on the next install/reconfigure.
 *
 * step2b-install-deployer.sh writes this into the `deployer-installed`
 * snapshot, but snapshots created before that change (or `dep-*` snapshots
 * built on top of an older `deployer-installed`) lack the file. Without it
 * the daemon.json produced by 307-post-start-dockerd has no
 * `registry-mirrors` and dockerd pulls registry-1.docker.io via DNS — the
 * production mirror returns 0-byte layer bodies (HTTP/2 framing bug) →
 * docker pull dies with `unexpected EOF`. Call this after every rollback.
 */
export async function ensureProjectDefaults(
  config: { pveHost: string; portPveSsh: number },
  apiUrl: string,
  deployerVmid = 300,
): Promise<void> {
  const projectDefaults = JSON.stringify({
    name: "Set Project Parameters (test)",
    description: "Project defaults for the livetest deployer.",
    commands: [{
      properties: [
        { id: "vm_id_start", default: "301" },
        { id: "docker_registry_mirror", default: "https://docker-mirror-test" },
        { id: "ghcr_registry_mirror", default: "https://zot-mirror" },
      ],
    }],
  });
  const targetPath = "/config/shared/templates/create_ct/050-set-project-parameters.json";
  // base64 encode to avoid newline/quoting issues through the ssh + pct exec pipeline
  // (JSON.stringify in nestedSshStrict escapes real newlines into `\n`, which breaks heredocs).
  const b64 = Buffer.from(projectDefaults).toString("base64");
  try {
    nestedSshStrict(config.pveHost, config.portPveSsh,
      `pct exec ${deployerVmid} -- mkdir -p /config/shared/templates/create_ct`, 10000);
    nestedSshStrict(config.pveHost, config.portPveSsh,
      `pct exec ${deployerVmid} -- sh -c 'echo ${b64} | base64 -d > ${targetPath}'`,
      10000);
    nestedSsh(config.pveHost, config.portPveSsh,
      `pct exec ${deployerVmid} -- sh -c 'chown -R $(stat -c %u:%g /config) /config/shared'`, 5000);

    // The local Spoke caches Hub repositories under .hubs/<id>/local/ via
    // /api/hub/repositories.tar.gz at startup. Writing to the Hub's /config
    // directly is invisible to the Spoke until we trigger a fresh sync.
    let synced = false;
    for (const url of [apiUrl, apiUrl.replace("https://", "http://")]) {
      try {
        const r = await fetch(`${url}/api/spoke/sync`, { method: "POST", signal: AbortSignal.timeout(15000) });
        if (r.ok) { synced = true; break; }
      } catch { /* try next */ }
    }
    if (!synced) logWarn("Project defaults written to Hub but /api/spoke/sync failed — Spoke may not see them");

    for (const url of [apiUrl, apiUrl.replace("https://", "http://")]) {
      try {
        const r = await fetch(`${url}/api/reload`, { method: "POST", signal: AbortSignal.timeout(10000) });
        if (r.ok) { logInfo("Project defaults written + Spoke synced + deployer reloaded"); return; }
      } catch { /* try next */ }
    }
    logWarn("Project defaults written but /api/reload failed — defaults may pick up at next deployer restart");
  } catch (err: any) {
    logWarn(`Could not ensure project defaults (non-fatal): ${err.message}`);
  }
}

/**
 * Rollback to @baseline snapshot for --all runs.
 * Clears local context (passwords) since baseline has no stacks.
 */
export async function rollbackToBaseline(
  config: { pveHost: string; vmId: number; portPveSsh: number; snapshot?: { enabled: boolean } },
  projectRoot: string,
  apiUrl?: string,
): Promise<void> {
  if (!config.snapshot?.enabled) return;

  const isLocalDeployer = true; // baseline rollback only used for dev instance
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;
  const snapMgr = new SnapshotManager(
    config.pveHost, config.vmId, config.portPveSsh,
    (msg) => logInfo(msg), localContextPath,
  );
  // Prefer deployer-installed snapshot (includes mirrors + Docker setup from step2),
  // fall back to baseline (clean VM without deployer)
  const rollbackTarget = snapMgr.exists("deployer-installed") ? "deployer-installed" : "baseline";
  if (snapMgr.exists(rollbackTarget)) {
    logStep("Snapshot", `Rolling back to @${rollbackTarget} for --all run`);
    snapMgr.rollbackHostSnapshot(rollbackTarget);
    checkVolumeConsistency(
      config.pveHost, config.portPveSsh, projectRoot,
      `baseline rollback to ${rollbackTarget}`,
    );
    if (localContextPath) {
      for (const f of ["storagecontext.json", "secret.txt"]) {
        const fp = path.join(localContextPath, f);
        if (existsSync(fp)) rmSync(fp);
      }
      logInfo("Local context cleared (baseline has no stacks)");
    }
    if (apiUrl) await ensureProjectDefaults(config, apiUrl);
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

  // Single-snapshot strategy: if dep-stacks-ready exists AND matches the
  // current build hash, roll the whole nested VM back to it and skip all
  // provider installations.
  const SNAP_NAME = "dep-stacks-ready";
  if (!snapMgr.exists(SNAP_NAME) || !snapMgr.matchesBuild(SNAP_NAME, buildHash)) {
    return;
  }

  try {
    logStep("Snapshot", `Restoring to @${SNAP_NAME}`);
    snapMgr.rollbackHostSnapshot(SNAP_NAME);
    checkVolumeConsistency(
      config.pveHost, config.portPveSsh, projectRoot,
      `restore to ${SNAP_NAME}`,
    );

    // Mark all stack-provider steps as already-installed (the snapshot
    // captured them all in one consistent state).
    for (const dep of depSteps) {
      dep.skipExecution = true;
    }

    // Write project defaults (registry-mirrors etc.) into the restored
    // deployer so post-start-dockerd.sh sees them on the next install/
    // reconfigure. ensureProjectDefaults also calls /api/reload, so this
    // subsumes the reload step below.
    await ensureProjectDefaults(config, apiUrl);

    // Reload deployer to pick up the restored context (stack passwords).
    // ensureProjectDefaults already reloaded once; we still retry here to
    // give snapMgr.restoreContextPublic() a chance if the first reload
    // missed something.
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

    logOk(`Stack providers restored from @${SNAP_NAME}`);
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

    // Clear stale locks from aborted runs
    try {
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct unlock ${p.vmId} 2>/dev/null; true`, 5000);
    } catch { /* ignore */ }

    let status: string;
    try {
      status = nestedSshStrict(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
    } catch (err: any) {
      logFail(`SSH connection failed during pre-cleanup: ${err.message}`);
      process.exit(1);
    }

    const task = p.scenario.task || "installation";
    const isRunning = status.includes("running");
    const isStopped = status.includes("stopped");
    if (p.isDependency && (isRunning || isStopped)) {
      let isManaged = false;
      let matchesApp = false;
      try {
        const notes = nestedSsh(config.pveHost, config.portPveSsh,
          `pct config ${p.vmId} 2>/dev/null | grep -a 'description:' | head -1`, 5000);
        isManaged = /proxvex(%3A|:)managed/.test(notes);
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
        if (isStopped) {
          logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) stopped — starting`);
          nestedSsh(config.pveHost, config.portPveSsh,
            `pct start ${p.vmId}`, 30000);
        }
        logOk(`Dependency VM ${p.vmId} (${p.scenario.id}) ${isRunning ? "running" : "started"} — reusing`);
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
      // Release any leftover host-side LV mounts first — vol_mount
      // (used on LVM/LVM-thin storage) leaves /var/lib/pve-vol-mounts/<volname>
      // mounted on failure paths, and `pct destroy` then fails with
      // "Logical volume contains a filesystem in use". Parse mp volids from
      // the container config before we shut it down.
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct config ${p.vmId} 2>/dev/null | awk '/^mp[0-9]+:/ {sub(/^mp[0-9]+:[[:space:]]+/, ""); n=split($0,a,","); print a[1]}' | while IFS= read -r vid; do ` +
        `  [ -z "$vid" ] && continue; ` +
        `  mnt="/var/lib/pve-vol-mounts/\${vid#*:}"; ` +
        `  mountpoint -q "$mnt" 2>/dev/null && { umount "$mnt" 2>/dev/null || umount -l "$mnt" 2>/dev/null; rmdir "$mnt" 2>/dev/null; }; ` +
        `done; ` +
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true; ` +
        // Sweep orphan LVs from a crashed pct clone / pct destroy. When a
        // reconfigure aborts mid-way, the cloned-and-renamed LV (e.g.
        // vm-224-proxvex-config) survives in LVM but is no longer registered
        // with any container, so the next reconfigure for the same VMID
        // hits "Logical Volume already exists". Match the VMID prefix.
        `command -v lvs >/dev/null 2>&1 && lvs --noheadings -o vg_name,lv_name 2>/dev/null | awk -v vmid=${p.vmId} '$2 ~ "^vm-"vmid"-" {print $1"/"$2}' | xargs -r -n1 lvremove -f >/dev/null 2>&1 || true`,
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
