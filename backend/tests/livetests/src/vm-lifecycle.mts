/**
 * VM lifecycle management for live integration tests.
 *
 * Handles the three-phase VM preparation:
 * 1. Snapshot restore (rollback to best matching snapshot)
 * 2. Pre-cleanup (reuse running VMs or destroy mismatched ones)
 * 3. Baseline rollback (for --all runs)
 */

import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, nestedSshStrict, nestedSshAsync, withZfsCloneRelease } from "./ssh-helpers.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlannedScenario, ResolvedScenario } from "./livetest-types.mjs";
import { sanitizeScenarioIdForSnapshot } from "./livetest-types.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";
import { checkVolumeConsistency } from "./volume-consistency-check.mjs";

const BASELINE_QM_SNAPSHOT = "deployer-installed";

/**
 * SSH port on the OUTER PVE host. `qm` commands target the outer host where
 * the nested VM lives as a qemu guest; the runner's regular `pveSshPort` is
 * a port-forward INTO the nested VM (used for `pct` against inner LXCs).
 * Using the inner port for `qm <outer-vmid>` returns "Configuration file
 * 'nodes/pve-e2e-nested/qemu-server/<vmid>.conf' does not exist" because
 * the inner Proxmox has no record of the outer VM.
 */
const OUTER_PVE_SSH_PORT = 22;

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/**
 * Restore providers from the best-covering per-CT pct snapshot pre-pool.
 *
 * Schritt 3b der konvergierten Architektur: Whole-VM-`qm rollback` ist raus
 * (incompatible mit Parallelisierung); stattdessen wird **jeder Dep-CT mit
 * `pct rollback`** auf den selbstbeschreibend identifizierten Snapshot
 * zurückgesetzt. Container-lokal → andere Cluster bleiben unberührt.
 *
 * `depSnapshotName` darf null sein (z. B. `--all`, Multi-App-Subset): dann
 * findet keine Auflösung statt. Sonst sucht `SnapshotManager.findCoveringSnapshot`
 * den Snapshot, der auf jeder Dep-VMID existiert und dessen `members` den
 * Lauf abdeckt. Build-Hash-Mismatch wird nur geloggt, nicht abgelehnt.
 *
 * Baseline-Reset (qm) gehört nicht hierher — das übernimmt das
 * `--fresh`-Skill außerhalb des Runners.
 */
export async function restoreBestSnapshot(
  planned: PlannedScenario[],
  _allTests: Map<string, ResolvedScenario>,
  config: { pveHost: string; vmId: number; portPveSsh: number; deployerUrl: string; snapshot?: { enabled: boolean } },
  _apiUrl: string,
  projectRoot: string,
  depSnapshotName: string | null,
): Promise<void> {
  // Hinweis: `depSnapshotName` gilt nur für die *Create*-Seite (Phase-0
  // `<app>_deps`-Heuristik bzw. explizit `--snapshot <name>` Build-Modus).
  // Für die RESTORE-Seite scannen wir generell — Schritt 3b: jeder vorhandene
  // selbstbeschreibende pct-Snapshot, dessen `members ⊇ requiredDeps`, ist ein
  // gültiges Restore-Ziel, unabhängig von der CLI-Form. Damit kann ein zuvor
  // gebauter `oidc-base`-Snapshot auch von einem `--all` oder Multi-App-
  // Subset wiederverwendet werden.
  void depSnapshotName;

  // Dep-Steps = die vom Runner als isDependency markierten Plan-Einträge
  // (dependedOn-Logik aus live-test-runner.mts). Vorher wurde versucht über
  // allTests-depends_on zu rekonstruieren — das ist zu breit (zieht das
  // Target ein, wenn es irgendwo sonst Dep ist) und führt dann zu „kein
  // covering snapshot gefunden".
  const depSteps = planned.filter((p) => p.isDependency);
  if (!config.snapshot?.enabled || depSteps.length === 0) return;

  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore */ }

  const snapMgr = new SnapshotManager(
    config.pveHost, config.portPveSsh,
    (msg) => logInfo(msg), localContextPath,
  );

  const depVmids = depSteps.map((d) => d.vmId);
  const requiredMembers = depSteps.map((d) => d.scenario.id);
  let chosen: Awaited<ReturnType<typeof snapMgr.findCoveringSnapshot>>;
  try {
    chosen = await snapMgr.findCoveringSnapshot(depVmids, requiredMembers, buildHash);
  } catch (err) {
    logInfo(`Snapshot lookup failed (will install normally): ${err}`);
    return;
  }
  if (!chosen) {
    logInfo(`No pct snapshot covers required deps ${requiredMembers.join(", ")} on VMs ${depVmids.join(", ")} — providers will install fresh`);
    return;
  }

  try {
    logStep("Snapshot", `Restoring per-CT to @${chosen.name} (VMs ${depVmids.join(", ")})`);
    // Roll back each dep CT to the named snapshot in parallel — container-
    // local, no shared state, safe to do concurrently.
    await Promise.all(depVmids.map((vmid) => snapMgr.rollbackCtSnapshot(vmid, chosen!.name)));
    checkVolumeConsistency(
      config.pveHost, config.portPveSsh, projectRoot,
      `pct restore to ${chosen.name}`,
    );

    // Mark all stack-provider steps as already-installed.
    for (const dep of depSteps) {
      dep.skipExecution = true;
    }

    logOk(`Stack providers restored from @${chosen.name}`);
  } catch (err) {
    logInfo(`pct snapshot restore failed, will install normally: ${err}`);
  }
}

