/**
 * Scenario execution engine for live integration tests.
 *
 * Runs planned scenarios sequentially: builds CLI parameters, executes the CLI,
 * verifies results, writes test results, and creates snapshots for dependencies.
 */

import { runCli, type CliJsonResult } from "./cli-executor.mjs";
import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, nestedSshAsync, nestedSshStrictAsync, waitForServices, waitForContainerStable, waitForLxcInit } from "./ssh-helpers.mjs";
import { buildParams, partitionAfterFailure, classifyParallel, assignStoragePerScenario } from "./scenario-planner.mjs";
import { TestResultWriter, type TestResultDependency } from "./test-result-writer.mjs";
import { collectFailureLogs } from "./diagnostics.mjs";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario, TestResult, RunMode } from "./livetest-types.mjs";
import { sanitizeScenarioIdForSnapshot } from "./livetest-types.mjs";
import { Verifier, buildDefaultVerify, type AppMeta } from "./verifier.mjs";
import { logOk, logFail, logWarn, logInfo, logStep, scenarioLogContext, type ScenarioLogContext } from "./log-helpers.mjs";
import { enumerateParallelStorages } from "./live-test-runner.mjs";
import { checkVolumeConsistency } from "./volume-consistency-check.mjs";
import { collectScenarioEnv } from "./scenario-env.mjs";
import { writeRunOverviewHtml, writeRunOverviewJson, type RunOverviewState, type ScenarioStatus } from "./run-overview.mjs";
import { overviewPortForDeployer, startRunOverviewServer, type RunOverviewServer } from "./run-overview-server.mjs";
import { runnerHttpJson, type RunnerAuthContext } from "./runner-http.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/**
 * Emit a single worker-timeline event on STDERR. Separate from the normal
 * stdout stream so operators can redirect it independently (`2> worker.log`)
 * without losing the scenario-context logs. One line per event; columns are
 * fixed-width for visual scanning, scenario+extra at the right edge for
 * easy `awk`/`grep`.
 *
 * Kinds: start, wait, resume, done, fail
 *   start  — worker took the storage and dispatched the scenario
 *   wait   — scenario was ready but its storage was busy (logged once per gate)
 *   resume — gated scenario got dispatched after the storage freed
 *   done   — scenario finished successfully; storage released
 *   fail   — scenario failed/crashed; storage released
 */
function logWorkerTimeline(
  kind: "start" | "wait" | "resume" | "done" | "fail",
  storage: string | undefined,
  scenarioId: string,
  extra?: string,
): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const storageCol = (storage ?? "—").padEnd(14);
  const kindCol = kind.toUpperCase().padEnd(6);
  const line = `[${ts}] worker ${storageCol} ${kindCol} ${scenarioId}` +
    (extra ? `  ${extra}` : "");
  process.stderr.write(line + "\n");
}

/** Options accepted by both executor drivers (sequential + parallel). */
export interface ExecuteScenariosOptions {
  failFast?: boolean;
  debugLevel?: string;
  depSnapshotName?: string | null;
  concurrency?: number;
  snapshotMode?: string | null;
  volumeStorageOverride?: string;
  /** New run-mode classification — drives teardown-skip and per-member
   * snapshot semantics. Undefined treated as `single` for legacy callers. */
  runMode?: RunMode;
  /** Curated set of scenario ids whose CT + transitive dep CTs get a pct
   * snapshot after a successful test. Independent of `depSnapshotName`. */
  snapshotCatalog?: ReadonlySet<string>;
  /** Fallback CLI-execute timeout (seconds) for scenarios that don't set
   * `cli_timeout` in test.json. Per-scenario value still wins; this only
   * shifts the default away from cli-executor's hardcoded 600 s. Useful
   * when parallel runs push per-scenario duration past the default. */
  cliTimeoutSec?: number;
  /** Externally-owned run-overview (server + state) — when set, the executor
   * only seeds per-scenario storage and emits on transitions; the runner
   * owns server start/stop, JSON timer, and final-write lifecycle so the
   * overview is reachable from the moment the runner starts (planning),
   * not only once the executor is reached. */
  overview?: {
    state: RunOverviewState;
    server: RunOverviewServer | null;
  };
  /** Shared runner-auth context — when set, all direct runner→Hub fetches
   * inside the executor (stack lookup, debug external-events, /api/reload)
   * use the same Bearer token TestResultWriter does. Allows env-var
   * bootstrap from live-test-runner OR mid-run population from Zitadel
   * stack lookup to apply to both writer and executor. (Stage G) */
  runnerAuth?: RunnerAuthContext;
}

/**
 * Evaluate expect2fail + allowed2fail expectations against per-template results.
 *
 * Two distinct semantics:
 *  - `expect2fail`: the template MUST fail with the listed code. Pipeline
 *    success without the failure is a mismatch (test detects when the
 *    expected failure path silently goes away).
 *  - `allowed2fail`: the template MAY fail with the listed code. If it
 *    passes, no foul. If it fails with that code, also no foul. Any other
 *    non-zero is still a real failure.
 *
 * In both cases, OTHER non-zero exits remain real failures.
 *
 * Returns matched=true only when every expect2fail entry matched AND no
 * extraneous non-zero exits occurred.
 *
 * Internal CLI errors with exitCode -1 (output validation, not a real script
 * exit) are excluded — they don't represent template-level failures.
 */
function evaluateExpect2Fail(
  cliResult: CliJsonResult,
  expect2fail: Record<string, number>,
  allowed2fail: Record<string, number> = {},
): { matched: boolean; mismatches: string[] } {
  const mismatches: string[] = [];

  // For each declared expectation, find the corresponding messages.
  for (const [tmpl, expectedCode] of Object.entries(expect2fail)) {
    const msgs = cliResult.messages.filter((m) => m.template === tmpl);
    if (msgs.length === 0) {
      const seenTemplates = [
        ...new Set(cliResult.messages.map((m) => m.template).filter(Boolean)),
      ].sort();
      // Also collect command names for messages without template, to help
      // diagnose whether the template ran but failed to propagate the field.
      const orphanCommands = [
        ...new Set(
          cliResult.messages
            .filter((m) => !m.template && m.command)
            .map((m) => m.command),
        ),
      ].sort();
      const seenSummary = seenTemplates.length > 0
        ? `seen[${seenTemplates.length}]: ${seenTemplates.join(", ")}`
        : "no messages had a 'template' field — runtime did not propagate template filenames";
      const orphanSummary = orphanCommands.length > 0
        ? ` | orphan-cmds[${orphanCommands.length}]: ${orphanCommands.slice(0, 30).join(", ")}`
        : "";
      mismatches.push(
        `${tmpl}: expected to exit ${expectedCode}, but template never ran (${seenSummary}${orphanSummary})`,
      );
      continue;
    }
    // A template may emit multiple messages (one per command, plus a synthetic
    // error wrapper with exitCode=-1 from the catch handler when the script
    // throws). Prefer the real script exit (0..N) over the synthetic -1, and
    // skip partial streaming messages.
    const finals = msgs.filter((m) => !m.partial);
    const realExits = finals.filter((m) => m.exitCode !== -1);
    const lastMsg =
      realExits.length > 0
        ? realExits[realExits.length - 1]
        : finals.length > 0
          ? finals[finals.length - 1]
          : msgs[msgs.length - 1];
    // msgs is non-empty here (filter step kept us in the loop), so lastMsg is
    // defined — the explicit guard exists to satisfy noUncheckedIndexedAccess.
    if (!lastMsg) continue;
    if (lastMsg.exitCode !== expectedCode) {
      mismatches.push(
        `${tmpl}: expected exit ${expectedCode}, got ${lastMsg.exitCode}`,
      );
    }
  }

  // Flag any non-zero exit that's not covered by an expect2fail OR
  // allowed2fail entry. Exclude:
  //  - exitCode 0 / -1 (success / synthetic-error wrapper)
  //  - the "Failed" pipeline-abort message (command="Failed", no template) —
  //    it's the synthetic top-level wrapper VeExecution emits when an inner
  //    template throws; the inner failure is what matters and is matched
  //    separately above
  //  - messages without a template field (typically not real script results;
  //    e.g. "Completed", "Failed" wrappers, hook-trigger streaming chunks)
  for (const msg of cliResult.messages) {
    if (msg.exitCode === undefined || msg.exitCode === 0 || msg.exitCode === -1) {
      continue;
    }
    if (!msg.template) continue;
    if (expect2fail[msg.template] !== undefined) continue;
    if (allowed2fail[msg.template] === msg.exitCode) continue;
    mismatches.push(`unexpected failure: ${msg.template} exited ${msg.exitCode}`);
  }

  return { matched: mismatches.length === 0, mismatches };
}

/** True if any allowed2fail entry was actually triggered (template ran, exited
 * with the listed code). Used to decide whether to rewrite cliResult.exitCode
 * from non-zero to 0 (analogous to expect2fail) and to skip the post-install
 * stability poll. */
function allowed2failTriggered(
  cliResult: CliJsonResult,
  allowed2fail: Record<string, number>,
): boolean {
  for (const [tmpl, code] of Object.entries(allowed2fail)) {
    const msgs = cliResult.messages.filter(
      (m) => m.template === tmpl && !m.partial && m.exitCode !== -1,
    );
    if (msgs.some((m) => m.exitCode === code)) return true;
  }
  return false;
}

/** Find an existing managed container by application_id via the installations API.
 *
 * `expectedHostname` lets the caller disambiguate between sibling containers of
 * the same application (e.g. nginx-default vs nginx-acme vs nginx-oidc-ssl).
 * Without it we fall back to lowest-VMID-first, which after a replace_ct flow
 * may return the wrong sibling — leading to result.vmId pointing at an unrelated
 * container that then gets cleaned up incorrectly while the real target leaks. */
async function findExistingVm(
  _apiUrl: string,
  _veHost: string,
  applicationId: string,
  pveHost: string,
  sshPort: number,
  expectedHostname?: string,
  /**
   * When true, *only* a CT whose hostname matches `expectedHostname` exactly
   * is acceptable — no falling back to the first application-id match. Used
   * by the `--all` driver where the planner has already resolved the right
   * source via depends_on, and a "first match" fallback would pick the wrong
   * sibling (e.g. `nginx-acme` for a `nginx/default`-depending reconfigure).
   */
  strictHostname = false,
): Promise<{ vm_id: number; addons?: string[]; hostname?: string } | null> {
  // Scan PVE host directly for running managed containers.
  // More reliable than deployer context which may be stale after rollbacks.
  try {
    const pctList = nestedSsh(pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1}'`, 10000);
    let firstAppMatch: { vm_id: number; addons?: string[]; hostname?: string } | null = null;
    for (const line of pctList.split("\n")) {
      const vmId = parseInt(line.trim(), 10);
      if (isNaN(vmId)) continue;
      try {
        const conf = nestedSsh(pveHost, sshPort,
          `pct config ${vmId} 2>/dev/null | head -40`, 5000);
        if (!conf.includes("proxvex") || !conf.includes("managed")) continue;
        // Skip containers that replace-ct.sh has retired. They keep the same
        // hostname + application-id as their replacement, but carry a
        // `<!-- proxvex:replaced-by N -->` notes marker plus `lock=migrate`.
        // Picking them as previous_vm_id for the next reconfigure breaks
        // pct snapshot ("CT is locked (migrate)").
        if (/proxvex(%3A|:)replaced-by/.test(conf)) continue;
        const appMatch = conf.match(/application-id\s+(\S+)/);
        const appId = appMatch?.[1]?.replace(/%20/g, " ");
        if (appId !== applicationId) continue;
        const addonMatches = conf.matchAll(/addon\s+(\S+)/g);
        const addons = [...addonMatches].map(m => m[1]!).filter(Boolean);
        const hostMatch = conf.match(/^hostname:\s*(\S+)/m);
        const hostname = hostMatch?.[1];
        // exactOptionalPropertyTypes forbids `addons: undefined` on `addons?: string[]`;
        // spread the field conditionally so it's omitted when absent.
        const result: { vm_id: number; addons?: string[]; hostname?: string } = {
          vm_id: vmId,
          ...(addons.length > 0 ? { addons } : {}),
          ...(hostname ? { hostname } : {}),
        };
        if (expectedHostname) {
          if (hostname === expectedHostname) return result;
          if (!firstAppMatch) firstAppMatch = result;
          continue;
        }
        return result;
      } catch { continue; }
    }
    if (firstAppMatch && !strictHostname) return firstAppMatch;
  } catch { /* ignore */ }
  return null;
}

/** Verify a planner-resolved VMID still corresponds to a usable source container.
 *  Returns null if the CT doesn't exist, was retired by replace-ct, or is
 *  locked. Returns hostname/addons when usable. */
function verifyDependencyVm(
  pveHost: string,
  sshPort: number,
  vmId: number,
  applicationId: string,
): { vm_id: number; addons?: string[]; hostname?: string } | null {
  try {
    const conf = nestedSsh(pveHost, sshPort,
      `pct config ${vmId} 2>/dev/null | head -40`, 5000);
    if (!conf.includes("proxvex") || !conf.includes("managed")) return null;
    if (/proxvex(%3A|:)replaced-by/.test(conf)) return null;
    // Locked CTs (migrate/backup/snapshot) can't serve as a clone source.
    if (/^lock:\s*\S+/m.test(conf)) return null;
    const appMatch = conf.match(/application-id\s+(\S+)/);
    const appId = appMatch?.[1]?.replace(/%20/g, " ");
    if (appId !== applicationId) return null;
    const addonMatches = conf.matchAll(/addon\s+(\S+)/g);
    const addons = [...addonMatches].map(m => m[1]!).filter(Boolean);
    const hostMatch = conf.match(/^hostname:\s*(\S+)/m);
    const result: { vm_id: number; addons?: string[]; hostname?: string } = { vm_id: vmId };
    if (addons.length > 0) result.addons = addons;
    if (hostMatch?.[1]) result.hostname = hostMatch[1];
    return result;
  } catch {
    return null;
  }
}

/**
 * Map an internal OIDC issuer URL (whose hostname is a container's bridge
 * name, only resolvable inside the nested-VM) to the externally-routable
 * NAT entry from `config.portForwarding`. Preserves the URL's scheme,
 * path, and query — only the host[:port] is swapped.
 *
 * Returns the input unchanged when there's no matching portForwarding
 * entry — in that case the caller will most likely fail later on the
 * unreachable hostname, but doing nothing here is preferable to silently
 * fabricating an external URL that might be wrong.
 *
 * Also returns the ORIGINAL `host:port` as `hostOverride` so the caller
 * can pass it through as an HTTP `Host` header. Zitadel validates the
 * Host header against its configured ExternalDomain (the internal one)
 * and rejects requests whose Host doesn't match a registered instance
 * domain — sending the bytes to the external NAT but keeping the Host
 * header as the internal value lets both halves see what they expect.
 */