/**
 * Roll the **nested VM** back to the `deployer-installed` qm-snapshot, then
 * restart it and wait until SSH responds. Used at the start of `--all` and
 * `@file` runs to guarantee a clean baseline before the catalog members are
 * (re)built. Idempotent: returns early if the snapshot is missing on the
 * outer PVE host (in which case the operator should run `step2b` first).
 *
 * The inner port-forwarding (dnsmasq + iptables) is wiped by `qm rollback`;
 * the runner calls `setupPortForwarding` afterwards (existing pattern).
 */
export async function rollbackToBaseline(
  pveHost: string,
  pveSshPort: number,
  vmId: number,
): Promise<void> {
  logStep("Baseline", `Rolling nested VM ${vmId} back to qm snapshot @${BASELINE_QM_SNAPSHOT}`);

  // Check that the snapshot exists; refuse to attempt a rollback if it doesn't
  // (otherwise qm rollback wipes the VM with no recovery path). `qm
  // listsnapshot` runs on the OUTER PVE host (port 22) where the nested VM
  // lives as a qemu guest.
  let listOut = "";
  try {
    listOut = await nestedSshAsync(
      pveHost, OUTER_PVE_SSH_PORT,
      `qm listsnapshot ${vmId} 2>/dev/null || true`,
      15000,
    );
  } catch { /* fall through */ }
  if (!listOut.includes(BASELINE_QM_SNAPSHOT)) {
    logWarn(`qm snapshot @${BASELINE_QM_SNAPSHOT} not found on VM ${vmId} — skipping baseline rollback. Run e2e/step2b-install-deployer.sh first if you want a clean baseline.`);
    return;
  }

  // qm rollback stops + rolls + (depending on PVE version) optionally restarts.
  // We always issue an explicit `qm start` afterwards to make the post-state
  // deterministic across PVE versions, and then poll via the inner port-
  // forward until it accepts SSH (proxy for "the inner OS is ready").
  await nestedSshAsync(
    pveHost, OUTER_PVE_SSH_PORT,
    `qm rollback ${vmId} ${BASELINE_QM_SNAPSHOT}`,
    600000,
  );

  // qm rollback restores the snapshot's saved hardware config too — including
  // any cores/memory values frozen when the snapshot was taken. Snapshots
  // from older step2b runs were created with the default 2c/4G; under
  // `--all` parallel load those numbers caused softdog kernel-watchdog
  // resets, leaving SSH corrupt for ~5 min. Re-apply the current
  // config.json defaults (4c/8G) AFTER rollback, BEFORE start, so every
  // run gets the headroom we configured even when the snapshot is stale.
  // qm set on a stopped VM is cheap and idempotent.
  try {
    await nestedSshAsync(
      pveHost, OUTER_PVE_SSH_PORT,
      `qm set ${vmId} --cores 4 --memory 8192 2>/dev/null; true`,
      30000,
    );
  } catch { /* best-effort */ }

  await nestedSshAsync(
    pveHost, OUTER_PVE_SSH_PORT,
    `qm start ${vmId} 2>/dev/null; true`,
    60000,
  );

  // Wait up to 90 s for SSH to come back inside the nested VM. The readiness
  // probe runs against the INNER port-forward (`pveSshPort`) — pct list inside
  // the nested VM answers as soon as the inner pvedaemon is up. Loop in 3 s
  // steps to bound the worst case.
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const out = await nestedSshAsync(
        pveHost, pveSshPort,
        `pct list 2>/dev/null | head -1 || echo notready`,
        10000,
      );
      if (out.includes("VMID")) { ready = true; break; }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) {
    logWarn(`Inner VM ${vmId} did not respond within 90 s after qm rollback — proceeding anyway`);
  } else {
    logOk(`Nested VM ${vmId} rolled back to @${BASELINE_QM_SNAPSHOT} and responsive`);
  }

  // First `pct list` succeeded but subsequent SSH commands can still ETIMEDOUT
  // right after boot — sshd's first accept() works but the second connection
  // hits a slow path while pveproxy/pvedaemon finish initialising. Observed
  // in the runner's sync prepareVms loop (~60 pct-status calls back-to-back)
  // dying with `spawnSync /bin/sh ETIMEDOUT` on the second call. A short
  // settle period + a warmup pct list keeps the connection pool primed.
  await new Promise((r) => setTimeout(r, 5000));
  try {
    await nestedSshAsync(
      pveHost, pveSshPort,
      `pct list 2>/dev/null | wc -l`,
      15000,
    );
  } catch { /* warmup is best-effort */ }
}