function rewriteOidcIssuerForExternalAccess(
  issuerUrl: string,
  pveHost: string,
  portForwarding: Array<{ port: number; hostname: string }>,
): { issuerUrl: string; hostOverride?: string } {
  let parsed: URL;
  try {
    parsed = new URL(issuerUrl);
  } catch {
    return { issuerUrl };
  }
  const match = portForwarding.find((f) => f.hostname === parsed.hostname);
  if (!match) return { issuerUrl };
  const originalHost = parsed.host;
  parsed.host = `${pveHost}:${match.port}`;
  return {
    issuerUrl: parsed.toString().replace(/\/$/, ""),
    hostOverride: originalHost,
  };
}

/** Allocate a fresh VMID for a source-isolation clone. Picks a slot well
 *  above the planner's `step.vmId` range so it can't collide with any
 *  scenario the planner has already reserved. Returns null when no slot is
 *  available in the configured search range. */
function allocateCloneVmId(
  pveHost: string,
  sshPort: number,
  startAbove: number,
): number | null {
  // Search 1000–1999 ABOVE the consumer's planner VMID. step.vmId is in the
  // 200+ range, so cloneVmId lands at 1200+ — clearly out of band of the
  // 200-block the planner uses, easy to recognise in `pct list`, and out of
  // the way of test scenarios.
  const baseStart = Math.max(startAbove + 1000, 1200);
  try {
    const taken = nestedSsh(
      pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1}'`,
      10000,
    )
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    const takenSet = new Set(taken);
    for (let id = baseStart; id < baseStart + 800; id++) {
      if (!takenSet.has(id)) return id;
    }
  } catch { /* ignore — return null below */ }
  return null;
}

// `waitForHubViaSpoke` removed in Schritt 3b: it was only needed because
// `qm rollback` restarted the entire nested VM (including the Hub). pct
// rollback is container-local; the Hub is never touched.

/** Return VMIDs (other than `excludeVmId`) whose hostname matches `hostname`.
 *
 * Pre-flight guard against leftover containers from previous runs. If a stale
 * postgres-default at VMID 219 lingers when a fresh run installs at VMID 220,
 * the deployer's dependency-resolver picks the lowest VMID (219) but DNS
 * resolves to the new container (220) — yielding silent password mismatches
 * downstream. Catching the duplicate up-front turns the symptom into a clear
 * fail with a `--fresh` hint. */
function findHostnameCollisions(
  pveHost: string,
  sshPort: number,
  hostname: string,
  excludeVmId: number,
): number[] {
  try {
    // pct list columns: VMID Status [Lock] Name. Name (last token) carries
    // the hostname for proxvex-managed containers.
    const out = nestedSsh(
      pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1, $NF}'`,
      10000,
    );
    const collisions: number[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const vmid = parseInt(parts[0]!, 10);
      if (Number.isNaN(vmid)) continue;
      if (vmid === excludeVmId) continue;
      if (parts[parts.length - 1] === hostname) collisions.push(vmid);
    }
    return collisions;
  } catch {
    return [];
  }
}