/**
 * Pre-cleanup for single-scenario runs: enumerate all managed CTs in the
 * nested VM and destroy those that (a) have no pct snapshot AND (b) are not
 * needed by this run (not in `neededVmIds`). Runs in parallel; uses
 * `pct stop --timeout 1` (no graceful shutdown — state is discarded anyway).
 *
 * Snapshot-bearing CTs are NEVER destroyed: their snapshots are the rollback
 * surface for `--from-snapshot`, and once destroyed the snapshot is gone.
 */
export async function preCleanupNonSnapshotConsumers(
  pveHost: string,
  pveSshPort: number,
  neededVmIds: ReadonlySet<number>,
): Promise<void> {
  // Enumerate managed CTs (running OR stopped) — same predicate as the
  // janitor, but without the age filter. We also pull the description line
  // in the same SSH round-trip so we can skip the proxvex-deployer Hub-LXC
  // (application-id=proxvex), which carries the same `proxvex:managed`
  // marker as test CTs but must NEVER be destroyed.
  // Enumerate managed CTs (running OR stopped), and pull the canonical
  // `pct config` description line for each in the same SSH round-trip. The
  // raw /etc/pve/lxc/<vmid>.conf stores notes as `#<!-- urlencoded -->`
  // comment lines (see prepareVms which already uses `pct config | grep
  // description:` for the same reason). Templates write the notes correctly;
  // the read path is what failed previously — `^description:` does not exist
  // in the raw conf file.
  let listOut = "";
  try {
    listOut = await nestedSshAsync(
      pveHost, pveSshPort,
      `for f in /etc/pve/lxc/*.conf; do ` +
      `  [ -f "$f" ] || continue; ` +
      `  vmid=$(basename "$f" .conf); ` +
      `  grep -q 'proxvex%3Amanaged\\|proxvex:managed' "$f" 2>/dev/null || continue; ` +
      `  desc=$(pct config "$vmid" 2>/dev/null | grep -a '^description:' | head -1 | tr '\\n' ' '); ` +
      `  echo "$vmid|$desc"; ` +
      `done`,
      30000,
    );
  } catch (err) {
    logWarn(`Pre-cleanup enumeration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!listOut) return;

  const candidates: number[] = [];
  const skippedDeployer: number[] = [];
  for (const line of listOut.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf("|");
    const vmidStr = sepIdx >= 0 ? trimmed.slice(0, sepIdx) : trimmed;
    const desc = sepIdx >= 0 ? trimmed.slice(sepIdx + 1) : "";
    const vmid = Number.parseInt(vmidStr, 10);
    if (!Number.isFinite(vmid)) continue;
    if (neededVmIds.has(vmid)) continue;
    // Templates encode `application-id proxvex` in the notes for the
    // deployer Hub-LXC (proxvex managing itself). `pct config` decodes
    // %20→space, so we match a plain space here. The negative-lookahead
    // (`?!-`) avoids matching the test app `proxvex-playwright-oidc`.
    if (/application-id\s+proxvex(?![-\w])/.test(desc)) {
      skippedDeployer.push(vmid);
      continue;
    }
    candidates.push(vmid);
  }
  if (skippedDeployer.length > 0) {
    logInfo(`Pre-cleanup: skipping deployer Hub-LXC(s): ${skippedDeployer.join(", ")}`);
  }
  if (candidates.length === 0) {
    logInfo("Pre-cleanup: no candidates to inspect");
    return;
  }

  // For each candidate, list its pct snapshots in parallel. Keep candidates
  // with zero snapshots; skip the rest.
  const snapResults = await Promise.all(candidates.map(async (vmid) => {
    try {
      const out = await nestedSshAsync(
        pveHost, pveSshPort,
        `pct listsnapshot ${vmid} 2>/dev/null || true`,
        10000,
      );
      const hasSnapshot = /[`|]->\s+\S+\s+\d{4}-\d{2}-\d{2}/.test(out);
      return { vmid, hasSnapshot };
    } catch {
      return { vmid, hasSnapshot: false };
    }
  }));

  const toDestroy = snapResults.filter((r) => !r.hasSnapshot).map((r) => r.vmid);
  const kept = snapResults.filter((r) => r.hasSnapshot).map((r) => r.vmid);
  if (kept.length > 0) {
    logInfo(`Pre-cleanup: keeping ${kept.length} snapshot-bearing CT(s): ${kept.join(", ")}`);
  }
  if (toDestroy.length === 0) {
    logInfo("Pre-cleanup: no non-snapshot, non-needed CTs to destroy");
    return;
  }
  logStep("Pre-cleanup", `Destroying ${toDestroy.length} non-snapshot non-needed CT(s): ${toDestroy.join(", ")}`);

  await Promise.all(toDestroy.map(async (vmid) => {
    try {
      await nestedSshAsync(
        pveHost, pveSshPort,
        `pct stop ${vmid} --timeout 1 2>/dev/null; ${withZfsCloneRelease(vmid, `pct destroy ${vmid} --force --purge 2>/dev/null`)}; true`,
        60000,
      );
    } catch (err) {
      logWarn(`Pre-cleanup: destroy ${vmid} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
  logOk(`Pre-cleanup: ${toDestroy.length} CT(s) destroyed`);
}

/**
 * `--from-snapshot` path: for each transitive dep CT, either roll it back to
 * its pct snapshot (if one exists) or destroy it so `prepareVms` reinstalls
 * it fresh. Marks rolled-back deps as `skipExecution = true` so `prepareVms`
 * won't reinstall them. Container-local, parallel-safe.
 *
 * Naming convention: each dep CT gets its snapshot from the catalog member
 * whose transitive deps include it. We scan the CT's existing snapshots and
 * roll back to the most recent (any covering snapshot works; the executor
 * re-creates them after a successful test anyway).
 */
export async function rollbackOrDestroyDepsFromSnapshot(
  planned: PlannedScenario[],
  pveHost: string,
  pveSshPort: number,
  projectRoot: string,
): Promise<void> {
  const depSteps = planned.filter((p) => p.isDependency);
  if (depSteps.length === 0) {
    logWarn("--from-snapshot: no dependencies in plan, nothing to rollback");
    return;
  }
  const snapMgr = new SnapshotManager(
    pveHost, pveSshPort,
    (msg) => logInfo(msg),
    path.join(projectRoot, ".livetest-data"),
  );

  // Probe each dep CT's snapshot list in parallel.
  const probes = await Promise.all(depSteps.map(async (dep) => {
    try {
      const snaps = await snapMgr.listCtSnapshots(dep.vmId);
      return { dep, snaps };
    } catch {
      return { dep, snaps: [] };
    }
  }));

  // Partition: rollback if any snapshot exists; destroy otherwise.
  const toRollback = probes.filter((p) => p.snaps.length > 0);
  const toDestroy = probes.filter((p) => p.snaps.length === 0);

  if (toRollback.length === 0 && toDestroy.length === 0) {
    return;
  }

  await Promise.all([
    ...toRollback.map(async ({ dep, snaps }) => {
      // Pick the most recently created snapshot (snaps are already in pct
      // listsnapshot order — newest last per Proxmox; pick last).
      const chosen = snaps[snaps.length - 1]!;
      try {
        await snapMgr.rollbackCtSnapshot(dep.vmId, chosen.name);
        dep.skipExecution = true;
        logOk(`--from-snapshot: VM ${dep.vmId} (${dep.scenario.id}) → @${chosen.name}`);
      } catch (err) {
        logWarn(`--from-snapshot: rollback VM ${dep.vmId} to @${chosen.name} failed (will reinstall): ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    ...toDestroy.map(async ({ dep }) => {
      try {
        await nestedSshAsync(
          pveHost, pveSshPort,
          `pct stop ${dep.vmId} --timeout 1 2>/dev/null; ${withZfsCloneRelease(dep.vmId, `pct destroy ${dep.vmId} --force --purge 2>/dev/null`)}; true`,
          60000,
        );
        logInfo(`--from-snapshot: VM ${dep.vmId} (${dep.scenario.id}) had no snapshot → destroyed for fresh install`);
      } catch (err) {
        logWarn(`--from-snapshot: destroy VM ${dep.vmId} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  ]);
}

/**
 * Threshold above which `--all`/`@file` runs prefer a single `qm rollback`
 * over N parallel `pct destroy` calls. Below the threshold per-CT destroys
 * (each finishes in ~1-2 s with `pct stop --timeout 1`) are faster than the
 * ~30 s qm-rollback round-trip. Tuned for the typical "many leftovers from
 * an aborted full-suite run" case.
 */
const ROLLBACK_THRESHOLD = 20;

/**
 * Enumerate the VMIDs of all managed CTs currently in the nested VM in ONE
 * SSH round-trip. Excludes the proxvex-deployer Hub-LXC (application-id =
 * "proxvex") — it must never be wiped. Result is the canonical "what's
 * already on disk" view consumed by both the smart-cleanup branch
 * (rollback-vs-destroy decision) and `prepareVms` (skip no-op destroys for
 * CTs that don't exist).
 */
export async function listExistingTestCts(
  pveHost: string,
  sshPort: number,
): Promise<Set<number>> {
  try {
    const out = await nestedSshAsync(
      pveHost, sshPort,
      `for f in /etc/pve/lxc/*.conf; do ` +
      `  [ -f "$f" ] || continue; ` +
      `  vmid=$(basename "$f" .conf); ` +
      `  grep -q 'proxvex%3Amanaged\\|proxvex:managed' "$f" 2>/dev/null || continue; ` +
      `  grep -q 'proxvex%3Adeployer-instance\\|proxvex:deployer-instance' "$f" 2>/dev/null && continue; ` +
      `  echo "$vmid"; ` +
      `done`,
      15000,
    );
    const set = new Set<number>();
    for (const line of out.split("\n")) {
      const vmid = Number.parseInt(line.trim(), 10);
      if (Number.isFinite(vmid)) set.add(vmid);
    }
    return set;
  } catch {
    return new Set();
  }
}

/**
 * Smart pre-run cleanup for `--all` / `@file` modes: enumerate existing
 * managed CTs once, then either
 *   - **rollback** the whole nested VM to `deployer-installed` (1 op, ~30 s)
 *     when many CTs need to go (count >= ROLLBACK_THRESHOLD). For `--all` the
 *     CTs get reinstalled from scratch anyway, so wiping pct snapshots is
 *     acceptable — they're disposable artifacts of the previous run.
 *   - **per-CT destroy** in parallel (each ~1-2 s with `pct stop --timeout 1`)
 *     when few CTs exist. Faster than a 30 s rollback for the small-cleanup
 *     case (catalog-only @file rerun, light leftovers).
 *
 * Returns the set of VMIDs that REMAIN after cleanup, so `prepareVms` can
 * skip its (now-redundant) per-CT existence probe.
 */
export async function smartCleanupBeforeRun(
  pveHost: string,
  pveSshPort: number,
  vmId: number,
  plannedVmIds: ReadonlySet<number>,
): Promise<Set<number>> {
  const existing = await listExistingTestCts(pveHost, pveSshPort);
  // CTs to remove = existing minus those the run will reuse (planned). The
  // planned-set check matters for @file: catalog dep CTs from a prior run
  // should be REUSED, not destroyed, so they're excluded from the count.
  const toRemove: number[] = [];
  for (const vmid of existing) {
    if (!plannedVmIds.has(vmid)) toRemove.push(vmid);
  }
  if (toRemove.length === 0) {
    logInfo(`Smart cleanup: 0 leftover CTs, nothing to do`);
    return existing;
  }
  if (toRemove.length >= ROLLBACK_THRESHOLD) {
    logInfo(`Smart cleanup: ${toRemove.length} leftover CTs ≥ ${ROLLBACK_THRESHOLD} threshold → qm rollback (faster than per-CT)`);
    await rollbackToBaseline(pveHost, pveSshPort, vmId);
    return new Set(); // rollback wipes all test CTs
  }
  logInfo(`Smart cleanup: ${toRemove.length} leftover CTs < ${ROLLBACK_THRESHOLD} threshold → parallel per-CT destroy`);
  await Promise.all(toRemove.map(async (id) => {
    try {
      await nestedSshAsync(
        pveHost, pveSshPort,
        `pct stop ${id} --timeout 1 2>/dev/null; ${withZfsCloneRelease(id, `pct destroy ${id} --force --purge 2>/dev/null`)}; true`,
        60000,
      );
    } catch (err) {
      logWarn(`Smart cleanup: destroy ${id} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
  // After destroy: surviving CTs are those in `existing` AND `plannedVmIds`.
  const remaining = new Set<number>();
  for (const id of existing) {
    if (plannedVmIds.has(id)) remaining.add(id);
  }
  return remaining;
}

/**
 * Compute the catalog member name that owns the snapshot for a given dep
 * VM-id in the planned set. Used by the per-member-snapshot path in the
 * executor to derive the snapshot name from the scenario id. Returns null
 * when no catalog member's transitive deps include the vmid.
 */
export function ownerCatalogMember(
  vmId: number,
  planned: PlannedScenario[],
  allTests: Map<string, ResolvedScenario>,
  catalog: ReadonlySet<string>,
): string | null {
  for (const p of planned) {
    if (!catalog.has(p.scenario.id)) continue;
    const transitiveIds = transitiveDepClosure(p.scenario.id, allTests);
    for (const id of transitiveIds) {
      const dep = planned.find((q) => q.scenario.id === id);
      if (dep?.vmId === vmId) return sanitizeScenarioIdForSnapshot(p.scenario.id);
    }
  }
  return null;
}

function transitiveDepClosure(
  id: string,
  all: Map<string, ResolvedScenario>,
  visited: Set<string> = new Set(),
): Set<string> {
  if (visited.has(id)) return visited;
  visited.add(id);
  const s = all.get(id);
  if (!s) return visited;
  for (const dep of s.depends_on ?? []) {
    transitiveDepClosure(dep, all, visited);
  }
  return visited;
}

/**
 * Janitor: asynchron managed stopped CTs > 1 h post-stop weg­räumen.
 *
 * Consumer-Teardown legt Containers per `pct stop` (kein destroy) ab → 1 h
 * Forensik-Fenster. Beim nächsten Lauf-Start räumt dieser Janitor alle
 * stopped, managed CTs ab, deren Stop-mtime von `/etc/pve/lxc/<vmid>.conf`
 * älter als der TTL ist. Fire-and-forget: blockiert die Test-Ausführung
 * nicht; die `pct destroy`-Aufrufe laufen im Hintergrund weiter, während
 * Phase prepareVms + Stack-Setup + Szenarien starten.
 */
function runJanitorAsync(
  pveHost: string,
  sshPort: number,
  plannedVmIds: ReadonlySet<number>,
  ttlSeconds: number = 3600,
): void {
  void (async () => {
    try {
      // Enumerate stopped CTs and their conf-mtimes. Skip planned VMIDs
      // (those are handled by the existing prepareVms destroy-path).
      const out = await nestedSshAsync(
        pveHost, sshPort,
        `for f in /etc/pve/lxc/*.conf; do ` +
        `  [ -f "$f" ] || continue; ` +
        `  vmid=$(basename "$f" .conf); ` +
        `  st=$(pct status "$vmid" 2>/dev/null | awk '{print $2}'); ` +
        `  [ "$st" = "stopped" ] || continue; ` +
        `  grep -q 'proxvex%3Amanaged\\|proxvex:managed' "$f" 2>/dev/null || continue; ` +
        `  mt=$(stat -c %Y "$f" 2>/dev/null); ` +
        `  [ -n "$mt" ] && echo "$vmid $mt"; ` +
        `done`,
        15000,
      );
      if (!out) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const stale: number[] = [];
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 2) continue;
        const vmid = Number.parseInt(parts[0]!, 10);
        const mtime = Number.parseInt(parts[1]!, 10);
        if (!Number.isFinite(vmid) || !Number.isFinite(mtime)) continue;
        if (plannedVmIds.has(vmid)) continue;
        if (nowSec - mtime <= ttlSeconds) continue;
        stale.push(vmid);
      }
      if (stale.length === 0) return;
      logInfo(`Janitor: ${stale.length} stale stopped CT(s) > ${ttlSeconds}s old → async destroy: ${stale.join(", ")}`);
      // Fire-and-forget destroys (no await on the outer caller); errors
      // logged but never re-thrown to the test pipeline.
      await Promise.all(stale.map(async (vmid) => {
        try {
          await nestedSshAsync(
            pveHost, sshPort,
            `${withZfsCloneRelease(vmid, `pct destroy ${vmid} --force --purge 2>/dev/null`)}; true`,
            60000,
          );
        } catch (err) {
          logWarn(`Janitor: destroy ${vmid} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
      logOk(`Janitor: ${stale.length} CT(s) destroyed`);
    } catch (err) {
      logWarn(`Janitor: enumeration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

/**
 * Pre-test cleanup: smart handling of dependencies vs targets.
 * - Dependencies: reuse if running + managed + correct app/stack, destroy otherwise
 * - Targets: always destroy (unless replace_ct task)
 *
 * Additionally fires a non-blocking janitor pass that destroys managed
 * stopped CTs older than the TTL (1 h post-stop) in the background.
 */
export function prepareVms(
  planned: PlannedScenario[],
  config: { pveHost: string; portPveSsh: number },
  appStacktypes: Map<string, string | string[]>,
): void {
  // Background janitor: managed stopped CTs > 1 h are async-destroyed.
  // Planned VMIDs are skipped (handled below by the synchronous destroy
  // path).
  const plannedVmIds = new Set(planned.map((p) => p.vmId));
  runJanitorAsync(config.pveHost, config.portPveSsh, plannedVmIds);

  for (const p of planned) {
    if (p.skipExecution) continue;

    // Clear stale locks from aborted runs
    try {
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct unlock ${p.vmId} 2>/dev/null; true`, 15000);
    } catch { /* ignore */ }

    // Remove a leftover source-isolation clone (1000 + vmId). A scenario that
    // dies between `pct clone` and its own cleanup leaves the clone behind,
    // and because the clone id is derived from the source it blocks *every*
    // later run of that scenario — observed as
    // "no free VMID found between ..." on a CT stuck in lock=destroyed.
    // Unlock first: a half-destroyed CT refuses `pct destroy` while locked.
    try {
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct status ${1000 + p.vmId} >/dev/null 2>&1 `
        + `&& { pct unlock ${1000 + p.vmId} 2>/dev/null; `
        + withZfsCloneRelease(1000 + p.vmId, `pct destroy ${1000 + p.vmId} --purge 2>/dev/null`)
        + `; }; true`,
        60000);
    } catch { /* ignore */ }

    let status: string;
    try {
      status = nestedSshStrict(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 30000);
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
          `pct stop ${p.vmId} 2>/dev/null || true; ${withZfsCloneRelease(p.vmId, `pct destroy ${p.vmId} --force --purge 2>/dev/null`)} || true`,
          30000);
      } else {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) running but not managed — destroying`);
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${p.vmId} 2>/dev/null || true; ${withZfsCloneRelease(p.vmId, `pct destroy ${p.vmId} --force --purge 2>/dev/null`)} || true`,
          30000);
      }
    } else if (REPLACE_CT_TASKS.includes(task) && status.includes("running")) {
      logOk(`VM ${p.vmId} (${p.scenario.id}) running — ${task} in place`);
    } else if (status.includes("status:")) {
      // Only destroy when the CT actually exists (pct status reports
      // "status: running|stopped"). After a `qm rollback` to baseline, all
      // test CT configs are gone, so `pct status` returns "not found" —
      // calling `pct destroy` then is a 30 s SSH no-op per scenario
      // (60+ for `--all`). Skip the entire block when there's nothing to
      // destroy; the scenario will create the CT fresh during install.
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
        `pct stop ${p.vmId} 2>/dev/null || true; ${withZfsCloneRelease(p.vmId, `pct destroy ${p.vmId} --force --purge 2>/dev/null`)} || true; ` +
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

/**
 * The reconfigure clone script exactly as the deployer runs it: the libraries
 * listed in `create_ct/100-create-ct-clone.json`, then `create-ct-clone.sh`,
 * with source and target filled in. Isolating a scenario's source through it
 * gives the runner the production code path — an instant `zfs clone` of the
 * rootfs on zfspool storage (`pct clone --full` elsewhere), notes carried
 * over, and the clone snapshot removed by the script's trap on any abort.
 * Run it with `sh -s` (stdin) on the PVE host.
 */
export function buildCreateCtCloneScript(
  projectRoot: string,
  sourceVmId: number,
  targetVmId: number,
): string {
  const scriptsDir = path.join(projectRoot, "json/shared/scripts");
  const template = JSON.parse(
    readFileSync(path.join(projectRoot, "json/shared/templates/create_ct/100-create-ct-clone.json"), "utf-8"),
  ) as { commands: { script?: string; library?: string | string[] }[] };
  const cmd = template.commands.find((c) => c.script === "create-ct-clone.sh");
  if (!cmd) throw new Error("100-create-ct-clone.json has no create-ct-clone.sh command");
  const libraries = cmd.library === undefined ? [] : Array.isArray(cmd.library) ? cmd.library : [cmd.library];
  const readScript = (name: string, subdirs: string[]): string => {
    for (const dir of subdirs) {
      try {
        return readFileSync(path.join(scriptsDir, dir, name), "utf-8");
      } catch { /* try next location */ }
    }
    throw new Error(`script ${name} not found under ${scriptsDir}`);
  };
  const parts = [
    ...libraries.map((lib) => readScript(lib, ["library", "."])),
    readScript("create-ct-clone.sh", ["create_ct"]),
  ];
  const vars: Record<string, string> = {
    previous_vm_id: String(sourceVmId),
    vm_id: String(targetVmId),
    vm_id_start: "",
    searchdomain: "",
  };
  return parts.join("\n").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => vars[key] ?? m);
}