export async function executeScenarios(
  planned: PlannedScenario[],
  config: {
    instance?: string;
    pveHost: string;
    vmId: number;
    portPveSsh: number;
    bridge: string;
    deployerUrl: string;
    snapshot?: { enabled: boolean };
    portForwarding?: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
    /** Optional: UI-generated PAT for a Zitadel service user with sufficient
     *  org permissions. When set, gets injected as `ZITADEL_PAT` param into
     *  every params.json so OIDC-addon templates use it instead of the
     *  on-LXC /bootstrap/admin-client.pat fallback. */
    zitadelPat?: string;
  },
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
  allTests: Map<string, ResolvedScenario>,
  stackIdMap: Map<string, string[]>,
  resultWriter?: TestResultWriter,
  fixtureBaseDir?: string,
  options?: ExecuteScenariosOptions,
): Promise<TestResult> {
  // Phase 0: per-application dependency-snapshot name (`<app>_deps`), or
  // `null` for `--all` / multi-app subsets where no dep snapshot is taken.
  const depSnapshotName: string | null = options?.depSnapshotName ?? null;
  // Schritt 3b: `--snapshot <name>` mode (Build mode). Wenn gesetzt, werden
  // alle erfolgreich installierten Provider-Szenarien am Iterations-Ende
  // pct-snapshottet (statt Teardown), und der Cluster-Name ist genau dieser.
  const snapshotMode: string | null = options?.snapshotMode ?? null;
  // Per-member-snapshot path (mode-independent): every successful catalog
  // member produces a sanitized-id pct snapshot on its CT + all transitive
  // dep CTs. Independent of depSnapshotName / snapshotMode. The runMode is
  // accepted for forward-compat / observability but does not gate behaviour
  // here — gating happens before the executor (in live-test-runner.mts).
  void options?.runMode;
  const snapshotCatalog: ReadonlySet<string> = options?.snapshotCatalog ?? new Set<string>();
  // Phase 1: bounded-concurrency driver when concurrency > 1 (`--parallel`).
  // Default 1 → the unchanged sequential driver.
  const concurrency = Math.max(1, options?.concurrency ?? 1);
  const failFast = !!options?.failFast;
  const result: TestResult = {
    name: planned.map((p) => p.scenario.id).join(", "),
    description: planned.map((p) => p.scenario.description).join("; "),
    passed: 0,
    failed: 0,
    steps: [],
    errors: [],
  };

  const verifier = new Verifier(config.pveHost, config.portPveSsh, apiUrl, veHost);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "livetest-"));

  // Enumerate parallel-capable storages once (zfspool ∪ dir, see
  // enumerateParallelStorages). Each scenario picks one for its volumes via
  // the hierarchy below (see `volume_storage` push in runStep):
  //
  //   1. --volume-storage CLI override (step3 mode: pin every CT of one
  //      cluster build to one storage so chain-internal pct clone stays
  //      filesystem-local).
  //   2. Dependency inheritance: if the scenario's deps already live on a
  //      storage (looked up via `vmidToStorage`), inherit that storage so
  //      the consumer's CT lands next to its source → reflink/CoW clones,
  //      FS-local ops.
  //   3. Index round-robin: cluster roots (no deps) spread evenly across the
  //      storages, so parallel rollbacks of independent chains don't all
  //      contend on the same storage's lock.
  //
  // Empty list (legacy single-storage cluster, SSH failure) → callers leave
  // volume_storage unset and the deployer's default takes over.
  const parallelStorages = enumerateParallelStorages(config.pveHost, config.portPveSsh);
  const volumeStorageOverride = options?.volumeStorageOverride;
  if (volumeStorageOverride) {
    logInfo(`--volume-storage=${volumeStorageOverride}: every scenario in this run pinned to this storage`);
  } else if (parallelStorages.length > 0) {
    logInfo(`parallel storages available for distribution: ${parallelStorages.join(", ")}`);
  }

  // Pre-compute storage assignment per scenario (chain-root round-robin +
  // consumer inheritance, see assignStoragePerScenario). Used both for
  // storage pinning AND as the parallel-driver's worker-occupancy gate:
  // each storage = one worker = one volume domain, so at most one
  // scenario per storage runs concurrently → no `pve-storage-<name>`
  // lock contention.
  const storageByIdx = assignStoragePerScenario(planned, parallelStorages, volumeStorageOverride);

  // Source-clone storage gate.
  //
  // Upgrade/reconfigure scenarios with `consumes_source: "isolate"` do
  //   pct snapshot <source>
  //   pct clone   <source> <temp> --snapname … --full 1
  // around the parallel-driver's dispatch boundary. Without `--storage`, the
  // clone lands on the SOURCE CT's storage — which may differ from the
  // scenario's reserved target storage when a consumer was placed on a
  // round-robin storage but its dep wasn't.
  //
  // The worker gate's `busyStorages` only tracks the scenario's *target*
  // storage. Without this map, another worker scheduled on the SOURCE's
  // storage would race the source-clone for the `pve-storage-<X>` lock
  // and time out. Pre-compute the source storage per upgrade/reconfigure
  // scenario so the dispatch loop can reserve both storages together.
  //
  // Heuristic: source is the depends_on entry that shares the scenario's
  // application (the only kind of dep `findExistingVmForReconfigure` will
  // pick at runtime). When that storage matches the target, no extra
  // reservation is needed.
  const sourceStorageByIdx = new Map<number, string>();
  const idxById = new Map<string, number>();
  planned.forEach((p, i) => idxById.set(p.scenario.id, i));
  for (let i = 0; i < planned.length; i++) {
    const sc = planned[i]!.scenario;
    if (sc.task !== "upgrade" && sc.task !== "reconfigure") continue;
    const meta = appMetaMap.get(sc.application) ?? {};
    const isDC = (meta.framework ?? meta.extends) === "docker-compose";
    const defaultStrategy: "isolate" | "in-place" | "shared" =
      isDC && sc.task === "upgrade" ? "in-place" : "isolate";
    const consumesSource = sc.consumes_source ?? defaultStrategy;
    if (consumesSource !== "isolate") continue;
    for (const depId of sc.depends_on ?? []) {
      const depIdx = idxById.get(depId);
      if (depIdx === undefined) continue;
      if (planned[depIdx]!.scenario.application !== sc.application) continue;
      const depStorage = storageByIdx.get(depIdx);
      const myStorage = storageByIdx.get(i);
      if (depStorage && depStorage !== myStorage) {
        sourceStorageByIdx.set(i, depStorage);
      }
      break;
    }
  }
  if (sourceStorageByIdx.size > 0) {
    const lines = [...sourceStorageByIdx.entries()]
      .map(([i, s]) => `  ${planned[i]!.scenario.id} → also reserves source storage ${s}`)
      .join("\n");
    logInfo(`Cross-storage source-clones detected (${sourceStorageByIdx.size}):\n${lines}`);
  }

  // Live overview: when the runner pre-built the state+server (the common
  // path), reuse it so the HTML viewer is already up before this executor
  // is reached. Falls back to constructing locally for unit-test / direct
  // callers that don't pass `overview` through options — in that fallback
  // the executor also owns the server lifecycle (start + JSON timer + stop).
  const overviewState: RunOverviewState | undefined =
    options?.overview?.state ?? (resultWriter ? {
      outDir: resultWriter.getOutputDir(),
      runId: resultWriter.getRunId(),
      startedAt: new Date(),
      commandLine: resultWriter.getCommandLine(),
      planned,
      status: new Map<string, ScenarioStatus>(),
      startedAtMap: new Map<string, Date>(),
      finishedAtMap: new Map<string, Date>(),
      storage: new Map<string, string>(),
      errorMessages: new Map<string, string>(),
      // Der Runner setzt phase an seinen Uebergaengen. Baut der Executor den
      // Zustand selbst (Unit-Test/Direktaufruf), ist genau das hier der Stand.
      phase: "running scenarios",
    } : undefined);
  const ownsOverviewLifecycle = !options?.overview && !!overviewState;
  let overviewServer: RunOverviewServer | null = options?.overview?.server ?? null;
  let overviewJsonTimer: NodeJS.Timeout | null = null;
  if (overviewState) {
    // Seed storage assignments. The assignment depends on `parallelStorages`
    // (SSH-probed above), so it has to happen here rather than in the runner.
    planned.forEach((p, i) => {
      const s = storageByIdx.get(i);
      if (s) overviewState.storage.set(p.scenario.id, s);
    });
    if (ownsOverviewLifecycle) {
      overviewServer = await startRunOverviewServer(
        overviewState,
        overviewPortForDeployer(config.deployerUrl),
      );
      writeRunOverviewHtml(overviewState, overviewServer?.sseUrl ?? null);
      writeRunOverviewJson(overviewState);
      overviewJsonTimer = setInterval(() => {
        if (overviewState) writeRunOverviewJson(overviewState);
      }, 60_000);
      overviewJsonTimer.unref();
    } else {
      // Externally-owned server: emit a snapshot now so the freshly seeded
      // storage column reaches connected clients immediately.
      overviewServer?.emit(overviewState);
    }
  }
  const markStatus = (idx: number, status: ScenarioStatus, err?: string): void => {
    if (!overviewState) return;
    const sid = planned[idx]?.scenario.id;
    if (!sid) return;
    overviewState.status.set(sid, status);
    if (status === "running" && !overviewState.startedAtMap.has(sid)) {
      overviewState.startedAtMap.set(sid, new Date());
    }
    if (status === "passed" || status === "failed") {
      overviewState.finishedAtMap.set(sid, new Date());
    }
    if (err) overviewState.errorMessages.set(sid, err);
    overviewServer?.emit(overviewState);
  };
  if (concurrency > 1 && parallelStorages.length > 0 && !volumeStorageOverride) {
    const effective = Math.min(concurrency, parallelStorages.length);
    if (effective < concurrency) {
      logInfo(`Effective parallelism: ${effective} (capped by parallel storages=${parallelStorages.length})`);
    }
  }

  // Cache `VMID → storage`. Pre-populated from existing CTs (snapshot-restore
  // case: dep CTs already exist when this run starts), and live-updated as
  // each scenario picks a storage for its own CT. Consumed by the dep-
  // inheritance step in the storage-pick hierarchy.
  const vmidToStorage = new Map<number, string>();
  try {
    const out = await nestedSshStrictAsync(
      config.pveHost, config.portPveSsh,
      // `pct config <v> | grep rootfs: | awk` extracts the storage name from
      // the `rootfs: storage:subvol-…` line. Single multi-line SSH avoids
      // N×SSH-handshake overhead for clusters with many existing CTs.
      "for v in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do " +
      "s=$(pct config \"$v\" 2>/dev/null | awk '/^rootfs:/{split($2,a,\":\"); print a[1]; exit}'); " +
      "[ -n \"$s\" ] && echo \"$v $s\"; " +
      "done",
      30000,
    );
    for (const line of out.split("\n")) {
      const [vmidStr, storage] = line.trim().split(/\s+/);
      if (vmidStr && storage) {
        const vmid = Number.parseInt(vmidStr, 10);
        if (Number.isFinite(vmid)) vmidToStorage.set(vmid, storage);
      }
    }
    if (vmidToStorage.size > 0) {
      logInfo(`Seeded VMID→storage cache with ${vmidToStorage.size} existing CT(s) for dep inheritance`);
    }
  } catch {
    // Best-effort: an empty cache just means everyone falls back to round-robin.
  }

  // Phase: pre-test proxvex rebuild.
  //
  // The proxvex application is a special case among test targets — the
  // image under test is OUR OWN code. The standard pull path
  // (host-get-oci-image.py → ghcr.io/proxvex/proxvex) returns the upstream
  // published version, which by definition lags the local dev tree. For
  // scenarios that exercise unreleased backend behaviour (e.g.
  // proxvex/playwright-oidc relies on the spoke-sync overlay symlink + the
  // dev-session endpoint), running the test against the upstream image
  // produces a confusing 403 / "endpoint not found" instead of the bug
  // we're actually changing.
  //
  // Solution: when any planned target scenario installs the proxvex
  // application, rebuild + stage the local OCI tarball into the nested-VM
  // template cache as `proxvex_latest.tar` and `proxvex_<version>.tar`.
  // host-get-oci-image.py finds those before reaching for the registry.
  //
  // No currency check (per design) — always rebuild when triggered. Set
  // LIVETEST_SKIP_PROXVEX_REBUILD=1 to skip (for iteration loops that
  // intentionally test against whatever's already in cache).
  const hasProxvexTarget = planned.some(
    (p) => p.scenario.application === "proxvex" && !p.skipExecution && !p.isDependency,
  );
  if (hasProxvexTarget && process.env.LIVETEST_SKIP_PROXVEX_REBUILD !== "1") {
    const instanceName = config.instance;
    if (!instanceName) {
      logWarn("Cannot rebuild proxvex: config.instance is undefined — skipping pre-test build");
    } else {
      const helper = path.join(projectRoot, "e2e/build-proxvex-oci-image.sh");
      if (!existsSync(helper)) {
        throw new Error(`build-proxvex-oci-image.sh missing at ${helper} — cannot stage fresh proxvex image for test`);
      }
      logStep("Pre-test", `Building + staging proxvex OCI image for instance=${instanceName}`);
      try {
        execSync(`"${helper}" "${instanceName}"`, {
          cwd: projectRoot,
          stdio: "inherit",
        });
      } catch (err) {
        throw new Error(
          `proxvex rebuild failed: ${err instanceof Error ? err.message : String(err)} — ` +
            `set LIVETEST_SKIP_PROXVEX_REBUILD=1 to bypass and run against the stale cached image`,
        );
      }
    }
  } else if (hasProxvexTarget) {
    logInfo("LIVETEST_SKIP_PROXVEX_REBUILD=1 — using whatever proxvex image is already cached");
  }

  // Fetch deployer version for test results
  let deployerVersion = "unknown";
  let deployerGitHash = "unknown";
  try {
    const vResp = await fetch(`${apiUrl}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (vResp.ok) {
      const v = await vResp.json() as { version?: string; gitHash?: string };
      deployerVersion = v.version ?? "unknown";
      deployerGitHash = v.gitHash ?? "unknown";
    }
  } catch { /* ignore */ }

  // Build hash for snapshot invalidation
  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore */ }

  // Snapshot manager for the per-application `<app>_deps` snapshot.
  // Provider/consumer distinction comes from `step.isDependency` set by the
  // planner (planned[].isDependency = true if not in selectedIdSet).
  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  const snapMgr = config.snapshot?.enabled
    ? new SnapshotManager(config.pveHost, config.portPveSsh, (msg) => logInfo(msg), localContextPath)
    : null;

  // OIDC credentials for delegated access (loaded after Zitadel installation)
  // Only used if the deployer itself has OIDC enabled (not for app-level OIDC addons)
  let oidcCredentials: { issuerUrl: string; clientId: string; clientSecret: string; hostOverride?: string; projectId?: string } | undefined;

  // Runner-side machine-token auth context (Stage G). Either passed in from
  // live-test-runner (= shared ref with TestResultWriter — env-var bootstrap
  // applies) or freshly allocated if no caller supplied one. Population
  // happens lazily in loadOidcCredsFromStack below.
  const runnerAuth: RunnerAuthContext = options?.runnerAuth ?? {};

  /**
   * Pull the test-deployer credentials from the oidc_<stackName> stack the
   * way addon-oidc-consuming applications do: Zitadel install emits
   * `DEPLOYER_OIDC_MACHINE_CLIENT_ID/SECRET` and `DEPLOYER_OIDC_ISSUER_URL`
   * as stack provides, so any consumer (including the livetest runner that
   * needs to call the Zitadel token endpoint from the remote Playwright
   * spec) reads them from there — never from the LXC bootstrap files.
   */
  async function loadOidcCredsFromStack(stackName: string): Promise<typeof oidcCredentials> {
    try {
      // Use authedFetch — once we DO have runnerAuth.oidcCreds (subsequent
      // call for a second OIDC test in the same run), the stack route
      // may have moved behind OIDC. First call typically lands here
      // pre-token; runnerHttpJson just omits the header in that case.
      const resp = await runnerHttpJson<{ stack?: { provides?: Array<{ name: string; value: string }> } }>(
        runnerAuth,
        `${apiUrl}/api/stack/oidc_${stackName}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!resp.ok || !resp.body) return undefined;
      const provides = resp.body.stack?.provides ?? [];
      const get = (name: string): string | undefined => provides.find((p) => p.name === name)?.value;
      // Prefer TEST_DEPLOYER_OIDC_* — emitted by template 357 (livetest-local
      // overlay), this user gets ALL project roles granted (template 358 +
      // Phase D refresh-grant hook). Falls back to DEPLOYER_OIDC_* (deployer-cli
      // machine user from template 340) when test-deployer wasn't created —
      // that user has ORG_OWNER but no per-project role, so apps with
      // OIDC_REQUIRED_ROLE will reject its access token (HTTP 403 from
      // /api/auth/dev-session).
      const issuerUrl =
        get("TEST_DEPLOYER_OIDC_ISSUER_URL")
        ?? get("DEPLOYER_OIDC_ISSUER_URL");
      const clientId =
        get("TEST_DEPLOYER_OIDC_MACHINE_CLIENT_ID")
        ?? get("DEPLOYER_OIDC_MACHINE_CLIENT_ID");
      const clientSecret =
        get("TEST_DEPLOYER_OIDC_MACHINE_CLIENT_SECRET")
        ?? get("DEPLOYER_OIDC_MACHINE_CLIENT_SECRET");
      const projectId = get("DEPLOYER_OIDC_PROJECT_ID");
      if (issuerUrl && clientId && clientSecret) {
        // Rewrite the issuer URL to the externally-routable NAT entry,
        // and capture the original internal host:port as `hostOverride`
        // so the CLI / runner can keep Zitadel happy by sending the
        // expected `Host` header even though the bytes route via the
        // external NAT. Zitadel's instance-domain validation otherwise
        // rejects requests with `Host: ubuntupve:1808` as "Instance not
        // found" when its `ExternalDomain` was set to the internal
        // `zitadel-default:8080`. Production deployments where the
        // public domain matches Zitadel's `ExternalDomain` produce no
        // rewrite (hostOverride stays undefined) — passthrough.
        const rewritten = rewriteOidcIssuerForExternalAccess(
          issuerUrl, config.pveHost, config.portForwarding ?? [],
        );
        const creds = {
          issuerUrl: rewritten.issuerUrl,
          clientId, clientSecret,
          ...(rewritten.hostOverride ? { hostOverride: rewritten.hostOverride } : {}),
          ...(projectId ? { projectId } : {}),
        };
        // G.2: populate runnerAuth so subsequent direct fetches from the
        // runner attach Authorization: Bearer (driven by runnerHttpJson).
        // Same creds power the CLI subprocess via the existing
        // oidcCredentials path below.
        runnerAuth.oidcCreds = creds;
        delete runnerAuth.token;
        delete runnerAuth.tokenExp;
        return creds;
      }
    } catch { /* stack not ready yet */ }
    return undefined;
  }
  // Probe whether the deployer requires OIDC auth right now. Wrapped as a
  // function so the per-scenario useOidc decision below can re-evaluate it
  // — a single cached value taken at run start goes stale across self-
  // reconfigure-enable/disable scenarios that flip the Hub's OIDC state
  // mid-run, leaving the CLI subprocess without Bearer creds against the
  // newly-OIDC-protected Hub.
  const probeDeployerOidcEnabled = async (): Promise<boolean> => {
    try {
      // Note: the field is `oidcEnabled` (not `enabled`) — the older code
      // looked for `enabled` and silently saw `false` even on OIDC-active
      // Hubs, which broke per-scenario useOidc decisions for downstream
      // tests in the OIDC suite that don't carry selectedAddons of their
      // own (e.g. upgrade-with-oidc after enable-https-oidc).
      const authResp = await fetch(`${apiUrl}/api/auth/config`, { signal: AbortSignal.timeout(3000) });
      if (authResp.ok) {
        const authConfig = await authResp.json() as { oidcEnabled?: boolean; enabled?: boolean };
        return !!(authConfig.oidcEnabled ?? authConfig.enabled);
      }
    } catch { /* deployer unreachable or no OIDC */ }
    return false;
  };
  let deployerOidcEnabled = await probeDeployerOidcEnabled();

  // Outcome of one scenario step, driving the sequential / parallel driver.
  type StepOutcome =
    | { type: "done" }
    | { type: "failed-partition"; scenarioId: string }
    | { type: "crashed"; err: unknown };

  // Per-scenario unit of work. Byte-identical to the original loop body
  // except control flow: `continue` → `return {type:"done"}`, the inline
  // partition block → `return {type:"failed-partition"}`, and the crash
  // fail-fast decision is deferred to the driver via `{type:"crashed"}`.
  // The self-contained try/catch/finally (crash safety + source-clone
  // cleanup) is preserved exactly.
  // Best-effort POST of buffered runner events into the per-restartKey
  // debug bundle. Drains the context buffer on each call. Silent on
  // network errors — these events are diagnostic-only.
  const flushRunnerEvents = async (ctx: ScenarioLogContext): Promise<void> => {
    if (!ctx.restartKey || ctx.buffer.length === 0) return;
    const events = ctx.buffer.splice(0);
    try {
      await runnerHttpJson(runnerAuth, `${apiUrl}/api/ve/debug/${ctx.restartKey}/external-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best-effort */ }
  };

  const runStep = async (i: number): Promise<StepOutcome> => {
    const step0 = planned[i]!;
    const ctx: ScenarioLogContext = { scenarioId: step0.scenario.id, buffer: [] };
    return scenarioLogContext.run(ctx, async (): Promise<StepOutcome> => {
      const step = planned[i]!;
      const scenario = step.scenario;
      const task = scenario.task || "installation";

      logStep(
        `${i + 1}/${planned.length}`,
        `${scenario.id} (${task}) [VM ${step.vmId}]`,
      );

      const stepStartTime = new Date();

      // VMIDs of source clones created for Phase-2 isolation. Always cleaned
      // up at iteration end (pass, fail, OR crash) so they don't leak across
      // the --all run. Populated below when consumes_source === "isolate".
      const sourceCloneVmIds: number[] = [];

      // Per-iteration crash safety: an uncaught exception inside the loop
      // body would kill the runner mid-plan, leaving the result dir nearly
      // empty (we've seen this with --all: scenario 1 throws → 42 remaining
      // scenarios never run, no result.md anywhere). Catching here turns the
      // throw into a "crashed" test result and lets the rest of the plan
      // proceed; downstream scenarios that depend on this one will be
      // filtered out by the existing partitionAfterFailure logic.
      try {

      // Skip dependencies that were restored from snapshot or are already running
      if (step.skipExecution) {
        logOk(`Skipping ${scenario.id} (${step.isDependency ? "restored from snapshot" : "already running"})`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        // Even when the zitadel install is skipped (running container reused
        // from a prior run or restored from snapshot), downstream Playwright
        // specs still need DEPLOYER_OIDC_* env vars. The bootstrap file lives
        // in the LXC volume so it survives skipped installs — read it now.
        if (scenario.application === "zitadel" && !oidcCredentials) {
          oidcCredentials = await loadOidcCredsFromStack(step.stackName);
          if (oidcCredentials) {
            logOk(`Test OIDC deployer credentials loaded from oidc_${step.stackName} stack (skipped Zitadel)`);
          }
        }
        return { type: "done" };
      }

      // Build params.
      // Note: `bridge` is the *container* bridge inside the nested VM, which is
      // always "vmbr1" (created by step1). config.bridge is the host-PVE-side
      // bridge of the outer VM (vmbr1/2/3 depending on instance) and is NOT
      // the same thing.
      //
      // Hidden apps (e.g. proxmox host reconfigure) target the PVE host itself
      // — the runner-derived `${app}-${variant}` is meaningless there. Use the
      // real PVE host's short name so backend cert-signing produces a cert
      // matching the actual web UI hostname. `/api/applications` filters hidden
      // apps out, so missing from appMetaMap == hidden.
      const isHiddenApp = !appMetaMap.has(scenario.application);
      let effectiveHostname = step.hostname;
      if (isHiddenApp) {
        try {
          effectiveHostname = (await nestedSshAsync(
            config.pveHost, config.portPveSsh,
            "uname -n | cut -d. -f1",
            5000,
          )).trim() || step.hostname;
        } catch { /* fall back to step.hostname */ }
      }
      const isReplaceCt = REPLACE_CT_TASKS.includes(task);

      // Pre-flight: refuse to install on top of a leftover container that
      // already owns the target hostname. replace_ct (upgrade/reconfigure)
      // legitimately reuses the source's hostname, and hidden apps don't
      // create an LXC at all, so both are excluded.
      if (!isReplaceCt && !isHiddenApp) {
        const collisions = findHostnameCollisions(
          config.pveHost, config.portPveSsh, effectiveHostname, step.vmId,
        );
        if (collisions.length > 0) {
          const errMsg =
            `Hostname '${effectiveHostname}' already in use by VMID(s) ${collisions.join(", ")}. ` +
            `Leftover from a previous run — re-run the livetest with --fresh to wipe.`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          result.steps.push({
            vmId: step.vmId, hostname: effectiveHostname,
            application: scenario.application, scenarioId: scenario.id,
          });
          return { type: "done" };
        }
      }

      const baseParams = [
        { name: "hostname", value: effectiveHostname },
        { name: "bridge", value: "vmbr1" },
        ...(!isReplaceCt ? [{ name: "vm_id", value: String(step.vmId) }] : []),
        ...(isReplaceCt ? [{ name: "vm_id_start", value: String(step.vmId) }] : []),
        // Enable per-task debug bundle on the backend when --debug was
        // passed. Routed via the per-key event pipeline (`ICommand.restartKey`
        // threaded through MessageEmitter), so concurrent tasks each own
        // their bundle — both targets AND dependencies now get full
        // bundles, which makes `--all` failure analysis feasible. The
        // legacy `!step.isDependency` suppression was the workaround for
        // the deleted `Logger.setDebugSink` singleton and is gone.
        ...(options?.debugLevel && options.debugLevel !== "off"
          ? [{ name: "debug_level", value: options.debugLevel }]
          : []),
      ];

      const templateVars: Record<string, string> = {
        vm_id: String(step.vmId),
        hostname: step.hostname,
        stack_name: step.stackName,
      };

      // Add dependency VM IDs as template variables
      if (scenario.depends_on) {
        for (const depId of scenario.depends_on) {
          const depStep = planned.find((p) => p.scenario.id === depId);
          if (depStep) {
            const depApp = depStep.scenario.application.replace(/-/g, "_");
            templateVars[`dep_${depApp}_vm_id`] = String(depStep.vmId);
          }
        }
      }

      const buildResult = buildParams(scenario, baseParams, templateVars, tmpDir);

      // For upgrade/reconfigure: find existing VM. Resolution order:
      //   1. explicit previous_vm_id from scenario params (e.g. proxmox/oidc-ssl
      //      sets "0" because the PVE host itself is the reconfigure target).
      //   2. same-application entry in depends_on — but VERIFIED on the host
      //      (CT exists, not retired/locked, app-id matches). The planner's
      //      vmId can be stale when an earlier scenario in the run already
      //      consumed the source (lock=migrate after replace-ct).
      //   3. hostname-strict findExistingVm — only accept a CT whose hostname
      //      exactly matches one of the depends_on apps' planner-hostnames.
      //      No silent "first nginx-* CT" fallback: that picked nginx-acme
      //      instead of nginx-default for reconf-addons-off, leaking ACME
      //      errors into the post-rename log.
      let existingVm: { vm_id: number; addons?: string[]; hostname?: string } | null = null;
      if (isReplaceCt) {
        // target_deployer_instance: scenario targets whatever CT carries
        // the proxvex:deployer-instance marker on the PVE host. Used by
        // the self-upgrade test — vmid varies (production: any; nested
        // green: CT 300). Resolved once via `pct list` and a marker
        // probe; existingVm.vm_id becomes the deployer's vmid and the
        // standard hostname-based search is skipped.
        if (scenario.target_deployer_instance) {
          try {
            const deployerVmidRaw = (await nestedSshAsync(
              config.pveHost, config.portPveSsh,
              "pct list | awk 'NR>1 {print $1}' | while read v; do " +
                "pct config \"$v\" 2>/dev/null | grep -qa deployer-instance && echo \"$v\" && break; " +
              "done",
              15000,
            )).trim();
            if (!deployerVmidRaw || !/^\d+$/.test(deployerVmidRaw)) {
              const errMsg = `target_deployer_instance: no CT with proxvex:deployer-instance marker found on ${config.pveHost} (raw=${JSON.stringify(deployerVmidRaw)})`;
              logFail(errMsg);
              result.errors.push(errMsg);
              result.failed++;
              return { type: "failed-partition", scenarioId: scenario.id };
            }
            existingVm = { vm_id: Number(deployerVmidRaw) };
            logInfo(`target_deployer_instance: using CT ${existingVm.vm_id} (proxvex:deployer-instance marker) for ${task}`);
          } catch (err: any) {
            const errMsg = `target_deployer_instance: SSH probe failed: ${err?.message ?? String(err)}`;
            logFail(errMsg);
            result.errors.push(errMsg);
            result.failed++;
            return { type: "failed-partition", scenarioId: scenario.id };
          }
        }
        const explicitPrev = buildResult.params.find((p) => p.name === "previous_vm_id");
        if (!existingVm && explicitPrev) {
          existingVm = { vm_id: Number(explicitPrev.value) };
          logInfo(`Using explicit previous_vm_id=${explicitPrev.value} from scenario for ${task}`);
        }
        if (!existingVm && scenario.depends_on) {
          for (const depId of scenario.depends_on) {
            const depStep = planned.find((p) => p.scenario.id === depId);
            if (!depStep || depStep.scenario.application !== scenario.application) continue;
            const verified = verifyDependencyVm(
              config.pveHost, config.portPveSsh, depStep.vmId, scenario.application,
            );
            if (verified) {
              existingVm = verified;
              logInfo(`Using depended-on VM ${verified.vm_id} (hostname=${verified.hostname ?? "?"}) for ${task} (from ${depId})`);
              break;
            }
            logWarn(
              `Planner mapped ${depId} → VM ${depStep.vmId} but that CT is missing/retired/locked — falling back to hostname-strict scan`,
            );
          }
        }
        if (!existingVm) {
          // Strict hostname match: no "first app-id match" fallback.
          // Try each same-application depends_on hostname.
          const candidateHostnames: string[] = [step.hostname];
          if (scenario.depends_on) {
            for (const depId of scenario.depends_on) {
              const depStep = planned.find((p) => p.scenario.id === depId);
              if (depStep && depStep.scenario.application === scenario.application) {
                if (!candidateHostnames.includes(depStep.hostname)) {
                  candidateHostnames.push(depStep.hostname);
                }
              }
            }
          }
          for (const host of candidateHostnames) {
            existingVm = await findExistingVm(
              apiUrl, veHost, scenario.application,
              config.pveHost, config.portPveSsh, host, true /* strictHostname */,
            );
            if (existingVm) {
              logInfo(`Found CT ${existingVm.vm_id} by hostname '${host}' for ${task}`);
              break;
            }
          }
        }
        if (!existingVm) {
          const errMsg = `No existing VM found for ${scenario.application} — cannot ${task}`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          // Treat as a real partition failure (not `done`) so the parallel
          // driver marks the overview as "failed" and cascades the skip
          // to anything downstream. The previous `return { type: "done" }`
          // caused the overview to mismark the scenario as passed, leaving
          // the CLI summary and the JSON snapshot inconsistent.
          return { type: "failed-partition", scenarioId: scenario.id };
        }
        // From here on existingVm is guaranteed non-null. Bind into a typed
        // local so TS keeps the narrowing across the reassignment below
        // (cloning swaps `existingVm` to point at the clone).
        let sourceVm: { vm_id: number; addons?: string[]; hostname?: string } = existingVm;
        // Phase 2: source isolation. If the scenario destructively consumes
        // its source (reconfigure, oci-image upgrade), clone the source into
        // a private throw-away CT and feed the clone into the scenario as
        // previous_vm_id. Original source stays available for other
        // consumers. docker-compose upgrade opts out (in-place modification
        // — see `consumes_source` doc). The clone is registered for cleanup
        // at iteration end regardless of pass/fail.
        const appMetaForVmId = appMetaMap.get(scenario.application) ?? {};
        const isDockerComposeForVmId =
          (appMetaForVmId.framework ?? appMetaForVmId.extends) === "docker-compose";
        const defaultStrategy: "isolate" | "in-place" | "shared" =
          isDockerComposeForVmId && task === "upgrade" ? "in-place" : "isolate";
        const consumesSource = scenario.consumes_source ?? defaultStrategy;
        // Explicit previous_vm_id (the proxmox/oidc-ssl hack with value "0")
        // means there is no source CT to isolate — leave as-is.
        const hasExplicitPrev = !!buildResult.params.find((p) => p.name === "previous_vm_id");
        if (consumesSource === "isolate" && !hasExplicitPrev) {
          const cloneVmId = allocateCloneVmId(config.pveHost, config.portPveSsh, step.vmId);
          if (cloneVmId !== null) {
            logInfo(`Isolating source: cloning VM ${sourceVm.vm_id} → ${cloneVmId} for ${scenario.id}`);
            // `pct clone --full` on a RUNNING source requires `--snapname`
            // (Proxmox: "Full clone of a running container is only possible
            // from a snapshot"). Take an ephemeral snapshot, clone from it,
            // and delete the snapshot afterwards. The source CT stays
            // running throughout — its kernel mounts keep working until next
            // stop, so no data is lost.
            const snapName = `iso-clone-${cloneVmId}`;
            let snapTaken = false;
            try {
              await nestedSshAsync(
                config.pveHost, config.portPveSsh,
                `pct snapshot ${sourceVm.vm_id} ${snapName}`,
                120000,
              );
              snapTaken = true;
              await nestedSshAsync(
                config.pveHost, config.portPveSsh,
                `pct clone ${sourceVm.vm_id} ${cloneVmId} --snapname ${snapName} --full 1`,
                300000,
              );
              // `pct clone` does NOT carry over the source's notes by default.
              // In Proxmox LXC, notes live as `#`-prefixed comment lines at
              // the very top of `/etc/pve/lxc/<vmid>.conf` (NOT as a
              // `description:` line). Downstream proxvex templates check the
              // notes for `proxvex:managed` / `application-id` markers and
              // refuse to operate on CTs missing them.
              //
              // Implementation: prepend the source's leading `#` block to the
              // target's conf. Encoded as a single-line shell command because
              // nestedSsh passes the command through JSON.stringify, which
              // turns embedded newlines into literal `\n` escapes that the
              // remote shell does NOT re-interpret as command separators.
              const SRC_CONF = `/etc/pve/lxc/${sourceVm.vm_id}.conf`;
              const DST_CONF = `/etc/pve/lxc/${cloneVmId}.conf`;
              // Pipe the script via stdin (`sh -s`) so we don't fight nested
              // shell quoting: the runner→ssh→remote-sh chain otherwise
              // expands $(mktemp) on the LOCAL machine before reaching the
              // remote, which clobbers the cloned CT's conf and yields
              // `missing 'arch' - internal error` on `pct start`.
              const copyNotesScript =
                `set -e\n` +
                `T=$(mktemp)\n` +
                `awk 'BEGIN{skip=1} skip && /^[^#]/ {skip=0} !skip {print}' '${DST_CONF}' > "$T"\n` +
                `{ awk '/^[^#]/ {exit} {print}' '${SRC_CONF}'; cat "$T"; } > '${DST_CONF}'\n` +
                `rm -f "$T"\n`;
              try {
                await nestedSshStrictAsync(
                  config.pveHost, config.portPveSsh,
                  "sh -s",
                  30000,
                  copyNotesScript,
                );
              } catch (descErr) {
                logWarn(`Could not copy notes from ${sourceVm.vm_id} to ${cloneVmId}: ${descErr instanceof Error ? descErr.message : String(descErr)}`);
              }
              // Delete the source-side snapshot — we don't need it again.
              try {
                await nestedSshAsync(
                  config.pveHost, config.portPveSsh,
                  `pct delsnapshot ${sourceVm.vm_id} ${snapName}`,
                  60000,
                );
                snapTaken = false;
              } catch {
                // Non-fatal: the leftover snapshot is cleanup-able later but
                // a) it occupies disk, b) repeated isolations stack up. Log
                // for visibility.
                logWarn(`Could not delete source snapshot ${snapName} on VM ${sourceVm.vm_id}`);
              }
              // Start the clone so downstream `pct exec` works (the clone is
              // stopped by default).
              let cloneAttachable = false;
              try {
                await nestedSshAsync(
                  config.pveHost, config.portPveSsh,
                  `pct start ${cloneVmId} 2>&1 || true`,
                  60000,
                );
                // Poll until lxc-attach succeeds (init PID is reachable).
                // nestedSsh swallows errors; use nestedSshStrict here so the
                // poll loop sees failures and retries.
                //
                // 120s, not 30s: under --all four workers clone and boot
                // containers on one ZFS pool at once, and a merely slow clone
                // used to fall out of this loop silently — the scenario then
                // ran against a stopped container and its first
                // execute_on:lxc template died with "lxc-attach: Connection
                // refused - Failed to get init pid", leaving the clone behind
                // to block its VMID for every later run.
                const deadline = Date.now() + 120000;
                while (Date.now() < deadline) {
                  try {
                    await nestedSshStrictAsync(
                      config.pveHost, config.portPveSsh,
                      `pct exec ${cloneVmId} -- /bin/true 2>/dev/null`,
                      5000,
                    );
                    cloneAttachable = true;
                    break;
                  } catch {
                    await new Promise((r) => setTimeout(r, 1000));
                  }
                }
              } catch (startErr) {
                logWarn(`pct start on clone ${cloneVmId} failed: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
              }
              sourceCloneVmIds.push(cloneVmId);
              const cloned: { vm_id: number; addons?: string[]; hostname?: string } = { vm_id: cloneVmId };
              if (sourceVm.addons) cloned.addons = sourceVm.addons;
              if (sourceVm.hostname) cloned.hostname = sourceVm.hostname;
              sourceVm = cloned;
              if (cloneAttachable) {
                logOk(`Source clone ready: VM ${cloneVmId} (will be destroyed after scenario)`);
              } else {
                logWarn(
                  `Source clone ${cloneVmId} is not attachable after 120s — the scenario continues, `
                  + `but any execute_on:lxc template will fail against it`,
                );
              }
            } catch (err) {
              logWarn(`pct clone failed (${err instanceof Error ? err.message : String(err)}) — falling back to shared source`);
              // Best-effort cleanup of a snapshot we may have created.
              if (snapTaken) {
                try {
                  await nestedSshAsync(
                    config.pveHost, config.portPveSsh,
                    `pct delsnapshot ${sourceVm.vm_id} ${snapName} 2>/dev/null || true`,
                    60000,
                  );
                } catch { /* ignore */ }
              }
            }
          } else {
            logWarn(`Could not allocate a clone VMID — falling back to shared source for ${scenario.id}`);
          }
        } else if (consumesSource === "shared") {
          logInfo(`consumes_source=shared: ${scenario.id} runs against original source ${sourceVm.vm_id}`);
        }

        // Keep existingVm in sync so downstream code (addon resolution, etc.)
        // also sees the (possibly cloned) source.
        existingVm = sourceVm;

        if (!buildResult.params.some((p) => p.name === "previous_vm_id")) {
          buildResult.params.push({ name: "previous_vm_id", value: String(sourceVm.vm_id) });
        }
        logInfo(`Found existing VM ${sourceVm.vm_id} for ${task} (previous_vm_id, strategy=${consumesSource})`);

        // For in-place upgrade (docker-compose), also push vm_id =
        // sourceVm.vm_id so the auto-appended check templates
        // (900-host-check-container etc.) can resolve `{{ vm_id }}`.
        // Without this, post-upgrade verification runs with VM='' and
        // fails. Skip for clone-replace flows (oci-image upgrade, all
        // reconfigures): there `vm_id` is the *new* clone's id which the
        // create_ct/replace-ct chain allocates — pushing it here makes
        // source=target → "must differ" abort.
        if (isDockerComposeForVmId && task === "upgrade") {
          if (!buildResult.params.some((p) => p.name === "vm_id")) {
            buildResult.params.push({ name: "vm_id", value: String(sourceVm.vm_id) });
            logInfo(`In-place docker-compose upgrade: vm_id=${sourceVm.vm_id}`);
          }
        }
      }

      // Pick storage hierarchically and set BOTH `rootfs_storage` and
      // `volume_storage` to the same pool. Without `rootfs_storage` the
      // container itself always lands on `local-zfs` (default in
      // conf-create-lxc-container.sh) — the parallelization would only spread
      // data-volumes, while `pct create`/`pct restore` would still serialize on
      // `rpool/data`. Same pool for both keeps the whole CT on one storage.
      //
      // Hierarchy: operator override > CLI override > inherit-from-dep >
      // index round-robin. Explicit operator overrides (either param set
      // earlier in buildParams) bypass everything.
      const hasOperatorOverride =
        buildResult.params.some((p) => p.name === "volume_storage") ||
        buildResult.params.some((p) => p.name === "rootfs_storage");
      if (!hasOperatorOverride) {
        // Use the pre-computed assignment from assignStoragePerScenario.
        // The driver enforces worker-occupancy via busyStorages so two
        // scenarios sharing a storage never run concurrently.
        const picked = storageByIdx.get(i);
        if (picked) {
          buildResult.params.push({ name: "rootfs_storage", value: picked });
          buildResult.params.push({ name: "volume_storage", value: picked });
          vmidToStorage.set(step.vmId, picked);
          logInfo(`storage=${picked} for ${scenario.id} [VM ${step.vmId}]`);
        }
      }

      const allAddons = buildResult.selectedAddons ?? [];

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const paramsList = buildResult.params.map((p) => ({ name: p.name, value: p.value }));
      // Inject Zitadel PAT from e2e/config.json so OIDC-addon templates
      // (conf-setup-oidc-client.sh & friends) use it as `ZITADEL_PAT` template
      // var instead of the on-LXC /bootstrap/admin-client.pat fallback.
      // Only when the addons require it AND no explicit value already in
      // buildResult.params (operator override wins).
      if (config.zitadelPat && !paramsList.some((p) => p.name === "ZITADEL_PAT")) {
        paramsList.push({ name: "ZITADEL_PAT", value: config.zitadelPat });
      }
      const paramsObj: Record<string, unknown> = {
        application: scenario.application,
        task,
        params: paramsList,
      };

      if (allAddons.length > 0) paramsObj.selectedAddons = allAddons;
      if (isReplaceCt && existingVm?.addons && existingVm.addons.length > 0) {
        paramsObj.installedAddons = existingVm.addons;
        logInfo(`Installed addons: ${existingVm.addons.join(", ")}`);
      }
      if (buildResult.stackId) {
        paramsObj.stackId = buildResult.stackId;
      } else {
        // step.hasStacktype only reflects the application's own stacktype, but
        // addons can pull in their own stacktypes (e.g. nginx + addon-acme →
        // cloudflare). ensureStacks records the full picture in stackIdMap, so
        // use that as the source of truth — passes addon-only stacks too.
        const appStackIds = stackIdMap.get(`${scenario.application}/${step.stackName}`);
        if (appStackIds && appStackIds.length > 1) {
          paramsObj.stackIds = appStackIds;
        } else if (appStackIds && appStackIds.length === 1) {
          paramsObj.stackId = appStackIds[0];
        }
      }

      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      if (allAddons.length > 0) logInfo(`Addons: ${allAddons.join(", ")}`);

      // Reload deployer. Under --parallel (concurrency > 1) the reload is
      // skipped: PersistenceManager.reload() swaps the singleton instance and
      // re-reads storagecontext from disk — mid-pool that races peer deploys
      // (see plan: read-only deployer ⇒ reload is unnecessary in a non-editing
      // measurement run anyway). Sequenzpfad bleibt unverändert.
      if (concurrency <= 1) {
        try {
          const reloadResp = await runnerHttpJson(runnerAuth, `${apiUrl}/api/reload`, { method: "POST" });
          if (reloadResp.ok) logInfo("Deployer reloaded");
          else logInfo(`Deployer reload returned ${reloadResp.status} (continuing)`);
        } catch {
          logInfo("Deployer reload not available (continuing)");
        }
      }

      // No pre-test snapshot — failure rollback uses the per-application
      // `<app>_deps` host snapshot (created once after all providers, only
      // for single-application run scopes).

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const scenarioFixtureDir = fixtureBaseDir
        ? path.join(fixtureBaseDir, scenario.id.replace("/", "-"))
        : undefined;
      // Decide whether to forward OIDC creds to the CLI subprocess.
      //
      // The CLI uses Bearer for every /api call when --oidc-* are passed; the
      // Hub silently ignores Bearer when OIDC is disabled, so passing creds
      // pre-emptively is harmless. We must pass them in three situations:
      //   1. Deployer currently requires OIDC — re-probed here, because the
      //      single cache at run-start goes stale across the OIDC suite
      //      (enable/disable scenarios flip the Hub's OIDC state mid-run).
      //   2. Scenario flips the deployer TO OIDC (`selectedAddons` includes
      //      `addon-oidc`) — the CLI continues polling AFTER the Hub-replace
      //      and will hit 401 if it didn't start with creds. This is what
      //      bit self-reconfigure-enable-https-oidc: cli_executor was started
      //      without --oidc-*, mid-run the new Hub flipped to OIDC, polling
      //      returned 401 "Authentication required. Use --token."
      //   3. Scenario flips the deployer FROM OIDC (`disabledAddons` includes
      //      `addon-oidc`) — the CLI starts against an OIDC-protected Hub and
      //      needs creds for the pre-switchover phase.
      deployerOidcEnabled = await probeDeployerOidcEnabled();
      const wantsAddonOidc = scenario.selectedAddons?.includes("addon-oidc") ?? false;
      const dropsAddonOidc = scenario.disabledAddons?.includes("addon-oidc") ?? false;
      const useOidc = !!oidcCredentials
        && (deployerOidcEnabled || wantsAddonOidc || dropsAddonOidc);
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout ?? options?.cliTimeoutSec, scenarioFixtureDir,
        useOidc ? oidcCredentials : undefined,
        scenario.disabledAddons,
      );
      // restartKey is now known → bind it to this scenario's log context and
      // ship the buffered pre-CLI events into the bundle right away. The
      // final flush at iteration-end picks up everything after.
      if (cliResult.restartKey) {
        ctx.restartKey = cliResult.restartKey;
        await flushRunnerEvents(ctx);
      }

      // Phase-2 OIDC suite: pick up endpoint-state outputs emitted by
      // template 351-post-emit-endpoint-config from the message stream.
      //
      // Critical ordering: 351 runs in `post_start` AND as the first step
      // of `replace_ct` in oci-image's upgrade/reconfigure pipeline. The
      // replace_ct re-emit is what the CLI subprocess actually needs — it
      // fires immediately before `900-replace-ct` runs `pct stop` on the
      // old Hub, giving the CLI's pendingEndpointUrl capture (cli-progress
      // failover) a final poll window before its URL goes dark. Either
      // emit lands in cliResult.messages, so the runner watcher below
      // updates apiUrl correctly regardless of whether the CLI managed
      // to reach the new Hub mid-task or not.
      //
      // We therefore run the watcher BEFORE the success/failure branch,
      // so the apiUrl + auth state are correct for the next scenario in
      // an OIDC-suite chain regardless of whether THIS scenario's CLI
      // managed to reach the new Hub or not.
      {
        const ep: { url?: string; requiresOidc?: string; issuer?: string } = {};
        for (const msg of cliResult.messages) {
          if (!msg.result) continue;
          // result may carry a leading LXC_MANAGER_JSON_START_MARKER_<id>\n
          // prefix from the SSH-executor's marker mechanism (banner-strip
          // line). The marker is supposed to be stripped server-side before
          // emit, but isn't for some script paths — slice from the first '['
          // so we parse the JSON payload regardless.
          const raw = msg.result;
          const jsonStart = raw.indexOf("[");
          if (jsonStart < 0) continue;
          try {
            const parsed = JSON.parse(raw.slice(jsonStart));
            if (!Array.isArray(parsed)) continue;
            for (const item of parsed) {
              if (item && typeof item === "object" && typeof item.id === "string") {
                if (item.id === "endpoint_url") ep.url = String(item.value ?? "");
                else if (item.id === "endpoint_requires_oidc") ep.requiresOidc = String(item.value ?? "");
                else if (item.id === "endpoint_oidc_issuer") ep.issuer = String(item.value ?? "");
              }
            }
          } catch { /* not JSON */ }
        }
        if (ep.url) {
          const needsOidc = ep.requiresOidc === "true";
          const urlChanged = ep.url !== apiUrl;
          const oidcChanged = needsOidc !== !!oidcCredentials;
          // Only a scenario that replaces the Hub itself may move the runner's
          // apiUrl. Every other scenario reporting an endpoint is noise — and
          // harmful noise under --all, where all workers share this state: one
          // stray report sends every concurrent CLI call to a dead URL. No
          // reachability probe here on purpose; during a genuine Hub replace
          // the new endpoint is briefly down by design.
          const replacesHub = scenario.id.includes("/self-");
          if ((urlChanged || oidcChanged) && !replacesHub) {
            logWarn(
              `Ignoring endpoint report ${ep.url} from ${scenario.id} — only self-* scenarios move the Hub`,
            );
          } else if (urlChanged || oidcChanged) {
            logInfo(`Endpoint state shift: ${apiUrl} → ${ep.url} (OIDC ${needsOidc ? "required" : "cleared"})`);
            apiUrl = ep.url;
            if (!needsOidc) {
              oidcCredentials = undefined;
              delete runnerAuth.oidcCreds;
              delete runnerAuth.token;
              delete runnerAuth.tokenExp;
            } else if (!oidcCredentials) {
              oidcCredentials = await loadOidcCredsFromStack(step.stackName);
              if (oidcCredentials) {
                logOk(`Test OIDC deployer credentials loaded post-switch from oidc_${step.stackName}`);
              }
            }
            // Keep TestResultWriter in sync so the bundle fetch (POSTed
            // after this scenario's write()) goes against the new URL.
            // Without this, debug bundles for a self-reconfigure scenario
            // are always "unavailable — bundle expired" because the writer
            // tries the dead old URL.
            resultWriter?.setApiUrl(apiUrl);
          }
        }
      }

      // expect2fail: if the scenario declares specific templates expected
      // to fail with specific exit codes, evaluate those expectations against
      // the per-template messages. When all expectations are met (and no
      // other unexpected failures occurred), override cliResult.exitCode to
      // 0 so the rest of the pipeline treats this as a passing scenario.
      // Skip wait_seconds in that case — the install was expected to abort,
      // so the container may legitimately be in a partial state.
      const allowed2fail = scenario.allowed2fail ?? {};
      let expect2failApplied = false;
      if (
        (scenario.expect2fail && Object.keys(scenario.expect2fail).length > 0) ||
        Object.keys(allowed2fail).length > 0
      ) {
        const verdict = evaluateExpect2Fail(
          cliResult, scenario.expect2fail ?? {}, allowed2fail,
        );
        if (verdict.matched) {
          const e2f = scenario.expect2fail ?? {};
          const e2fSummary = Object.keys(e2f).length > 0
            ? `expect2fail: ${Object.entries(e2f).map(([t, c]) => `${t}→${c}`).join(", ")}`
            : "";
          const a2fHit = allowed2failTriggered(cliResult, allowed2fail);
          const a2fSummary = Object.keys(allowed2fail).length > 0
            ? `allowed2fail: ${Object.entries(allowed2fail).map(([t, c]) => `${t}→${c}${a2fHit ? " (triggered)" : ""}`).join(", ")}`
            : "";
          logInfo(
            `tolerated failures satisfied — ${[e2fSummary, a2fSummary].filter(Boolean).join("; ")} — treating scenario as passed`,
          );
          cliResult.exitCode = 0;
          // Skip wait_seconds whenever a tolerated failure short-circuited
          // the pipeline — the container may be in a partial state on purpose.
          expect2failApplied = Object.keys(e2f).length > 0 || a2fHit;
        } else {
          // Force failure with a clear diagnostic; preserve original
          // exit code if non-zero, otherwise synthesize 1.
          if (cliResult.exitCode === 0) cliResult.exitCode = 1;
          const mismatchBlock = verdict.mismatches.map((m) => `  - ${m}`).join("\n");
          cliResult.output =
            `${cliResult.output}\n--- tolerated-failure MISMATCH ---\n${mismatchBlock}\n`;
        }
      }

      // Container-stability poll during wait_seconds. The install pipeline's
      // `900-host-check-container` runs once near the end of the installer and
      // can miss late crashes (e.g. postgres PANIC during initdb when the data
      // volume is too small). Polling `pct status` here closes that window so
      // a crashed container fails the scenario instead of silently passing.
      // Docker-compose apps still use waitForServices in the success path.
      const appMeta = appMetaMap.get(scenario.application) ?? {};
      const waitSeconds = scenario.wait_seconds ?? appMeta.verification?.wait_seconds ?? 0;
      // Use the resolved framework (walks the full extends chain) — `extends`
      // is the direct parent only, which is e.g. `json:zitadel` for a local
      // test override that ultimately inherits from docker-compose.
      const isDockerCompose = (appMeta.framework ?? appMeta.extends) === "docker-compose";

      // docker-compose `upgrade` is in-place: it patches compose image tags
      // and restarts services on the existing container — no new LXC. The
      // planned `step.vmId` (next-free reserved by the test planner) was
      // never allocated by the pipeline, so subsequent waitForServices /
      // verifier checks would target a missing VM. Snap step.vmId back to
      // the previous container that actually got upgraded.
      if (cliResult.exitCode === 0 && isDockerCompose && task === "upgrade" && existingVm?.vm_id) {
        if (step.vmId !== existingVm.vm_id) {
          logInfo(`docker-compose in-place upgrade: target VM is ${existingVm.vm_id} (was ${step.vmId})`);
          step.vmId = existingVm.vm_id;
        }
      }

      // Hidden host apps (e.g. proxmox host reconfigure) don't create an LXC,
      // so polling pct status against step.vmId would always fail. Also skip
      // when expect2fail rewrote the result — the install was expected to
      // abort, so the container may legitimately be in a partial state.
      if (cliResult.exitCode === 0 && waitSeconds > 0 && !isDockerCompose && !isHiddenApp && !expect2failApplied) {
        logInfo(`Waiting ${waitSeconds}s for container to stay healthy...`);
        const health = await waitForContainerStable(
          config.pveHost, config.portPveSsh, step.vmId, waitSeconds,
        );
        if (!health.ok) {
          cliResult.exitCode = 1;
          const crashMsg = `Container ${step.vmId} (${step.hostname}) crashed during wait_seconds (status: ${health.status})`;
          cliResult.output = `${cliResult.output}\n--- POST-INSTALL CRASH ---\n${crashMsg}\n`;
        }
      }

      if (cliResult.exitCode !== 0) {
        const errMsg = `Scenario failed: ${scenario.id} (${task})`;
        logFail(errMsg);
        // Surface the CLI's actual output (Backend-Antwort + stderr) so the
        // runner log doesn't just say "Execution failed at step 'Failed'".
        // Tagged with the scenario id so log readers can correlate under
        // --parallel where lines interleave.
        if (cliResult.output && cliResult.output.trim()) {
          const tag = `[${scenario.id}]`;
          for (const line of cliResult.output.trimEnd().split("\n")) {
            logInfo(`${tag} ${line}`);
          }
        }
        if (cliResult.restartKey) {
          logInfo(`[${scenario.id}] restartKey=${cliResult.restartKey}`);
        }

        // Collect failure logs BEFORE rollback (VM still in broken state)
        const failureLogs = collectFailureLogs(
          config.pveHost, config.portPveSsh,
          step.vmId, step.hostname, cliResult.output,
        );

        // Rollback to the per-application `<app>_deps` snapshot (atomic
        // whole-VM snapshot on host PVE) to restore consistent state across
        // all stack-provider LXCs and the nested-VM host FS. Skipped when
        // this run has no dependency-snapshot scope (--all / multi-app) or no
        // providers were planned.
        // KEEP_VM also skips the rollback so the failed LXC stays available
        // for inspection (rollback would destroy it atomically).
        const keepForDebug = !!process.env.KEEP_VM;
        if (keepForDebug) {
          logInfo(`KEEP_VM set — skipping rollback to @${depSnapshotName ?? "dep-snapshot"} (failed VM ${step.vmId} preserved for inspection)`);
        }
        // Failure-rollback per Dep-CT (pct rollback). Container-lokal —
        // beeinflusst andere Cluster nicht. Trotzdem nur im sequentiellen
        // Driver (concurrency<=1) ausführen: ein mid-pool Rollback eines
        // Dep-CTs würde gleichzeitig laufende Consumer kaputt machen, die
        // genau auf diesem Dep-CT installieren/verifizieren. Im
        // Parallel-Pfad fällt ein gescheitertes Szenario stattdessen einfach
        // durch (und blockiert via classifyParallel seine Dependents).
        if (concurrency <= 1 && snapMgr && depSnapshotName && !step.isDependency && !keepForDebug) {
          try {
            const depVmids = planned.filter((p) => p.isDependency).map((p) => p.vmId);
            await Promise.all(depVmids.map((v) => snapMgr.rollbackCtSnapshot(v, depSnapshotName)));
            // After the rollback the Hub LXC has not been touched (it is
            // read-only / not snapshotted); Spoke-Hub-Calls bleiben verfügbar.
            checkVolumeConsistency(
              config.pveHost, config.portPveSsh, projectRoot,
              `pct rollback to ${depSnapshotName}`,
            );
          } catch (err) {
            logInfo(`Warning: pct rollback to @${depSnapshotName} failed: ${err}`);
          }
        }

        result.errors.push(errMsg);
        result.failed++;
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
          cliOutput: cliResult.output,
        });

        if (resultWriter) {
          await resultWriter.write(TestResultWriter.buildResult({
            runId: resultWriter.getRunId(),
            scenarioId: scenario.id, application: scenario.application, task,
            status: "failed", vmId: step.vmId, hostname: step.hostname,
            stackName: step.stackName, addons: scenario.selectedAddons ?? [],
            startedAt: stepStartTime, finishedAt: new Date(),
            deployerVersion, deployerGitHash,
            commandLine: resultWriter.getCommandLine(),
            dependencies: [], verifyResults: {}, errorMessage: errMsg,
            logs: failureLogs,
            ...(cliResult.restartKey ? { restartKey: cliResult.restartKey } : {}),
          }));
        }

        // Failure → let the driver partition remaining tests (sequential)
        // or block dependents (parallel). Keeps the orchestration that needs
        // the plan index / scheduling state out of the per-step unit.
        return { type: "failed-partition", scenarioId: scenario.id };
      }

      // For replace_ct: discover new VM ID. Pass step.hostname so the lookup
      // disambiguates between siblings of the same application (e.g. nginx
      // tests run with hostnames nginx-default, nginx-acme, nginx-oidc-ssl,
      // nginx-reconf-addons-on, nginx-reconf-addons-off — all share
      // application-id=nginx, so without hostname the lowest-VMID match wins
      // and we record the wrong container).
      if (isReplaceCt) {
        const newVm = await findExistingVm(apiUrl, veHost, scenario.application, config.pveHost, config.portPveSsh, step.hostname);
        if (newVm) {
          logOk(`replace_ct: new VM_ID=${newVm.vm_id} (was ${step.vmId})`);
          step.vmId = newVm.vm_id;
        }
      }

      // Block until lxc-attach actually works on the (possibly freshly
      // replaced) container. `pct status: running` flips early — the
      // kernel can be done bringing up the LXC engine state long before
      // init/cgroup are responsive. Without this gate the next pipeline
      // step (or the very next scenario, e.g. docker-compose's reconfigure
      // pre-pull which `lxc-attach`es into the previous container) races
      // init startup and fails with
      //   "lxc-attach: 406 Connection refused - Failed to get init pid"
      // Applies to all frameworks — oci-image and docker-compose alike;
      // hidden host-only apps (vm_id=0) and dependency steps that were
      // skipped (via snapshot restore) skip this poll.
      if (!isHiddenApp && step.vmId > 0 && cliResult.exitCode === 0) {
        const initWait = await waitForLxcInit(config.pveHost, config.portPveSsh, step.vmId, 30);
        if (!initWait.ok) {
          logWarn(`LXC ${step.vmId} init not responsive after 30s: ${initWait.lastError}`);
        } else if (initWait.waitedMs > 1500) {
          // Don't log the fast path (sub-1.5s) to keep output clean; surface
          // only when the race window actually mattered.
          logInfo(`LXC ${step.vmId} init responsive after ${initWait.waitedMs}ms`);
        }
      }

      logOk(`Container ready: VM_ID=${step.vmId}, hostname=${step.hostname}`);
      result.steps.push({
        vmId: step.vmId, hostname: step.hostname,
        application: scenario.application, scenarioId: scenario.id,
        cliOutput: cliResult.output,
      });

      // After Zitadel installation: load test-deployer credentials from the
      // oidc_<stack> stack (Zitadel emits DEPLOYER_OIDC_* as provides during
      // its post_start templates — same mechanism every addon-oidc consumer
      // uses to wire its container envs).
      if (scenario.application === "zitadel" && task === "installation" && !oidcCredentials) {
        oidcCredentials = await loadOidcCredsFromStack(step.stackName);
        if (oidcCredentials) {
          logOk(`Test OIDC deployer credentials loaded from oidc_${step.stackName} stack`);
        } else {
          logInfo(`OIDC credentials not in oidc_${step.stackName} stack (delegated access not available)`);
        }
      }

      // Wait for services. Docker-compose apps use waitForServices to poll
      // `docker ps` for "Up" status. Non-docker-compose apps already had their
      // wait period (with `pct status` polling) before the failure check above.
      if (waitSeconds > 0 && isDockerCompose) {
        await waitForServices(config.pveHost, config.portPveSsh, step.vmId, waitSeconds, { info: logInfo, ok: logOk, warn: logWarn });
      }

      // Verify
      const defaultVerify = buildDefaultVerify(scenario, appMeta);
      const finalVerify = { ...defaultVerify, ...(scenario.verify ?? {}) };
      for (const [k, v] of Object.entries(finalVerify)) {
        if (v === false) delete finalVerify[k];
      }
      logInfo("Verifying...");
      await verifier.runAll(step.vmId, step.hostname, finalVerify, planned);

      // Optional Playwright spec(s) — runs after verifications pass. The
      // browser server is reached via PLAYWRIGHT_WS (port-forwarded outer
      // PVE), the app under test is addressed by container hostname (the
      // remote browser is on the same vmbr1 network and resolves it via
      // dnsmasq). Specs receive APP_HOSTNAME and decide port/scheme based
      // on app convention. Opt-out via LIVETEST_SKIP_PLAYWRIGHT=1.
      let playwrightFailed = false;
      if (
        scenario.playwright_spec &&
        process.env.LIVETEST_SKIP_PLAYWRIGHT !== "1"
      ) {
        const specs = Array.isArray(scenario.playwright_spec)
          ? scenario.playwright_spec
          : [scenario.playwright_spec];
        const usesSsl = (scenario.selectedAddons ?? []).includes("addon-ssl");
        const instanceFile = path.join(projectRoot, "e2e/.current-instance");
        const instance = existsSync(instanceFile)
          ? readFileSync(instanceFile, "utf-8").trim()
          : "yellow";
        const playwrightEnv: Record<string, string> = {
          ...collectScenarioEnv({
            instance,
            pveHost: config.pveHost,
            pveSshPort: config.portPveSsh,
            projectRoot,
            appHostname: step.hostname,
            appVmId: step.vmId,
            appHttps: usesSsl,
          }),
        };
        // Forward Zitadel test-deployer credentials so the spec's
        // getDeployerToken() fixture can do client_credentials grant.
        if (oidcCredentials) {
          // scenario-executor's port-forward rewrite only replaces the
          // bare hostname, leaving a stray ".local" tail when the source URL
          // ended on a hostname.local TLD. Strip it so URL parsing works.
          const cleanIssuer = oidcCredentials.issuerUrl
            .replace(/\.local(?=[/:]|$)/, "");
          playwrightEnv.OIDC_ISSUER_URL = cleanIssuer;
          playwrightEnv.DEPLOYER_OIDC_MACHINE_CLIENT_ID =
            oidcCredentials.clientId;
          playwrightEnv.DEPLOYER_OIDC_MACHINE_CLIENT_SECRET =
            oidcCredentials.clientSecret;
        }

        // Pre-step: grant the test-deployer machine user all roles of all
        // currently-existing OIDC projects on the *specific* Zitadel instance
        // this scenario depends on. We resolve the right Zitadel via
        // scenario.depends_on so test variants targeting different Zitadel
        // deployments (e.g. zitadel/default vs. zitadel/ssl) hit the matching
        // one instead of whichever container `pct list` returns first.
        //
        // Tests that need an authenticated OIDC session MUST declare a
        // dependency on a zitadel scenario; otherwise this step is skipped
        // (the dev-session bypass still validates the token via UserInfo, so
        // it can succeed if no OIDC_REQUIRED_ROLE is enforced).
        try {
          const zitadelDep = (scenario.depends_on ?? [])
            .map((depId) => planned.find((p) => p.scenario.id === depId))
            .find((p) => p?.scenario.application === "zitadel");
          if (!zitadelDep) {
            logWarn(
              `No zitadel/* in depends_on of ${scenario.id} — skipping test-deployer grant refresh`,
            );
          } else {
            const grantScriptPath = path.join(
              projectRoot,
              "livetest-local/applications/zitadel/scripts/post-grant-test-deployer-all-roles.sh",
            );
            if (existsSync(grantScriptPath)) {
              const zitadelHostname = zitadelDep.hostname;
              const usesSslZitadel = (zitadelDep.scenario.selectedAddons ?? [])
                .includes("addon-ssl");
              const rendered = readFileSync(grantScriptPath, "utf-8")
                .replace(/\{\{\s*hostname\s*\}\}/g, zitadelHostname)
                .replace(/\{\{\s*project_domain_suffix\s*\}\}/g, "")
                .replace(
                  /\{\{\s*ssl_mode\s*\}\}/g,
                  usesSslZitadel ? "certs" : "",
                );
              logInfo(
                `Granting test-deployer all project roles on ${zitadelDep.scenario.id} (CT ${zitadelDep.vmId})...`,
              );
              await nestedSshStrictAsync(
                config.pveHost,
                config.portPveSsh,
                `pct exec ${zitadelDep.vmId} -- sh -s`,
                60000,
                rendered,
              );
              logOk("test-deployer grants refreshed");
            }
          }
        } catch (err) {
          // Non-fatal: the grant refresh may legitimately fail when zitadel
          // is already hardened (PAT gone). The dev-session bypass works
          // without role updates if no OIDC_REQUIRED_ROLE is enforced.
          logWarn(
            `test-deployer grant refresh failed (continuing): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Per-scenario artifact dir: lives next to the backend bundle so
        // everything related to the failing run sits in one place. Playwright
        // writes trace.zip / screenshot / video / report.json here (see
        // playwright.config.ts), and we mirror its stdout/stderr into
        // playwright-output.log so the spec's own assertion text is preserved
        // without needing to scroll the terminal.
        const scenarioResultDir = resultWriter
          ? path.join(resultWriter.getOutputDir(), scenario.id.replace("/", "-"))
          : path.join(projectRoot, "livetest-results", "_no-writer", scenario.id.replace("/", "-"));
        const pwArtifactsDir = path.join(scenarioResultDir, "playwright-artifacts");
        const pwLogPath = path.join(scenarioResultDir, "playwright-output.log");
        try { writeFileSync(pwLogPath, ""); } catch { /* dir may not exist yet — runner creates it */ }

        for (const spec of specs) {
          // A playwright_spec may be authored in the app that *defines* the
          // scenario and only inherited (via `extends`) by the running app —
          // e.g. test-proxvex-deployer (extends json:proxvex) reuses
          // proxvex's proxvex.spec.ts, which lives in
          // json/applications/proxvex/tests/playwright/. scenario.appDir is a
          // single (overlay-only) path, so resolve the spec across every
          // candidate base: scenario.appDir, the running app's
          // livetest-local + json dirs, then walk the extends chain doing the
          // same for each parent. First existing match wins. (Same
          // overlay→canonical→hierarchy rationale as the template resolver.)
          const specCandidateBases: string[] = [];
          const addBase = (b?: string) => {
            if (b && !specCandidateBases.includes(b)) specCandidateBases.push(b);
          };
          addBase(scenario.appDir);
          const readExtends = (appId: string): string | undefined => {
            for (const root of ["livetest-local/applications", "json/applications"]) {
              const aj = path.join(projectRoot, root, appId, "application.json");
              if (!existsSync(aj)) continue;
              try {
                const ext = JSON.parse(readFileSync(aj, "utf-8"))?.extends;
                if (typeof ext === "string" && ext)
                  return ext.includes(":") ? ext.slice(ext.indexOf(":") + 1) : ext;
              } catch {
                /* malformed application.json — ignore for spec resolution */
              }
              return undefined;
            }
            return undefined;
          };
          let curApp: string | undefined = scenario.application;
          const seenApps = new Set<string>();
          while (curApp && !seenApps.has(curApp)) {
            seenApps.add(curApp);
            addBase(path.join("livetest-local/applications", curApp));
            addBase(path.join("json/applications", curApp));
            curApp = readExtends(curApp);
          }
          let specPath: string | undefined;
          let absSpec: string | undefined;
          for (const base of specCandidateBases) {
            const candidate = path.join(base, "tests/playwright", spec);
            const abs = path.join(projectRoot, candidate);
            if (existsSync(abs)) {
              specPath = candidate;
              absSpec = abs;
              break;
            }
          }
          if (!specPath || !absSpec) {
            throw new Error(
              `playwright_spec missing: ${spec} — searched ${specCandidateBases
                .map((b) => path.join(b, "tests/playwright", spec))
                .join(", ")} (app=${scenario.application}, appDir=${scenario.appDir ?? "unset"})`,
            );
          }
          logInfo(`Playwright: ${specPath} (artifacts → ${path.relative(projectRoot, pwArtifactsDir)})`);
          const proc = spawnSync(
            "pnpm",
            ["run", "test:applications", "--", specPath],
            {
              cwd: projectRoot,
              env: {
                ...process.env,
                ...playwrightEnv,
                PLAYWRIGHT_OUTPUT_DIR: pwArtifactsDir,
              },
              stdio: "pipe",
              encoding: "utf-8",
            },
          );
          // Mirror to terminal (so the live run is still watchable) AND
          // persist to disk for the bundle.
          const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
          process.stdout.write(combined);
          try {
            const { appendFileSync, mkdirSync } = await import("node:fs");
            mkdirSync(scenarioResultDir, { recursive: true });
            appendFileSync(
              pwLogPath,
              `\n=== ${specPath} (exit ${proc.status}) ===\n${combined}`,
            );
          } catch { /* non-fatal — we still threw above */ }
          if (proc.status !== 0) {
            // Write a `status: failed` result so the bundle (test-result.md +
            // artifacts) is accessible post-mortem, then mark this scenario
            // failed and move on. Previously we threw, which aborted the
            // entire --all run on the first failing spec.
            const errMsg = `Playwright spec failed: ${specPath} (exit ${proc.status})`;
            if (resultWriter) {
              await resultWriter.write(TestResultWriter.buildResult({
                runId: resultWriter.getRunId(),
                scenarioId: scenario.id, application: scenario.application, task,
                status: "failed", vmId: step.vmId, hostname: step.hostname,
                stackName: step.stackName, addons: scenario.selectedAddons ?? [],
                startedAt: stepStartTime, finishedAt: new Date(),
                deployerVersion, deployerGitHash,
                commandLine: resultWriter.getCommandLine(),
                dependencies: [], verifyResults: {}, errorMessage: errMsg,
                ...(cliResult.restartKey ? { restartKey: cliResult.restartKey } : {}),
              }));
            }
            logFail(errMsg);
            result.errors.push(errMsg);
            result.failed++;
            playwrightFailed = true;
            break;  // skip remaining specs for this scenario, fall through to cleanup below
          }
          logOk(`Playwright passed: ${specPath}`);
        }
      }
      if (playwrightFailed) return { type: "done" };

      // Write test result
      if (resultWriter) {
        const depInfos: TestResultDependency[] = await Promise.all((scenario.depends_on ?? []).map(async (depId) => {
          const depStep = planned.find((p) => p.scenario.id === depId);
          const depApp = depId.split("/")[0] ?? "";
          const prefix = depApp.toUpperCase().replace(/-/g, "_");
          let version = cliResult.resolvedVersions.get(prefix) ?? "";
          if (!version && depStep) {
            try {
              const raw = await nestedSshAsync(config.pveHost, config.portPveSsh,
                `sed -n 's/.*proxvex%3Aversion \\([^ <]*\\).*/\\1/p' /etc/pve/lxc/${depStep.vmId}.conf 2>/dev/null | head -1`,
                5000);
              version = decodeURIComponent(raw.trim());
            } catch { /* ignore */ }
          }
          return {
            scenario_id: depId, vm_id: depStep?.vmId ?? 0,
            status: "passed" as const, version,
            snapshot_used: snapMgr && depSnapshotName ? depSnapshotName : null,
            snapshot_date: null,
          };
        }));
        await resultWriter.write(TestResultWriter.buildResult({
          runId: resultWriter.getRunId(),
          scenarioId: scenario.id, application: scenario.application, task,
          status: "passed", vmId: step.vmId, hostname: step.hostname,
          stackName: step.stackName, addons: scenario.selectedAddons ?? [],
          startedAt: stepStartTime, finishedAt: new Date(),
          deployerVersion, deployerGitHash,
          commandLine: resultWriter.getCommandLine(),
          dependencies: depInfos,
          verifyResults: Object.fromEntries(
            Object.entries(finalVerify).map(([k, v]) => [k, !!v]),
          ),
          ...(cliResult.restartKey ? { restartKey: cliResult.restartKey } : {}),
        }));
      }

      // No end-of-run consumer teardown: the next run's pre-cleanup step
      // (single-scenario mode in vm-lifecycle.mts:preCleanupNonSnapshotConsumers)
      // disposes of non-snapshot, non-needed CTs at the start. Keeping
      // consumer CTs running between runs means a follow-up `livetest
      // <same-app>` finds them, the pre-cleanup leaves them alone if needed,
      // or destroys them otherwise — all in one place.

      // After the LAST stack-provider step, create the per-application
      // `<app>_deps` snapshot on the host PVE. Subsequent runs of the SAME
      // single application reuse it as a clean dependency baseline (and as
      // the failure-rollback target). Only created when this run has a
      // dependency-snapshot scope (single selected application, not `--all`);
      // a broad/`--all` run never snapshots, so a consumer's state can never
      // be baked into a snapshot a later narrow run would reuse. The captured
      // dep set is encoded in the description (see SnapshotManager.coversRun).
      //
      // Skipped under --parallel: a mid-pool `qm snapshot` would capture an
      // inconsistent state (peer scenarios in flight). Dependency snapshots
      // are produced only by the sequential driver or a dedicated, exclusive
      // build pass — never from inside the concurrent pool.
      if (concurrency <= 1 && snapMgr && depSnapshotName && step.isDependency && !step.skipExecution
          && planned.slice(i + 1).every((p) => !p.isDependency)) {
        try {
          // One pct snapshot per dep CT with the same logical name; the
          // declared members enumerate ALL participating dep scenario IDs.
          // Build-Hash steht zur Information in der Description (siehe
          // Lebensdauer-Policy: bei Mismatch nur warnen, nicht ablehnen).
          const depSteps = planned.filter((p) => p.isDependency);
          const memberIds = depSteps.map((p) => p.scenario.id);
          const description = SnapshotManager.buildDescription({
            name: depSnapshotName,
            members: memberIds,
            ...(buildHash !== undefined ? { buildHash } : {}),
          });
          await Promise.all(depSteps.map((dep) =>
            snapMgr.createCtSnapshot(dep.vmId, depSnapshotName, description),
          ));
        } catch (err) {
          logInfo(`Snapshot creation failed (non-fatal): ${err}`);
        }
      }

      // Per-catalog-member snapshot (mode-independent): after a scenario
      // listed in the snapshot catalog finishes successfully, create one pct
      // snapshot per CT in its transitive dep closure (itself + all deps the
      // member declared via depends_on), all carrying the same sanitized id
      // as the snapshot name. Runs in EVERY mode (single, all, file, even
      // --from-snapshot) so a snapshot lost during the run's prepareVms
      // destroy of the target is restored to disk on success.
      //
      // Idempotent: SnapshotManager.createCtSnapshot drops a pre-existing
      // same-name snapshot before creating, so re-snapshotting always wins.
      // Parallel-safe per CT (`pct snapshot` is container-local). The
      // catalog is curated so members have disjoint dep CTs.
      if (snapMgr && !step.skipExecution && snapshotCatalog.has(scenario.id)) {
        try {
          const snapshotName = sanitizeScenarioIdForSnapshot(scenario.id);
          // Build the transitive dep id closure for this scenario via allTests
          // (planned only carries scenarios that were also selected as deps of
          // some other planned scenario, but the closure we want is exactly
          // what `depends_on` defines).
          const memberClosure = new Set<string>([scenario.id]);
          const walk = (id: string): void => {
            const s = allTests.get(id);
            if (!s) return;
            for (const dep of s.depends_on ?? []) {
              if (memberClosure.has(dep)) continue;
              memberClosure.add(dep);
              walk(dep);
            }
          };
          walk(scenario.id);
          // Map closure ids to VMIDs via the planned-set; ids that are not
          // in the planned-set (e.g. catalog member with deps the runner
          // dropped due to env-filter) are silently skipped.
          const closureVmids = new Map<number, string>();
          closureVmids.set(step.vmId, scenario.id);
          for (const id of memberClosure) {
            if (id === scenario.id) continue;
            const dep = planned.find((p) => p.scenario.id === id);
            if (dep) closureVmids.set(dep.vmId, id);
          }
          const description = SnapshotManager.buildDescription({
            name: snapshotName,
            members: [...memberClosure],
            ...(buildHash !== undefined ? { buildHash } : {}),
          });
          await Promise.all([...closureVmids.keys()].map((vmid) =>
            snapMgr.createCtSnapshot(vmid, snapshotName, description),
          ));
          logOk(`Catalog snapshot @${snapshotName} created on VM(s) ${[...closureVmids.keys()].join(", ")}`);
        } catch (err) {
          logInfo(`Per-member snapshot failed (non-fatal): ${err}`);
        }
      }

      // `--snapshot <name>` build mode: after the LAST listed scenario
      // (= the last entry in `planned`) installed successfully, write one
      // pct snapshot per planned CT with the explicit cluster name. All
      // listed members were marked isDependency by the runner, so they are
      // already exempt from teardown above. The build itself ran with the
      // normal livetest pipeline → full debug bundle + bootstrap diagnosis.
      if (concurrency <= 1 && snapMgr && snapshotMode && !step.skipExecution && i === planned.length - 1) {
        try {
          const memberIds = planned.map((p) => p.scenario.id);
          const description = SnapshotManager.buildDescription({
            name: snapshotMode,
            members: memberIds,
            ...(buildHash !== undefined ? { buildHash } : {}),
          });
          await Promise.all(planned.map((p) =>
            snapMgr.createCtSnapshot(p.vmId, snapshotMode, description),
          ));
          logOk(`pct snapshots @${snapshotMode} created on VMs ${planned.map((p) => p.vmId).join(", ")}`);
        } catch (err) {
          logInfo(`--snapshot build failed (non-fatal): ${err}`);
        }
      }

      // Consumer-stop (`pct stop` after !isDependency steps) was attempted
      // here to free nested-VM RAM during `--all` but reverted on
      // 2026-05-21: zitadel/ssl (and similar) use postgres-ssl via stack-
      // name match without an explicit `depends_on: ["postgres/ssl"]`, so
      // `dependedOn` misses them. The result was postgres/ssl getting
      // stopped before zitadel/ssl read its CA cert. Once we have a
      // stack/cert-aware "still-needed" predicate the stop can come back;
      // until then 4c/8G nested VM defaults absorb the load.

      return { type: "done" };
      } catch (iterErr) {
        // Uncaught exception during this scenario — turn it into a "failed"
        // result so the run continues with the remaining scenarios. The
        // partitionAfterFailure logic above (used by the cliResult.exitCode !== 0
        // path) is bypassed here because we may have thrown before reaching it,
        // so blocked downstream scenarios will simply fail their own pre-flight
        // checks rather than being marked "skipped" — that's acceptable for the
        // crash path (better than zero results).
        const errMsg = `Scenario crashed: ${scenario.id} (${task}): ${iterErr instanceof Error ? iterErr.message : String(iterErr)}`;
        logFail(errMsg);
        if (iterErr instanceof Error && iterErr.stack) {
          logInfo(iterErr.stack);
        }
        result.errors.push(errMsg);
        result.failed++;
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        if (resultWriter) {
          try {
            await resultWriter.write(TestResultWriter.buildResult({
              runId: resultWriter.getRunId(),
              scenarioId: scenario.id, application: scenario.application, task,
              status: "failed", vmId: step.vmId, hostname: step.hostname,
              stackName: step.stackName, addons: scenario.selectedAddons ?? [],
              startedAt: stepStartTime, finishedAt: new Date(),
              deployerVersion, deployerGitHash,
              commandLine: resultWriter.getCommandLine(),
              dependencies: [], verifyResults: {}, errorMessage: errMsg,
            }));
          } catch { /* result write failure — already logging the throw above */ }
        }
        // Fail-fast decision is deferred to the driver (the `finally` clone
        // cleanup below still runs before the driver sees this outcome).
        return { type: "crashed", err: iterErr };
      } finally {
        // Phase 2: destroy any source clones we made for this scenario.
        // Runs on pass, fail AND crash so isolated clones never leak across
        // the --all run. KEEP_VM=1 preserves them for post-mortem inspection
        // (same flag honoured for the main consumer CT below).
        if (process.env.KEEP_VM) {
          for (const cloneVmId of sourceCloneVmIds) {
            logInfo(`KEEP_VM set — preserving source clone VM ${cloneVmId} for inspection`);
          }
        } else {
          for (const cloneVmId of sourceCloneVmIds) {
            try {
              await nestedSshAsync(
                config.pveHost, config.portPveSsh,
                `pct stop ${cloneVmId} 2>/dev/null; pct unlock ${cloneVmId} 2>/dev/null; pct destroy ${cloneVmId} --force --purge 2>/dev/null; true`,
                30000,
              );
              logInfo(`Destroyed source clone VM ${cloneVmId}`);
            } catch { /* best-effort */ }
          }
        }
        // Final flush: send any remaining buffered runner events to the
        // bundle before runStep returns. restartKey may be unset (deploy
        // didn't reach the CLI summary line); in that case the events stay
        // in console output only.
        await flushRunnerEvents(ctx);
      }
    });
  };

  // Apply the partition-after-failure bookkeeping for a failed scenario:
  // skip every still-pending scenario that (transitively) depends on it.
  // Shared by both drivers (the sequential one also reorders `planned` so
  // unaffected siblings keep running before the blocked ones).
  const applyFailurePartition = (
    failedId: string,
    fromIndex: number,
    reorder: boolean,
  ): void => {
    const remaining = planned.slice(fromIndex + 1);
    const allTestsMap = new Map(planned.map((p) => [p.scenario.id, p.scenario]));
    const { unaffected, blocked } = partitionAfterFailure(
      failedId, remaining, allTestsMap,
    );
    if (reorder && unaffected.length > 0 && blocked.length > 0) {
      logInfo(`${failedId} failed — running ${unaffected.length} unaffected test(s), skipping ${blocked.length} blocked`);
      for (let u = 0; u < unaffected.length; u++) {
        planned[fromIndex + 1 + u] = unaffected[u]!;
      }
      for (let b = 0; b < blocked.length; b++) {
        planned[fromIndex + 1 + unaffected.length + b] = blocked[b]!;
      }
    }
    for (const b of blocked) {
      if (b.skipExecution) continue;
      logWarn(`Skipping ${b.scenario.id} (blocked by failed dependency ${failedId})`);
      b.skipExecution = true;
      result.errors.push(`Skipped: ${b.scenario.id} (dependency ${failedId} failed)`);
    }
  };

  try {
    if (concurrency > 1) {
      // ── Parallel driver ──────────────────────────────────────────────
      // Bounded async pool in the single Node process. A scenario starts
      // only when every depends_on entry that is part of this plan has
      // finished successfully; a failed/crashed scenario blocks its
      // dependents (same semantics as the sequential partition). The
      // performance win is purely from overlapping the long idle waits
      // (container create, package install, docker compose up,
      // wait_seconds, Playwright) — the deployer/API stay single.
      // Worker model: one logical worker per parallel-storage. A scenario
      // can only be dispatched if its assigned storage's worker is idle
      // (i.e. not in `busyStorages`). This caps effective parallelism at
      // min(concurrency, parallelStorages.length) and structurally prevents
      // `/var/lock/pve-manager/pve-storage-<name>` contention.
      //
      // If no parallel storages are available (SSH enumeration failed) the
      // gate falls back to the unconstrained `concurrency` cap — same as
      // pre-storage-gate behaviour.
      const effectiveCap = parallelStorages.length > 0
        ? Math.min(concurrency, parallelStorages.length)
        : concurrency;
      logInfo(`Parallel scenario execution: concurrency=${concurrency}` + (
        effectiveCap < concurrency
          ? ` (effective=${effectiveCap}, capped by storages=${parallelStorages.length})`
          : ""
      ));
      type St = "pending" | "running" | "done" | "failed";
      const state: St[] = planned.map(() => "pending");
      const busyStorages = new Set<string>();
      // Track scenarios already logged as "waiting for storage" so each
      // gated scenario produces exactly one wait-line, not one per pump tick.
      // Cleared on dispatch so a scenario that waits, dispatches, completes,
      // and is later re-evaluated (shouldn't happen, but safe) re-logs.
      const waitLogged = new Set<number>();
      // Catalog-phase indices for the fail-fast gate: if any catalog member
      // fails, everything downstream is wasted work (the run can't produce
      // valid snapshots, and OIDC consumers depend on a healthy Zitadel
      // anyway). Empty when no catalog → gate disabled.
      const catalogIdx = new Set<number>();
      planned.forEach((p, i) => {
        if (snapshotCatalog.has(p.scenario.id)) catalogIdx.add(i);
      });
      let catalogAbortLogged = false;
      let active = 0;
      let crashedErr: unknown = null;
      let aborted = false;
      await new Promise<void>((resolve) => {
        const pump = (): void => {
          if (aborted) {
            if (active === 0) resolve();
            return;
          }
          if (state.every((s) => s === "done" || s === "failed")) {
            resolve();
            return;
          }
          // Catalog-phase fail-fast: once every catalog member has reached
          // a terminal state, abort the run if any of them failed. The
          // remaining scenarios (typically 50+ OIDC consumers) depend on a
          // healthy snapshot chain, so continuing is wasted minutes.
          if (catalogIdx.size > 0 && !catalogAbortLogged) {
            let allTerminal = true;
            let anyFailed = false;
            for (const i of catalogIdx) {
              const s = state[i];
              if (s === "pending" || s === "running") { allTerminal = false; break; }
              if (s === "failed") anyFailed = true;
            }
            if (allTerminal && anyFailed) {
              const failedNames = [...catalogIdx]
                .filter((i) => state[i] === "failed")
                .map((i) => planned[i]!.scenario.id);
              logFail(`Catalog phase failed (${failedNames.length}/${catalogIdx.size}: ${failedNames.join(", ")}) — aborting remaining scenarios.`);
              catalogAbortLogged = true;
              aborted = true;
              // Mark every still-pending scenario as skipped with the
              // catalog reason so the overview/result writer reports a
              // clear cause instead of a missing-data void.
              for (let i = 0; i < planned.length; i++) {
                if (state[i] === "pending") {
                  state[i] = "failed";
                  const p = planned[i]!;
                  if (!p.skipExecution) {
                    p.skipExecution = true;
                    result.errors.push(`Skipped: ${p.scenario.id} (catalog phase failed)`);
                    markStatus(i, "skipped", "catalog phase failed");
                  }
                }
              }
            }
          }
          if (aborted) {
            if (active === 0) resolve();
            return;
          }
          // Cascade blocked scenarios to a fixpoint (a failed dep blocks its
          // dependents, which transitively block theirs) before scheduling.
          let ready: number[] = [];
          for (;;) {
            const c = classifyParallel(planned, state);
            ready = c.ready;
            if (c.blocked.length === 0) break;
            for (const idx of c.blocked) {
              state[idx] = "failed";
              const p = planned[idx]!;
              // markStatus must run for every blocked scenario, even when
              // `skipExecution` was already set by applyFailurePartition
              // earlier in this pump cycle — otherwise the overview shows
              // them as "pending" forever. The skipExecution guard only
              // dedupes the warn-log + result.errors push.
              if (!p.skipExecution) {
                logWarn(`Skipping ${p.scenario.id} (blocked by failed dependency)`);
                p.skipExecution = true;
                result.errors.push(`Skipped: ${p.scenario.id} (blocked dependency)`);
              }
              markStatus(idx, "skipped", "blocked by failed dependency");
            }
          }
          if (state.every((s) => s === "done" || s === "failed")) {
            resolve();
            return;
          }
          for (const idx of ready) {
            if (active >= effectiveCap) break;
            if (state[idx] !== "pending") continue;
            const reservedStorage = storageByIdx.get(idx);
            const sourceStorage = sourceStorageByIdx.get(idx);
            const scenarioId = planned[idx]!.scenario.id;
            // Worker-occupancy gate: target storage + (for source-isolating
            // upgrade/reconfigure) the source storage too. busyStorages is
            // flat; dedupe when source equals target so we don't double-add.
            const toReserve: string[] = [];
            if (reservedStorage) toReserve.push(reservedStorage);
            if (sourceStorage && sourceStorage !== reservedStorage) toReserve.push(sourceStorage);
            const blocking = toReserve.find((s) => busyStorages.has(s));
            if (blocking) {
              if (!waitLogged.has(idx)) {
                const detail = blocking === reservedStorage
                  ? "(storage busy)"
                  : `(source storage ${blocking} busy)`;
                logWorkerTimeline("wait", reservedStorage, scenarioId, detail);
                waitLogged.add(idx);
              }
              continue;
            }
            for (const s of toReserve) busyStorages.add(s);
            if (waitLogged.has(idx)) {
              logWorkerTimeline("resume", reservedStorage, scenarioId);
              waitLogged.delete(idx);
            }
            logWorkerTimeline("start", reservedStorage, scenarioId,
              `vm=${planned[idx]!.vmId}`);
            // skipExecution=true scenarios (restored from snapshot, or
            // already-matching managed dep CTs) take an early-exit inside
            // runStep — they don't really run. Use a dedicated status so
            // the overview shows "restored" / "skipped" instead of a
            // misleading "running → passed" (which would imply real work).
            const earlyExitStatus: "restored" | "skipped" | undefined =
              planned[idx]!.skipExecution
                ? (planned[idx]!.isDependency ? "restored" : "skipped")
                : undefined;
            if (earlyExitStatus) {
              markStatus(idx, earlyExitStatus, earlyExitStatus === "restored"
                ? "from covering pct snapshot" : "managed CT already running");
            } else {
              markStatus(idx, "running");
            }
            const startTs = Date.now();
            state[idx] = "running";
            active++;
            void runStep(idx)
              .then((outcome) => {
                active--;
                for (const s of toReserve) busyStorages.delete(s);
                const dur = ((Date.now() - startTs) / 1000).toFixed(1);
                if (outcome.type === "crashed") {
                  state[idx] = "failed";
                  logWorkerTimeline("fail", reservedStorage, scenarioId, `${dur}s crashed`);
                  markStatus(idx, "failed", `crashed after ${dur}s`);
                  if (failFast) { crashedErr = outcome.err; aborted = true; }
                } else if (outcome.type === "failed-partition") {
                  state[idx] = "failed";
                  logWorkerTimeline("fail", reservedStorage, scenarioId, `${dur}s failed`);
                  markStatus(idx, "failed", `failed after ${dur}s`);
                  applyFailurePartition(outcome.scenarioId, idx, false);
                  if (failFast) aborted = true;
                } else {
                  state[idx] = "done";
                  logWorkerTimeline("done", reservedStorage, scenarioId, `${dur}s`);
                  // Preserve restored/skipped status set at dispatch — those
                  // are early-exit scenarios that didn't really run. Only
                  // promote to "passed" when actual work happened.
                  if (!earlyExitStatus) markStatus(idx, "passed");
                }
                pump();
              })
              .catch((err) => {
                active--;
                for (const s of toReserve) busyStorages.delete(s);
                const dur = ((Date.now() - startTs) / 1000).toFixed(1);
                logWorkerTimeline("fail", reservedStorage, scenarioId, `${dur}s exception`);
                markStatus(idx, "failed", `exception after ${dur}s`);
                state[idx] = "failed";
                crashedErr = err;
                aborted = true;
                pump();
              });
          }
          if (active === 0 && state.every((s) => s !== "pending")) resolve();
        };
        pump();
      });
      if (crashedErr) throw crashedErr;
    } else {
      // ── Sequential driver (unchanged behaviour) ──────────────────────
      const catalogIdxSeq = new Set<number>();
      planned.forEach((p, i) => {
        if (snapshotCatalog.has(p.scenario.id)) catalogIdxSeq.add(i);
      });
      // Per-scenario terminal state for the catalog-phase gate. Only the
      // "failed" vs "anything else" distinction matters; we collapse
      // passed / skipped / restored into "done" since none of them block
      // downstream consumers in the catalog sense.
      const seqState: ("pending" | "done" | "failed")[] = planned.map(() => "pending");
      let abortedSeq = false;
      for (let i = 0; i < planned.length; i++) {
        if (abortedSeq) {
          // Catalog-phase already failed — mark remaining as skipped.
          if (!planned[i]!.skipExecution) {
            planned[i]!.skipExecution = true;
            result.errors.push(`Skipped: ${planned[i]!.scenario.id} (catalog phase failed)`);
            markStatus(i, "skipped", "catalog phase failed");
          }
          seqState[i] = "done";
          continue;
        }
        // Match the parallel driver: scenarios with skipExecution=true
        // (snapshot-restored or already-running matching) get an explicit
        // restored/skipped status, not "running → passed".
        const earlyExit: "restored" | "skipped" | undefined =
          planned[i]!.skipExecution
            ? (planned[i]!.isDependency ? "restored" : "skipped")
            : undefined;
        if (earlyExit) {
          markStatus(i, earlyExit, earlyExit === "restored"
            ? "from covering pct snapshot" : "managed CT already running");
        } else {
          markStatus(i, "running");
        }
        const outcome = await runStep(i);
        if (outcome.type === "crashed") {
          markStatus(i, "failed", "crashed");
          seqState[i] = "failed";
          if (failFast) throw outcome.err;
        } else if (outcome.type === "failed-partition") {
          markStatus(i, "failed", `failed (cascade from ${outcome.scenarioId})`);
          seqState[i] = "failed";
          applyFailurePartition(outcome.scenarioId, i, true);
        } else {
          if (!earlyExit) markStatus(i, "passed");
          // All three terminal-success states (passed / restored / skipped)
          // collapse to "done" — only "failed" matters for the gate.
          seqState[i] = "done";
        }
        // Catalog-phase fail-fast check, identical semantics to the
        // parallel driver's pump-time gate.
        if (catalogIdxSeq.size > 0 && !abortedSeq) {
          let allTerminal = true;
          let anyFailed = false;
          for (const ci of catalogIdxSeq) {
            const s = seqState[ci];
            if (s === "pending") { allTerminal = false; break; }
            if (s === "failed") anyFailed = true;
          }
          if (allTerminal && anyFailed) {
            const failedNames = [...catalogIdxSeq]
              .filter((ci) => seqState[ci] === "failed")
              .map((ci) => planned[ci]!.scenario.id);
            logFail(`Catalog phase failed (${failedNames.length}/${catalogIdxSeq.size}: ${failedNames.join(", ")}) — aborting remaining scenarios.`);
            abortedSeq = true;
          }
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    // Only tear down the overview when this executor owns its lifecycle.
    // The runner-owned path lets the runner write the final JSON + stop
    // the server after summary printing, so a viewer opened in the last
    // seconds still sees a coherent end state.
    if (ownsOverviewLifecycle) {
      if (overviewJsonTimer) clearInterval(overviewJsonTimer);
      if (overviewState) writeRunOverviewJson(overviewState);
      if (overviewServer) {
        try { await overviewServer.stop(); } catch { /* best-effort */ }
      }
    }
  }

  result.passed = verifier.passed;
  result.failed += verifier.failed;
  return result;
}

/**
 * Phase 1 (`--parallel`): bounded-concurrency variant of
 * {@link executeScenarios}. Same per-scenario unit of work (shared
 * `runStep`), only the driver differs. The deployer/API and the single
 * nested VM are untouched; the gain is overlapping idle waits.
 */
export async function executeScenariosParallel(
  planned: PlannedScenario[],
  config: Parameters<typeof executeScenarios>[1],
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
  allTests: Map<string, ResolvedScenario>,
  stackIdMap: Map<string, string[]>,
  resultWriter?: TestResultWriter,
  fixtureBaseDir?: string,
  options?: ExecuteScenariosOptions,
): Promise<TestResult> {
  return executeScenarios(
    planned, config, apiUrl, veHost, projectRoot, appMetaMap, allTests,
    stackIdMap, resultWriter, fixtureBaseDir,
    { ...(options ?? {}), concurrency: Math.max(2, options?.concurrency ?? 4) },
  );
}
