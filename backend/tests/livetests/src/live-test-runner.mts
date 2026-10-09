#!/usr/bin/env tsx
/**
 * TypeScript Live Integration Test Runner for Proxvex.
 *
 * Creates real containers on a Proxmox host via the CLI tool and verifies
 * application-level functionality including dependencies and docker services.
 *
 * Test definitions live in json/applications/<app>/tests/test.json.
 * Each scenario tests one application. Dependencies are declared via depends_on.
 *
 * Features:
 * - Pre-assigned VM IDs (200+) to avoid parallel conflicts
 * - Dependency-aware execution with topological sort
 * - Per-scenario params with set, append, and file: modes
 * - Comprehensive verification suite (container, notes, services, TLS, SSL)
 *
 * Usage:
 *   tsx live-test-runner.mts [instance] [test-name|--all] [--queue] [--fixtures] [--deps-only]
 *
 * Examples:
 *   tsx live-test-runner.mts github-action postgres/ssl
 *   tsx live-test-runner.mts github-action zitadel        # runs all zitadel/* + deps
 *   tsx live-test-runner.mts github-action --all
 *   tsx live-test-runner.mts github-action --queue         # parallel queue worker mode
 *   tsx live-test-runner.mts yellow proxvex/playwright-oidc --deps-only
 *                                                          # install deps + snapshot, skip target
 *   KEEP_VM=1 tsx live-test-runner.mts github-action zitadel/ssl
 */

import { nestedSsh, nestedSshStrict, withZfsCloneRelease } from "./ssh-helpers.mjs";
import {
  collectWithDeps, selectScenarios, planScenarios, applyTagFilter,
  classifyRunMode, loadSnapshotCatalog, loadScenarioListFromFile,
  expandToPriorityClosure, addImplicitDestructiveTaskDeps,
} from "./scenario-planner.mjs";
import { TestResultWriter } from "./test-result-writer.mjs";
import type { RunnerAuthContext } from "./runner-http.mjs";
import { renderResultsMarkdown } from "./result-summary.mjs";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario, E2EConfig, ParamEntry, RunMode } from "./livetest-types.mjs";
import { resolveDepSnapshotName } from "./livetest-types.mjs";
import { apiFetch, type AppMeta } from "./verifier.mjs";
import { runCleanupSql, destroyStaleVms, ensureStacks } from "./stack-manager.mjs";
import {
  restoreBestSnapshot, prepareVms, smartCleanupBeforeRun, rollbackToBaseline,
  preCleanupNonSnapshotConsumers, rollbackOrDestroyDepsFromSnapshot,
} from "./vm-lifecycle.mjs";
import { executeScenarios } from "./scenario-executor.mjs";
import { writeRunOverviewHtml, writeRunOverviewJson, type RunOverviewState, type ScenarioStatus } from "./run-overview.mjs";
import { overviewPortForDeployer, startRunOverviewServer, type RunOverviewServer } from "./run-overview-server.mjs";
import { cleanupOldRuns, writeRunsIndex } from "./runs-index.mjs";
import { RED, GREEN, NC, logOk, logFail, logWarn, logInfo } from "./log-helpers.mjs";
import { analyzeCoverage } from "./coverage-analyzer.mjs";
import { renderMarkdown as renderCoverageMarkdown, renderJson as renderCoverageJson } from "./coverage-report.mjs";
import { buildAdHocFilter, buildFilter, loadTestSets, resolvePreset, type ResolvedFilter } from "./test-set-registry.mjs";

// Re-export types so existing imports from this module continue to work
export type { TestScenario, ResolvedScenario, PlannedScenario, StepResult, TestResult, E2EConfig, ParamEntry } from "./livetest-types.mjs";
export { resolveDepSnapshotName } from "./livetest-types.mjs";
export { collectWithDeps, selectScenarios, buildParams, planScenarios, partitionAfterFailure, type BuildParamsResult } from "./scenario-planner.mjs";
export { runCli, type CliJsonResult, type CliMessage } from "./cli-executor.mjs";

// ── Pure functions (exported for unit testing) ──

/**
 * Fetch all test scenarios from the deployer API.
 * Replaces the old filesystem-based discoverTests().
 */
export async function fetchTestScenarios(apiUrl: string): Promise<Map<string, ResolvedScenario>> {
  const resp = await fetch(`${apiUrl}/api/test-scenarios`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch test scenarios: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json() as { scenarios: Array<ResolvedScenario & { params?: ParamEntry[] }> };

  const all = new Map<string, ResolvedScenario>();
  for (const s of data.scenarios) {
    all.set(s.id, s);
  }
  return all;
}

// ── Configuration ──

function loadConfig(instanceName?: string): {
  instance: string;
  pveHost: string;
  portPveSsh: number;
  pveWebUrl: string;
  deployerUrl: string;
  deployerHttpsUrl: string;
  bridge: string;
  veHost: string;
  veSshPort: number;
  /** True when deployerHost/deployerPort are not configured — the test
   *  runner talks directly to the Hub-LXC inside the nested VM (via
   *  pveHost port-forward) rather than a local Spoke. Set per call. */
  inNestedDeployerMode: boolean;
  vmId: number;
  snapshot?: { enabled: boolean };
  registryMirror?: { dnsForwarder: string };
  portForwarding: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
  nestedVmIp: string;
  zitadelPat?: string;
} {
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");
  const configPath = path.join(projectRoot, "e2e/config.json");
  const config: E2EConfig = JSON.parse(readFileSync(configPath, "utf-8"));

  const instance = instanceName || config.default;
  const inst = config.instances[instance];
  if (!inst) {
    console.error(`Instance '${instance}' not found. Available: ${Object.keys(config.instances).join(", ")}`);
    process.exit(1);
  }

  // Resolve ${VAR:-default} and ${VAR} in config values. The default may
  // be any hostname-like string (alphanumerics, dots, dashes), not just
  // a single word — so we can fall back to e.g. "pve-e2e-nested.local".
  const resolveEnv = (val: string) =>
    val
      .replace(/\$\{(\w+):-([^}]+)\}/g, (_, varName, defaultVal) => process.env[varName] || defaultVal)
      .replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || "");

  const pveHost = resolveEnv(inst.pveHost);

  const offset = inst.portOffset;
  const portPveSsh = config.ports.pveSsh + offset;
  const pveWebUrl = `https://${pveHost}:${config.ports.pveWeb + offset}`;

  // Allow explicit deployer host/port override (for dev environments)
  let deployerUrl: string;
  let deployerHttpsUrl: string;
  if (inst.deployerHost && inst.deployerPort) {
    const deployerHost = resolveEnv(inst.deployerHost);
    const deployerPort = resolveEnv(inst.deployerPort);
    deployerUrl = `http://${deployerHost}:${deployerPort}`;
    deployerHttpsUrl = `https://${deployerHost}:${deployerPort}`;
  } else {
    const portDeployer = config.ports.deployer + offset;
    const portDeployerHttps = config.ports.deployerHttps + offset;
    deployerUrl = `http://${pveHost}:${portDeployer}`;
    deployerHttpsUrl = `https://${pveHost}:${portDeployerHttps}`;
  }

  // veHost/veSshPort: how the deployer reaches the PVE host for
  // execute_on:ve scripts. The reachable host depends on where the
  // deployer runs:
  //
  // - Spoke mode (deployerHost+Port set, e.g. localhost:3201): deployer
  //   is a local Node process on the dev machine. SSH from dev host to
  //   `pveHost:portPveSsh` (e.g. ubuntupve:1022, the outer SSH port-
  //   forward). This is the default.
  //
  // - Nested-deployer mode (deployerHost/deployerPort omitted, livetest.md
  //   step 2a strips them): deployer is the Hub-LXC inside the nested
  //   VM. `ubuntupve:1022` is NOT reachable from the Hub-LXC. The Hub
  //   reaches its own PVE host via the bridge gateway — `pve-e2e-
  //   nested.local:22` (resolved to 10.0.0.1 via dnsmasq expand-hosts
  //   on vmbr1).
  //
  // The instance can override with `veHost`/`veSshPort` (e.g. github-
  // action uses "10.0.0.1":22 because it only ever runs in nested-
  // deployer mode in CI).
  const inNestedDeployerMode = !inst.deployerHost && !inst.deployerPort;
  const veHost = inst.veHost
    ? resolveEnv(inst.veHost)
    : inNestedDeployerMode
      ? "pve-e2e-nested.local"
      : pveHost;
  const veSshPort = inst.veSshPort ?? (inNestedDeployerMode ? 22 : portPveSsh);

  // Snapshot config (for VM-level snapshots)
  const snapshot = inst.snapshot?.enabled ? { enabled: true } : undefined;

  // Registry mirror config
  const registryMirror = inst.registryMirror?.dnsForwarder
    ? { dnsForwarder: inst.registryMirror.dnsForwarder }
    : undefined;

  // Port forwarding config (for accessing containers from outside the nested VM)
  const portForwarding = inst.portForwarding ?? [];

  // Optional Zitadel PAT — UI-generated for a service user with sufficient
  // org permissions. Resolved like other strings (env var interpolation).
  const zitadelPat = inst.zitadelPat ? resolveEnv(inst.zitadelPat) : undefined;

  // exactOptionalPropertyTypes treats `T | undefined` differently from `T?` —
  // optional fields must be OMITTED when absent, not assigned `undefined`. Hence
  // the conditional spreads for snapshot/registryMirror/zitadelPat.
  return {
    instance,
    pveHost,
    portPveSsh,
    pveWebUrl,
    deployerUrl,
    deployerHttpsUrl,
    // `inst.bridge` is the OUTER bridge attaching the nested VM to the host.
    // Test LXC containers live *inside* the nested VM and need the inner bridge
    // (always `vmbr1` per step1's nested-PVE setup). Config can override via
    // `lxcBridge` for unusual setups.
    bridge: inst.lxcBridge || "vmbr1",
    veHost,
    veSshPort,
    inNestedDeployerMode,
    vmId: inst.vmId,
    ...(snapshot ? { snapshot } : {}),
    ...(registryMirror ? { registryMirror } : {}),
    portForwarding,
    // Nested VM static IP (always .10 in step1's subnet allocation). Used by
    // outer-host iptables DNAT rules so port-forwards reach the right nested VM.
    nestedVmIp: `${inst.subnet}.10`,
    ...(zitadelPat ? { zitadelPat } : {}),
  };
}

/**
 * Enumerate rootdir-capable storages on the PVE host that can be used to
 * spread parallel-livetest scenarios across separate lock domains. Includes
 * `zfspool` (separate ZFS datasets → separate dataset locks) AND `dir`
 * (separate filesystem directories → separate FS locks), so the same
 * parallelization win is available on ext4/xfs nested VMs (github-action
 * instance) without requiring ZFS. Other rootdir-capable types (lvm,
 * lvmthin) are excluded — they share VG locks and the runner has no
 * snapshot story for them.
 *
 * Returns storage names in `pvesm status` order, or `[]` when SSH fails or
 * no eligible storage exists. Empty list → callers leave `volume_storage`
 * unset, default from `parameter-definitions.json` kicks in.
 */
export function enumerateParallelStorages(
  pveHost: string,
  sshPort: number,
): string[] {
  try {
    const raw = nestedSshStrict(pveHost, sshPort,
      "pvesm status --content rootdir 2>/dev/null | tail -n +2", 10000);
    return raw.trim().split("\n")
      .map((line) => {
        const [name, type] = line.trim().split(/\s+/);
        return { name: name || "", type: type || "" };
      })
      .filter((s) => s.name && (s.type === "zfspool" || s.type === "dir"))
      .map((s) => s.name);
  } catch {
    return [];
  }
}

async function discoverApiUrl(httpUrl: string, httpsUrl: string): Promise<string> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  try {
    const resp = await fetch(`${httpsUrl}/`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok || resp.status < 500) return httpsUrl;
  } catch { /* try HTTP */ }

  try {
    const resp = await fetch(`${httpUrl}/api/sshconfigs`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return httpUrl;
  } catch { /* fail */ }

  throw new Error(`Deployer not reachable at ${httpsUrl} or ${httpUrl}`);
}

// ── CLI execution (extracted to cli-executor.mts) ──

// ── Port forwarding ──

/**
 * (Re)apply iptables DNAT + dnsmasq DHCP-host entries for every container
 * declared in `config.portForwarding`. Idempotent: each rule is checked with
 * `iptables -C` before being added. Safe to call multiple times — typically:
 * once at runner startup, and again after `restoreBestSnapshot` since
 * `qm rollback` wipes the nested-VM iptables + dnsmasq state.
 *
 * Outer-host rules (DNAT on the PVE host itself) survive snapshot rollback
 * but are re-checked anyway so this stays the single source of truth.
 */
/**
 * Static IP of the Hub-LXC inside the nested VM (set by install-proxvex.sh in
 * step2b). Any portForwarding entry pointing at this IP would race with the
 * Hub's static IP allocation — the test container would steal the IP via
 * dhcp-host and the Spoke would unknowingly talk to the test target instead
 * of the Hub.
 */
const HUB_LXC_STATIC_IP = "10.0.0.100";

export function setupPortForwarding(config: {
  pveHost: string;
  portPveSsh: number;
  portForwarding: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
  nestedVmIp: string;
}): void {
  if (config.portForwarding.length === 0) return;
  // Refuse any entry that collides with the Hub-LXC's static IP. dnsmasq
  // would then issue 10.0.0.100 to the test container, ARP would resolve
  // to that container, and the Hub becomes unreachable — symptom: spurious
  // HTTP→HTTPS redirects from a *test* proxvex (with addon-ssl) instead of
  // the Hub's plain HTTP.
  const conflicts = config.portForwarding.filter((f) => f.ip === HUB_LXC_STATIC_IP);
  if (conflicts.length > 0) {
    const detail = conflicts.map((f) => `${f.hostname}:${f.port}`).join(", ");
    throw new Error(
      `portForwarding IP ${HUB_LXC_STATIC_IP} is reserved for the Hub-LXC — `
      + `remove the colliding entries from e2e/config.json (${detail}). `
      + `Tests that need external access from the laptop should not use this IP; `
      + `tests that only need internal access via the remote Playwright browser `
      + `do not need a portForwarding entry at all.`,
    );
  }
  try {
    for (const fwd of config.portForwarding) {
      // a) dnsmasq static DHCP lease on nested VM.
      //
      // Two parts:
      //   1. The `dhcp-host=<hostname>,<ip>` directive must be present in
      //      /etc/dnsmasq.d/e2e-nat.conf so dnsmasq pins that hostname to
      //      the configured IP on the next DHCPDISCOVER.
      //   2. Any *existing* lease on the same IP (held by a previous
      //      container's MAC after a destroy+recreate cycle) blocks the
      //      pin: dnsmasq logs `not using configured address <ip> because
      //      it is leased to <stale-mac>` and the new container falls
      //      back to a random pool IP. Drop the stale lease + reload
      //      dnsmasq before reinstalling the hostname entry so the next
      //      DHCPDISCOVER actually lands on the configured IP.
      nestedSsh(config.pveHost, config.portPveSsh,
        `sed -i '/[[:space:]]${fwd.ip}[[:space:]]/d; / ${fwd.hostname} /d' ` +
        `/var/lib/misc/dnsmasq.leases 2>/dev/null || true`,
        5000);
      const dhcpCheck = nestedSsh(config.pveHost, config.portPveSsh,
        `grep -q 'dhcp-host=${fwd.hostname}' /etc/dnsmasq.d/e2e-nat.conf 2>/dev/null && echo "exists" || echo "missing"`,
        5000);
      if (dhcpCheck.trim() === "missing") {
        nestedSsh(config.pveHost, config.portPveSsh,
          `echo "dhcp-host=${fwd.hostname},${fwd.ip}" >> /etc/dnsmasq.d/e2e-nat.conf`,
          5000);
      }
      // Reload dnsmasq so the lease wipe + any new dhcp-host entry takes
      // effect for the next DHCPDISCOVER from this hostname. systemctl
      // reload is enough — dnsmasq re-reads /etc/dnsmasq.d/*.conf and
      // /var/lib/misc/dnsmasq.leases without dropping in-flight clients.
      nestedSsh(config.pveHost, config.portPveSsh,
        `systemctl reload dnsmasq 2>/dev/null || systemctl restart dnsmasq`,
        5000);

      // b) iptables DNAT on nested VM (inner forwarding).
      //
      // Same cleanup pattern as the outer step (c) below: drop EVERY
      // existing rule for this --dport before installing ours. The old
      // approach was a `-C` exact-match check + `-A` on miss, which left
      // stale rules with a different `containerPort` in place (e.g.
      // after changing zitadel's containerPort from the SSL :1443 to the
      // plain-HTTP :8080 — the old :1443 rule kept winning iptables'
      // first-match ordering and routed traffic to a dead inner port).
      nestedSsh(config.pveHost, config.portPveSsh,
        `iptables -t nat -S PREROUTING | awk '/--dport ${fwd.port} / && /DNAT/ { sub(/^-A/, "-D"); print }' | ` +
        `while IFS= read -r rule; do [ -n "$rule" ] && iptables -t nat $rule; done; ` +
        `iptables -t nat -A PREROUTING -p tcp --dport ${fwd.port} -j DNAT --to-destination ${fwd.ip}:${fwd.containerPort}; ` +
        `iptables -C FORWARD -p tcp -d ${fwd.ip} --dport ${fwd.containerPort} -j ACCEPT 2>/dev/null || iptables -A FORWARD -p tcp -d ${fwd.ip} --dport ${fwd.containerPort} -j ACCEPT`,
        5000);

      // c) iptables DNAT on outer PVE host. Forwards external port to nested
      // VM which then forwards to container. The nested-VM IP comes from
      // `${instance.subnet}.10` (step1 always allocates .10 to the nested VM).
      //
      // Important: another instance (green vs yellow) may have left a DNAT
      // rule pointing at *its* nested VM IP for the same port. iptables
      // PREROUTING is order-first-match, so a stale green rule (10.99.1.10)
      // would steal traffic meant for yellow (10.99.3.10). Delete every
      // existing rule for this --dport before installing ours.
      try {
        // Convert every matching `-A PREROUTING ... --dport <p> ... DNAT ...`
        // line into a `-D` and replay it, then install the canonical rule.
        // iptables -D requires the full rule-spec to match, so we cannot do a
        // partial delete-while-loop — awk-rewriting the -S output is the
        // simplest way to drop any rule for this port regardless of target.
        nestedSsh(config.pveHost, 22,
          `iptables -t nat -S PREROUTING | awk '/--dport ${fwd.port} / && /DNAT/ { sub(/^-A/, "-D"); print }' | ` +
          `while IFS= read -r rule; do [ -n "$rule" ] && iptables -t nat $rule; done; ` +
          `iptables -t nat -A PREROUTING -p tcp --dport ${fwd.port} -j DNAT --to-destination ${config.nestedVmIp}:${fwd.port}; ` +
          `iptables -C FORWARD -p tcp -d ${config.nestedVmIp} --dport ${fwd.port} -j ACCEPT 2>/dev/null || iptables -A FORWARD -p tcp -d ${config.nestedVmIp} --dport ${fwd.port} -j ACCEPT`,
          10000);
      } catch {
        // Outer host may not be directly accessible via SSH port 22
      }

      logOk(`Port forwarding: ${fwd.hostname} (${fwd.ip}:${fwd.containerPort}) -> external port ${fwd.port}`);
    }

    // Restart dnsmasq to apply DHCP changes
    nestedSsh(config.pveHost, config.portPveSsh, `systemctl restart dnsmasq`, 10000);
  } catch {
    logInfo("Warning: Could not configure port forwarding (non-fatal)");
  }
}

// ── Cleanup ──

function cleanupVms(
  planned: PlannedScenario[],
  pveHost: string,
  sshPort: number,
  keepVm: boolean,
  snapshotCatalog: ReadonlySet<string>,
) {
  for (const p of [...planned].reverse()) {
    if (p.isDependency) {
      logWarn(`Keeping dependency VM ${p.vmId} (${p.scenario.id})`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else if (p.scenario.expect_clone_lifecycle) {
      // Self-upgrade test: the scenario VM IS the new deployer-CT after
      // the replace took over the original Hub's hostname/IP. Destroying
      // it leaves green with no deployer until step2b reinstalls. Always
      // preserve.
      logWarn(`Keeping deployer-replacement VM ${p.vmId} (${p.scenario.id}, expect_clone_lifecycle)`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else if (snapshotCatalog.has(p.scenario.id)) {
      // Catalog members own pct snapshots created by the per-member-snapshot
      // path in scenario-executor; destroying the CT here would wipe that
      // snapshot. Keep the CT running so the next `--from-snapshot` run can
      // roll it back instead of reinstalling.
      logWarn(`Keeping snapshot-catalog member VM ${p.vmId} (${p.scenario.id})`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else if (keepVm) {
      logWarn(`KEEP_VM set - VM ${p.vmId} not destroyed`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else {
      logInfo(`Cleaning up VM ${p.vmId}...`);
      nestedSsh(pveHost, sshPort,
        `pct stop ${p.vmId} 2>/dev/null || true; ${withZfsCloneRelease(p.vmId, `pct destroy ${p.vmId} --force --purge 2>/dev/null`)} || true`,
        30000,
      );
    }
  }
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const fixturesFlag = args.includes("--fixtures");
  const queueFlag = args.includes("--queue");
  const failFastFlag = args.includes("--fail-fast");
  const includeUntestable = args.includes("--include-untestable");
  const depsOnlyFlag = args.includes("--deps-only");

  // Schritt 3b: `--snapshot <name>` build mode. Listed scenarios are
  // installed as a normal livetest (full debug bundle, bootstrap diagnosis)
  // and at the end of each iteration their CTs are pct-snapshotted with
  // `<name>` (selbstbeschreibende description). Sole writer of dep
  // snapshots; regular livetest runs only restore them.
  const snapshotIdx = args.indexOf("--snapshot");
  let snapshotMode: string | null = null;
  if (snapshotIdx >= 0) {
    const next = args[snapshotIdx + 1];
    if (!next || next.startsWith("--")) {
      console.error("--snapshot requires a name, e.g. `--snapshot oidc-base \"postgres/default,zitadel/default\"`.");
      process.exit(2);
    }
    snapshotMode = next;
    // Remove the flag + its value so the positional parser doesn't see them.
    args.splice(snapshotIdx, 2);
  }

  // Phase 1 (opt-in for single scenarios, default-on for `--all`/`@file`):
  // `--parallel` or `--parallel=N` switches the scenario loop to a bounded
  // async scheduler. Without the flag the runner takes the unchanged
  // sequential path → near-zero regression risk for single-scenario runs.
  //
  // `--no-parallel` forces serial even when a default-on mode would otherwise
  // enable it. `--parallel=1` is also accepted and treated as serial.
  const parallelArg = args.find(
    (a) => a === "--parallel" || a.startsWith("--parallel="),
  );
  const noParallelIdx = args.indexOf("--no-parallel");
  if (noParallelIdx >= 0) args.splice(noParallelIdx, 1);
  const explicitParallel = !!parallelArg;
  const explicitNoParallel = noParallelIdx >= 0;
  let parallelLimit = 4;
  if (parallelArg && parallelArg.includes("=")) {
    const n = Number.parseInt(parallelArg.split("=")[1] ?? "", 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(
        `Invalid --parallel value "${parallelArg.split("=")[1]}". Expected a positive integer.`,
      );
      process.exit(2);
    }
    parallelLimit = n;
  }

  // `--from-snapshot`: single-scenario mode → roll back transitive dep CTs
  // from their pct snapshots before the test (and destroy any dep CT that
  // does not have a snapshot, so prepareVms reinstalls it fresh).
  const fromSnapshotIdx = args.indexOf("--from-snapshot");
  const fromSnapshot = fromSnapshotIdx >= 0;
  if (fromSnapshot) args.splice(fromSnapshotIdx, 1);

  // `--reuse-running`: skip the @file-mode pre-cleanup (smartCleanup +
  // restoreBestSnapshot). Scenarios run against whatever CTs are currently
  // alive — intended for iterating on a curated list of just-failed tests
  // (`/livetest --reuse-running @failed.lst`) without paying the rollback
  // cost when the deps are already in a known-good state from a prior run.
  const reuseRunningIdx = args.indexOf("--reuse-running");
  const reuseRunning = reuseRunningIdx >= 0;
  if (reuseRunning) args.splice(reuseRunningIdx, 1);

  // Coverage-report short-circuits before any deployer interaction.
  if (args.includes("--coverage-report")) {
    const formatIdx = args.indexOf("--format");
    const format = formatIdx >= 0 && args[formatIdx + 1] === "json" ? "json" : "markdown";
    const gapsOnly = args.includes("--gaps-only");
    const projectRoot = path.resolve(import.meta.dirname, "../../../..");
    const report = analyzeCoverage(projectRoot);
    const out = format === "json" ? renderCoverageJson(report) : renderCoverageMarkdown(report, gapsOnly);
    process.stdout.write(out);
    if (!out.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  // Extract value-taking flags (must come before positional consumption).
  const setName = popValueFlag(args, "--set");
  const tagFlags = popAllValueFlags(args, "--tag");
  const tagsFlag = popValueFlag(args, "--tags");
  const excludeTagFlags = popAllValueFlags(args, "--exclude-tag");
  // --debug [off|extLog|script] — sets `debug_level` param on every scenario,
  // which switches on per-task debug bundle collection in the backend. The
  // resulting bundle is fetched by the TestResultWriter into livetest-results.
  let debugLevel = popValueFlag(args, "--debug");
  if (debugLevel && !["off", "extLog", "script"].includes(debugLevel)) {
    console.error(
      `Invalid --debug value "${debugLevel}". Expected: off | extLog | script`,
    );
    process.exit(2);
  }
  // Default to extLog when livetest is run without --debug, so livetest-results
  // always carry a debug bundle. Suppress with --debug off.
  if (!debugLevel) debugLevel = "extLog";

  // --volume-storage <name>: pin every scenario in this run to one zfspool
  // storage. step3 uses this to spread cluster-builds across local-zfs/2/3/4
  // (one cluster per storage → all CTs of one cluster on the same pool, so
  // `pct clone`/`pct rollback` inside the chain stays ZFS-CoW-fast and the
  // distribution across clusters keeps parallel snapshot-restores lock-free).
  // Without the flag, scenarios pick their storage hierarchically:
  //   1. dependency inheritance (same storage as existing dep CT) → CoW
  //   2. round-robin by index → spread cluster-roots evenly
  const volumeStorageOverride = popValueFlag(args, "--volume-storage");

  // --cli-timeout N: override the per-scenario CLI timeout (default 600s in
  // cli-executor.runCli). Useful when parallel runs push per-scenario duration
  // past the default (apk install / image pull contention inside the nested
  // VM). Per-scenario `cli_timeout` from test.json takes precedence; this
  // flag only sets the fallback for scenarios that don't specify one.
  const cliTimeoutOverride = popValueFlag(args, "--cli-timeout");
  let cliTimeoutSec: number | undefined;
  if (cliTimeoutOverride !== undefined) {
    const n = Number.parseInt(cliTimeoutOverride, 10);
    if (!Number.isFinite(n) || n < 30) {
      console.error(`Invalid --cli-timeout "${cliTimeoutOverride}". Expected a positive integer (seconds, >= 30).`);
      process.exit(2);
    }
    cliTimeoutSec = n;
  }

  const positionalArgs = args.filter((a, i, arr) =>
    a !== "--fixtures" &&
    a !== "--queue" &&
    a !== "--fail-fast" &&
    a !== "--include-untestable" &&
    a !== "--coverage-report" &&
    a !== "--gaps-only" &&
    a !== "--deps-only" &&
    !a.startsWith("--parallel") &&
    !(arr[i - 1] === "--format")
  );
  const instance = positionalArgs[0] || undefined;
  let testArg = positionalArgs[1] || "--all";

  // `@<file>` scenario list: expand into a comma-separated list and treat
  // semantically like a `--all`-scoped run (qm rollback + parallel default +
  // catalog snapshots after success). The expansion happens BEFORE
  // classifyRunMode so selectScenarios can consume the resulting comma list
  // unchanged; the run mode is captured separately for downstream gating.
  const projectRootForListFile = path.resolve(import.meta.dirname, "../../../..");
  const runMode: RunMode = classifyRunMode(testArg, snapshotMode);
  if (runMode === "file") {
    const filePathArg = testArg.slice(1);
    const filePath = path.isAbsolute(filePathArg)
      ? filePathArg
      : path.resolve(projectRootForListFile, filePathArg);
    try {
      testArg = loadScenarioListFromFile(filePath);
      logInfo(`@file: loaded ${testArg.split(",").length} scenario(s) from ${filePath}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }

  // Snapshot catalog: which scenarios get a (re-)snapshot after a successful
  // test. Read once here so all downstream gates see the same set. Missing
  // file → empty set, no snapshots created (operator can add it later).
  const snapshotCatalog = loadSnapshotCatalog(projectRootForListFile);
  if (snapshotCatalog.size > 0) {
    logInfo(`Snapshot catalog: ${snapshotCatalog.size} member(s) — ${[...snapshotCatalog].join(", ")}`);
  } else if (runMode === "all" || runMode === "file") {
    logWarn("Snapshot catalog is empty (e2e/snapshot-catalog.json missing or empty) — no snapshots will be created during this run");
  }

  // Parallel default decision: opt-in for single, default-on for all/file.
  // `--no-parallel` and `--parallel=1` both force serial. `snapshot-build`
  // mode is always serial (unchanged Phase-3b semantics).
  const parallelDefaultedOn = (runMode === "all" || runMode === "file");
  const parallelEnabled =
    runMode === "snapshot-build"
      ? false
      : explicitParallel
        ? parallelLimit > 1
        : (parallelDefaultedOn && !explicitNoParallel);
  if (runMode === "single" && fromSnapshot && parallelEnabled) {
    logWarn("--from-snapshot is a single-scenario flag; parallelism is ignored");
  }

  const config = loadConfig(instance);
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");

  // Resolve --set / --tag / --exclude-tag into a single filter spec.
  // --set takes precedence; ad-hoc flags are layered on top via intersection.
  let filter: ResolvedFilter | null = null;
  if (setName) {
    const testSetsPath = path.join(projectRoot, "e2e", "test-sets.json");
    const testSets = loadTestSets(testSetsPath);
    const preset = resolvePreset(setName, testSets);
    filter = buildFilter(preset);
    logInfo(`Preset: ${setName}${preset.description ? ` — ${preset.description}` : ""}`);
  }
  const includeTags = [...tagFlags, ...(tagsFlag ? tagsFlag.split(",").map((t) => t.trim()).filter(Boolean) : [])];
  if (includeTags.length > 0 || excludeTagFlags.length > 0) {
    const adHoc = buildAdHocFilter({ includeTags, excludeTags: excludeTagFlags });
    if (filter) {
      const presetFilter = filter;
      filter = {
        matches: (id, tags) => presetFilter.matches(id, tags) && adHoc.matches(id, tags),
      };
    } else {
      filter = adHoc;
    }
  }

  console.log("========================================");
  console.log(" Proxvex - Live Integration Test");
  console.log("========================================");
  console.log("");
  console.log(`Instance:  ${config.instance}`);
  console.log(`Test:      ${testArg}`);
  console.log(`Deployer:  ${config.deployerUrl} (HTTPS: ${config.deployerHttpsUrl})`);
  console.log(`PVE Host:  ${config.pveHost}:${config.portPveSsh}`);
  console.log(`VE Host:   ${config.veHost}:${config.veSshPort}`);
  console.log(`PVE Web:   ${config.pveWebUrl}`);
  console.log(`SSH:       ssh -p ${config.portPveSsh} root@${config.pveHost}`);
  console.log("");

  // Prerequisites
  logInfo("Checking prerequisites...");

  const tsSource = path.join(projectRoot, "cli/src/oci-lxc-cli.mts");
  const cliPath = path.join(projectRoot, "cli/dist/cli/src/oci-lxc-cli.mjs");
  if (existsSync(tsSource)) {
    logOk("CLI TypeScript source found (dev mode — using tsx)");
  } else if (existsSync(cliPath)) {
    logOk("CLI is built");
  } else {
    logFail(`CLI not found. Run: cd ${projectRoot} && pnpm run build`);
    process.exit(1);
  }

  // Discover API URL
  let apiUrl: string;
  try {
    apiUrl = await discoverApiUrl(config.deployerUrl, config.deployerHttpsUrl);
    logOk(`Deployer API reachable at ${apiUrl}`);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  // Pre-flight: ensure the running spoke matches the on-disk build. The spoke
  // is a long-lived background process and `/api/reload` only refreshes config,
  // not loaded JSON schemas — so a code/schema change made after the spoke
  // started leaves it serving stale validators. Compare gitHash; on mismatch,
  // restart via start-livetest-deployer.sh and rediscover the URL.
  //
  // Skipped in nested-deployer mode: the apiUrl points at the Hub-LXC inside
  // the nested VM (refreshed by step2b), not a local Spoke. The build-match
  // check would compare against a Spoke gitHash that's irrelevant here and
  // its restart path needs DEPLOYER_PORT which isn't set in this mode.
  if (!config.inNestedDeployerMode) {
    apiUrl = await ensureSpokeMatchesBuild(apiUrl, config, projectRoot);
  } else {
    logInfo("Nested-deployer mode: skipping Spoke build-match check (Hub-LXC refreshed via step2b)");
  }

  // Ensure VE host SSH config exists on the deployer
  const veHost = config.veHost;
  const deploySshPort = config.veSshPort;
  const veConfigResp = await apiFetch<{ key: string }>(apiUrl, `/api/ssh/config/${encodeURIComponent(veHost)}`);
  if (veConfigResp?.key) {
    logOk(`VE host '${veHost}' already configured on deployer`);
  } else {
    logInfo(`VE host '${veHost}' not found on deployer, creating SSH config...`);
    try {
      const resp = await fetch(`${apiUrl}/api/sshconfig`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: veHost, port: deploySshPort, current: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "unknown" }));
        throw new Error(`${resp.status}: ${(err as any).error}`);
      }
      logOk(`VE host '${veHost}' created (port ${deploySshPort}, set as current)`);
    } catch (err: any) {
      logFail(`Failed to create SSH config for '${veHost}': ${err.message}`);
      process.exit(1);
    }
  }

  // Set up OCI version cache on PVE host (prevents skopeo calls during tests)
  try {
    const ociCache = JSON.stringify({
      _meta: { mode: "test" },
      versions: {
        "postgres:latest": "17.5",
        "postgrest/postgrest:latest": "14.7",
        "eclipse-mosquitto:2": "2",
      },
      inspect: {},
      tags: {},
    });
    nestedSsh(config.pveHost, config.portPveSsh,
      `cat > /tmp/.oci-version-cache.json << 'EOFCACHE'\n${ociCache}\nEOFCACHE`,
      10000);
    logOk("OCI version cache written (test mode)");
  } catch {
    logInfo("Warning: Could not write OCI version cache (non-fatal)");
  }

  // Registry mirror DNS + skopeo insecure config are baked into the
  // `mirrors-ready` snapshot by step2a-setup-mirrors.sh, so they survive
  // `qm rollback`. Previously these were added at runner startup, which
  // worked once but every snapshot rollback wiped them — silent regression
  // surfaced as `unexpected EOF` on traefik:v3.6 pull (docker.io traffic
  // routed to a non-existent mirror). If you need to re-add them at run
  // time on a host that pre-dates this change, run
  // `./e2e/step2a-setup-mirrors.sh <instance>` once (idempotent, fenced
  // replace of the BEGIN/END block in /etc/dnsmasq.d/e2e-nat.conf).
  if (config.registryMirror) {
    const fwd = config.registryMirror.dnsForwarder;
    logInfo(`dnsmasq + skopeo mirror config baked into mirrors-ready snapshot (dnsForwarder=${fwd})`);
  }

  // Set up port forwarding for containers that need external access (e.g. Zitadel for OIDC).
  // Called BOTH before scenarios run AND after snapshot rollback in restoreBestSnapshot,
  // because qm rollback wipes the nested-VM iptables + dnsmasq state. Outer-host rules
  // (set via `nestedSsh(pveHost, 22, ...)`) survive rollback and are kept idempotent.
  setupPortForwarding(config);

  // Fetch application metadata (stacktypes, extends, tags)
  const appStacktypes = new Map<string, string | string[]>();
  const appMetaMap = new Map<string, AppMeta>();
  const apps = await apiFetch<Array<{ id: string; stacktype?: string | string[]; extends?: string; framework?: string; tags?: string[]; verification?: AppMeta["verification"] }>>(apiUrl, "/api/applications");
  if (apps) {
    for (const app of apps) {
      if (app.stacktype) appStacktypes.set(app.id, app.stacktype);
      appMetaMap.set(app.id, {
        extends: app.extends,
        framework: app.framework,
        stacktype: app.stacktype,
        tags: app.tags,
        verification: app.verification,
      });
    }
  }

  // Queue worker mode — delegate all scenario management to the queue API
  if (queueFlag) {
    const { runQueueWorker: runQueue } = await import("./queue-worker.mjs");
    await runQueue(config, apiUrl, veHost, projectRoot, appMetaMap, enumerateParallelStorages);
    return;
  }

  // Discover tests via API
  const allTests = await fetchTestScenarios(apiUrl);
  logOk(`Discovered ${allTests.size} test scenario(s)`);

  // Enrich scenarios with computed tags from the static coverage analyzer.
  // The analyzer reads json/applications directly — same source the deployer
  // serves from — so tags reflect the on-disk reality.
  try {
    const coverage = analyzeCoverage(projectRoot);
    for (const [id, tags] of coverage.computedTags) {
      const scenario = allTests.get(id);
      if (scenario) scenario.computedTags = tags;
    }
    // Inherit declared tags/untestable from disk if the API didn't relay them.
    for (const s of coverage.scenarios) {
      const scenario = allTests.get(s.id);
      if (!scenario) continue;
      if (!scenario.tags && s.tags.length > 0) scenario.tags = s.tags;
      if (!scenario.untestable && s.untestable) scenario.untestable = s.untestable;
    }
  } catch (err: any) {
    logWarn(`Coverage analyzer failed (continuing without computed tags): ${err?.message ?? err}`);
  }

  // Select and resolve dependencies
  let selectedIds: string[];
  try {
    selectedIds = selectScenarios(testArg, allTests);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  if (filter) {
    const before = selectedIds.length;
    selectedIds = applyTagFilter(selectedIds, allTests, filter, { includeUntestable });
    logInfo(`Filter applied: ${selectedIds.length}/${before} scenarios selected`);
  } else if (!includeUntestable) {
    // No explicit filter: still drop untestable scenarios by default.
    selectedIds = applyTagFilter(selectedIds, allTests, null, { includeUntestable: false });
  }

  // Drop scenarios whose `requires_env` lists an env var that isn't set on
  // the dev box. Lets scenarios that need real-world credentials (CF_TOKEN
  // for ACME Cloudflare DNS-01, etc.) auto-skip on machines without those
  // secrets instead of failing.
  const beforeEnvFilter = selectedIds.length;
  selectedIds = selectedIds.filter((id) => {
    const reqEnv = (allTests.get(id) as { requires_env?: string[] })?.requires_env ?? [];
    const missing = reqEnv.filter((name) => !process.env[name] || process.env[name] === "");
    if (missing.length > 0) {
      logWarn(`Skipping ${id} (requires_env missing: ${missing.join(", ")})`);
      return false;
    }
    return true;
  });
  if (selectedIds.length !== beforeEnvFilter) {
    logInfo(`requires_env filter dropped ${beforeEnvFilter - selectedIds.length} scenario(s)`);
  }

  // Scenarios with `run_in_ve: true` cannot run in default (local-backend)
  // mode — the deployer they target is a local Node process, not the
  // Hub-LXC inside the nested VM. Skip them with a clear hint.
  //
  // H.6: also skip in `--all` runs (even when nested-deployer mode is
  // active via auto-config). The OIDC/self-upgrade tests destroy the Hub
  // mid-run and replace it with a new CT — any other parallel-running
  // Spoke-tests against the same Hub would see SSH-resets and bogus vmids.
  // The OIDC-suite always runs as its own `--config <inst> @<list>`-style
  // invocation, never folded into `--all`.
  const isAllRun = testArg === "--all";
  if (!config.inNestedDeployerMode || isAllRun) {
    const beforeVeFilter = selectedIds.length;
    const skippedRunInVe: string[] = [];
    selectedIds = selectedIds.filter((id) => {
      const sc = allTests.get(id);
      if (sc?.run_in_ve) {
        skippedRunInVe.push(id);
        return false;
      }
      return true;
    });
    if (skippedRunInVe.length > 0) {
      const reason = isAllRun
        ? "(--all skips run_in_ve scenarios — run them in a dedicated OIDC-suite invocation)"
        : "(self-upgrade tests destroy the deployer mid-run and must target the Hub-LXC directly)";
      logWarn(
        `Skipping ${skippedRunInVe.length} scenario(s) with run_in_ve=true: ${skippedRunInVe.join(", ")}`,
      );
      logInfo(
        `Run them separately via: /livetest --config <instance> <scenario-or-@list> ${reason}`,
      );
    }
    if (selectedIds.length !== beforeVeFilter) {
      logInfo(`run_in_ve filter dropped ${beforeVeFilter - selectedIds.length} scenario(s)`);
    }
  }

  if (selectedIds.length === 0) {
    logFail("No scenarios matched after filter — nothing to run.");
    process.exit(1);
  }

  // Build the priority closure: catalog members + transitive deps. Drives
  // the snapshot-first topological order in collectWithDeps so the runner
  // builds the snapshot infrastructure (postgres → zitadel → catalog
  // member) before fanning out to leaf consumers. Empty set (no catalog
  // or no catalog-related scenarios in selection) leaves the legacy
  // task-priority + alphabetical sort intact.
  const priorityIds = snapshotCatalog.size > 0
    ? expandToPriorityClosure(snapshotCatalog, allTests)
    : new Set<string>();
  if (priorityIds.size > 0) {
    logInfo(`Priority set (catalog ∪ deps): ${priorityIds.size} scenario(s) — ${[...priorityIds].sort().join(", ")}`);
  }

  let scenariosToRun: ResolvedScenario[];
  try {
    scenariosToRun = collectWithDeps(selectedIds, allTests, priorityIds);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  logOk(`${scenariosToRun.length} scenario(s) to run (including dependencies)`);

  // Plan: assign VM IDs and stack names
  const planned = planScenarios(scenariosToRun, appStacktypes, allTests);

  // Implicit ordering: every upgrade/reconfigure waits for every same-tree
  // installation. Compresses the late-run tail (long destructive tasks would
  // otherwise become ready as soon as their direct source install finished
  // and run in parallel with the remaining installs — sometimes touching
  // shared external state like zitadel projects, producing late races).
  addImplicitDestructiveTaskDeps(planned);

  // Mark dependencies vs explicitly selected targets.
  //
  // A scenario is treated as a dependency (provider) when EITHER it was only
  // planned because something else depends on it, OR another planned scenario
  // depends on it. The second case matters for `--all`: every scenario is
  // technically "selected", but we still need provider apps (postgres, zitadel)
  // to behave like dependencies so their LXCs aren't destroyed before later
  // consumer tests run against them.
  const selectedIdSet = new Set(selectedIds);
  const dependedOn = new Set<string>();
  for (const p of planned) {
    for (const depId of p.scenario.depends_on ?? []) {
      if (depId !== p.scenario.id) dependedOn.add(depId);
    }
  }
  for (const p of planned) {
    p.isDependency =
      !selectedIdSet.has(p.scenario.id) || dependedOn.has(p.scenario.id);
  }
  // In `--snapshot <name>` build mode every listed scenario is a provider
  // whose CT we want to pct-snapshot at the end — none of them should be
  // torn down. Forcing isDependency=true reuses the existing exemption.
  if (snapshotMode) {
    for (const p of planned) p.isDependency = true;
  }

  // --deps-only: drop non-dependency steps so we install all providers, create
  // the per-application `<app>_deps` snapshot, and skip the target tests. Iteration loop
  // for the target test (e.g. tweaking a Playwright spec or a single template)
  // can then re-run without paying the dep-install cost.
  if (depsOnlyFlag) {
    const dropped = planned.filter((p) => !p.isDependency).map((p) => p.scenario.id);
    if (dropped.length > 0) {
      logInfo(`--deps-only: skipping target test(s): ${dropped.join(", ")}`);
    }
    for (let i = planned.length - 1; i >= 0; i--) {
      if (!planned[i]!.isDependency) planned.splice(i, 1);
    }
    if (planned.length === 0) {
      logInfo("--deps-only: no dependencies to install, nothing to do");
      return;
    }
  }

  // Show plan
  console.log("");
  logInfo("Execution plan:");
  for (const p of planned) {
    const tag = p.isDependency ? " (dep)" : "";
    console.log(`  ${p.scenario.id}: VM ${p.vmId}, stack=${p.stackName}${tag}`);
  }
  console.log("");

  // Live overview: bring up the HTTP/SSE server and write the initial
  // HTML viewer + JSON snapshot BEFORE the long rollback so an operator can
  // open the page during planning/baseline. Storage column fills in once
  // the executor seeds assignments; statuses fill in as scenarios run.
  const commandLine = process.argv.join(" ");
  // Shared runner-auth context — populated by scenario-executor after
  // Zitadel install (or via env vars below for OIDC-enabled-from-start Hubs).
  // Same reference is passed to both TestResultWriter and executePlan so
  // mutations from inside the executor (e.g. setting oidcCreds) propagate
  // to the writer's bundle-pull path.
  const runnerAuth: RunnerAuthContext = {};
  // Env-var bootstrap path: operator running against a Hub that's already
  // OIDC-enabled (no fresh step2b rollback). Otherwise creds get populated
  // by scenario-executor once Zitadel is installed/reachable.
  const envIssuer = process.env.TEST_DEPLOYER_OIDC_ISSUER_URL ?? process.env.OIDC_ISSUER_URL;
  const envClientId = process.env.TEST_DEPLOYER_OIDC_MACHINE_CLIENT_ID ?? process.env.OIDC_CLIENT_ID;
  const envSecret = process.env.TEST_DEPLOYER_OIDC_MACHINE_CLIENT_SECRET ?? process.env.OIDC_CLIENT_SECRET;
  if (envIssuer && envClientId && envSecret) {
    runnerAuth.oidcCreds = { issuerUrl: envIssuer, clientId: envClientId, clientSecret: envSecret };
    logInfo(`Runner machine-token bootstrap from env (issuer=${envIssuer})`);
  }
  const resultWriter = new TestResultWriter(projectRoot, config.instance, testArg, commandLine, apiUrl, runnerAuth);
  const overviewState: RunOverviewState = {
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
    phase: "planning",
  };
  const overviewServer: RunOverviewServer | null = await startRunOverviewServer(
    overviewState,
    overviewPortForDeployer(config.deployerUrl),
  );
  writeRunOverviewHtml(overviewState, overviewServer?.sseUrl ?? null);
  writeRunOverviewJson(overviewState);
  // Sweep result directories older than 3 h and regenerate the top-level
  // index.html so the user can browse past runs. Cleanup is timestamp-
  // based (runId prefix), independent of mtime which a running scenario
  // would refresh.
  const resultsRoot = path.dirname(resultWriter.getOutputDir());
  const removed = cleanupOldRuns(resultsRoot, 3);
  if (removed > 0) logInfo(`Removed ${removed} livetest result dir(s) older than 3h`);
  writeRunsIndex(resultsRoot);
  logInfo(`Runs index: file://${resultsRoot}/index.html`);
  const overviewJsonTimer = setInterval(() => {
    writeRunOverviewJson(overviewState);
  }, 60_000);
  overviewJsonTimer.unref();
  logInfo(`Results: ${resultWriter.getOutputDir()}`);
  if (overviewServer) {
    logInfo(`Live overview: ${overviewServer.url}/run-overview.html (file://${resultWriter.getOutputDir()}/run-overview.html for post-mortem)`);
  } else {
    logInfo(`Live overview: file://${resultWriter.getOutputDir()}/run-overview.html (server port busy — JSON-only updates)`);
  }
  // Coarse-grained phase labels for the HTML header. Setup phases can take
  // minutes (qm rollback boot, smartCleanup of dozens of CTs, ensureStacks
  // round-trips); knowing where the runner is helps an observer judge ETA.
  const setPhase = (phase: string): void => {
    overviewState.phase = phase;
    overviewServer?.emit(overviewState);
  };

  // Phase 0: resolve the per-application dependency-snapshot name for this
  // run scope. `null` for `--all` / multi-application subsets → no dep
  // snapshot is created or restored (those go the parallelisation route).
  // In `--snapshot <name>` mode the cluster name is given on the CLI;
  // otherwise apply the per-application heuristic from Phase 0.
  const depSnapshotName = snapshotMode ?? resolveDepSnapshotName(testArg, planned, selectedIdSet);
  if (snapshotMode) {
    logInfo(`Building snapshot @${snapshotMode} from listed providers`);
  } else if (depSnapshotName) {
    logInfo(`Dependency snapshot for this run: @${depSnapshotName}`);
  } else {
    logInfo("No dependency snapshot for this run scope (--all / multi-app)");
  }

  // VM preparation — gated by run mode:
  //   - all:    ALWAYS qm rollback to deployer-installed baseline. No
  //             dep-snapshot restore (would reuse stale state from prior
  //             runs and silently skip the full-suite validation `--all`
  //             is supposed to perform). Everything re-installs from
  //             scratch — that's the point.
  //   - file:   smartCleanup (threshold-based rollback OR per-CT destroy)
  //             + restoreBestSnapshot. Catalog snapshots from prior @file
  //             runs survive and accelerate re-runs.
  //   - single + --from-snapshot: per-dep pct rollback or destroy.
  //   - single (default): pre-cleanup of non-snapshot, non-needed CTs.
  //   - snapshot-build: legacy path (no qm rollback, no pre-cleanup).
  if (runMode === "all") {
    setPhase("rolling back nested VM to @deployer-installed");
    await rollbackToBaseline(config.pveHost, config.portPveSsh, config.vmId);
  } else if (runMode === "file" && !reuseRunning) {
    setPhase("smart-cleanup of pre-existing CTs");
    const plannedVmIdSet = new Set(planned.map((p) => p.vmId));
    await smartCleanupBeforeRun(config.pveHost, config.portPveSsh, config.vmId, plannedVmIdSet);
  } else if (reuseRunning) {
    logInfo("--reuse-running: skipping smart-cleanup; using whatever CTs are currently alive");
  }
  // restoreBestSnapshot is the dep-snapshot fast-path. Skipped for:
  //   - --all: full-suite test must validate everything from scratch.
  //   - single + --from-snapshot: rollbackOrDestroyDepsFromSnapshot does
  //     the same work plus destroys snapshotless deps; running both would
  //     pct-rollback every dep CT twice.
  //   - --reuse-running: caller wants to use the currently-alive deps
  //     untouched (post-failure iteration).
  if (runMode !== "all" && !(runMode === "single" && fromSnapshot) && !reuseRunning) {
    setPhase("restoring snapshots for dep CTs");
    await restoreBestSnapshot(planned, allTests, config, apiUrl, projectRoot, depSnapshotName);
  }
  // qm rollback wipes the nested-VM iptables + dnsmasq state, so reapply
  // port forwarding (idempotent) so Playwright specs and OIDC redirect URIs
  // still reach the right inner containers.
  setPhase("setting up port forwarding");
  setupPortForwarding(config);
  if (runMode === "single" && fromSnapshot) {
    setPhase("rolling back/destroying dep CTs from snapshot");
    await rollbackOrDestroyDepsFromSnapshot(planned, config.pveHost, config.portPveSsh, projectRoot);
  }
  if (runMode === "single") {
    setPhase("pre-cleanup of non-snapshot consumers");
    const neededVmIds = new Set(planned.map((p) => p.vmId));
    await preCleanupNonSnapshotConsumers(config.pveHost, config.portPveSsh, neededVmIds);
  }
  setPhase("preparing VMs");
  prepareVms(planned, config, appStacktypes);

  // Stack management: cleanup SQL, stale VM detection, stack creation
  setPhase("cleaning up stale state + creating stacks");
  runCleanupSql(planned, config.pveHost, config.portPveSsh);
  await destroyStaleVms(planned, config.pveHost, config.portPveSsh, apiUrl, appStacktypes);
  const { appStackIdsMap } = await ensureStacks(planned, apiUrl, appStacktypes);

  // Execute scenarios sequentially (topologically sorted)
  const keepVm = !!process.env.KEEP_VM;
  const fixtureBaseDir = fixturesFlag
    ? path.join(projectRoot, "frontend/src/test-fixtures")
    : undefined;
  if (failFastFlag) logInfo("--fail-fast enabled: aborting on first scenario failure");
  let result;
  const overviewOpts = { overview: { state: overviewState, server: overviewServer } };
  setPhase("running scenarios");
  try {
    if (parallelEnabled) {
      logInfo(`--parallel enabled: concurrency limit ${parallelLimit}`);
      const { executeScenariosParallel } = await import("./scenario-executor.mjs");
      result = await executeScenariosParallel(
        planned, config, apiUrl, veHost, projectRoot, appMetaMap, allTests,
        appStackIdsMap, resultWriter, fixtureBaseDir,
        { failFast: failFastFlag, debugLevel, depSnapshotName, concurrency: parallelLimit, snapshotMode, runMode, snapshotCatalog, ...overviewOpts, ...(volumeStorageOverride ? { volumeStorageOverride } : {}), ...(cliTimeoutSec !== undefined ? { cliTimeoutSec } : {}) },
      );
    } else {
      result = await executeScenarios(planned, config, apiUrl, veHost, projectRoot, appMetaMap, allTests, appStackIdsMap, resultWriter, fixtureBaseDir, { failFast: failFastFlag, debugLevel, depSnapshotName, snapshotMode, runMode, snapshotCatalog, runnerAuth, ...overviewOpts, ...(volumeStorageOverride ? { volumeStorageOverride } : {}), ...(cliTimeoutSec !== undefined ? { cliTimeoutSec } : {}) });
    }
  } finally {
    clearInterval(overviewJsonTimer);
    setPhase("finished");
    // Final JSON snapshot is the post-mortem source of truth — viewers
    // opened after the runner exits read this file. Index is regenerated
    // so the runs listing shows this run's final counts + failed list.
    writeRunOverviewJson(overviewState);
    writeRunsIndex(resultsRoot);
    if (overviewServer) {
      try { await overviewServer.stop(); } catch { /* best-effort */ }
    }
  }
  const allResults = [result];

  // Cleanup
  cleanupVms(planned, config.pveHost, config.portPveSsh, keepVm, snapshotCatalog);

  // Summary
  const totalPassed = allResults.reduce((s, r) => s + r.passed, 0);
  const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);
  const totalVms = allResults.flatMap((r) => r.steps.map((s) => s.vmId));

  console.log("");
  console.log("========================================");
  console.log(" Test Summary");
  console.log("========================================");
  console.log("");
  console.log(`Instance:     ${config.instance}`);

  for (const r of allResults) {
    const status = r.failed > 0 ? `${RED}FAILED${NC}` : `${GREEN}PASSED${NC}`;
    console.log(`  ${r.name}: ${status} (${r.passed} passed, ${r.failed} failed)`);
    for (const err of r.errors) {
      console.log(`    ${RED}> ${err}${NC}`);
    }
  }

  console.log("");
  console.log(`VMs created:  ${totalVms.join(" ")}`);
  console.log(`Tests Passed: ${totalPassed}`);
  console.log(`Tests Failed: ${totalFailed}`);
  console.log("");

  // Markdown summary for $GITHUB_STEP_SUMMARY (or fallback file when running locally).
  try {
    const summaryMd = renderResultsMarkdown(allResults, planned);
    const ghSummary = process.env.GITHUB_STEP_SUMMARY;
    if (ghSummary) {
      appendFileSync(ghSummary, summaryMd + "\n");
    } else {
      const localPath = path.join(projectRoot, ".livetest-data", "livetest-summary.md");
      try {
        writeFileSync(localPath, summaryMd, "utf-8");
        logInfo(`Livetest summary written to ${localPath}`);
      } catch {
        // Local run without .livetest-data dir — non-fatal.
      }
    }
  } catch (err: any) {
    logWarn(`Failed to render livetest summary: ${err?.message ?? err}`);
  }

  if (totalFailed > 0) {
    console.log(`${RED}FAILED${NC} - Some tests did not pass`);
    if (!keepVm) {
      console.log("\nTo inspect, re-run with: KEEP_VM=1 ...");
    }
    process.exit(1);
  } else {
    console.log(`${GREEN}PASSED${NC} - All tests passed`);
  }
}

/**
 * Verify the running spoke was built from the same git hash as the on-disk
 * `backend/dist/build-info.json`. The spoke is a long-lived background process
 * that loads JSON schemas once at startup; `/api/reload` does NOT recompile
 * them. So if backend source or schemas have changed since the spoke started,
 * its validators are stale — and validation errors mention properties that
 * actually exist in the on-disk schema (the classic "but the file is right!"
 * symptom).
 *
 * On mismatch: warn, invoke `e2e/start-livetest-deployer.sh <instance>` to
 * kill + restart, then re-discover the URL (port should be the same).
 */
async function ensureSpokeMatchesBuild(
  apiUrl: string,
  config: { instance: string; deployerUrl: string; deployerHttpsUrl: string },
  projectRoot: string,
): Promise<string> {
  // Read on-disk build hash. If build-info is missing (dev mode without
  // build), skip the check — only built spokes report a hash anyway.
  const buildInfoPath = path.join(projectRoot, "backend", "dist", "build-info.json");
  if (!existsSync(buildInfoPath)) {
    logInfo("build-info.json missing locally — skipping spoke build-hash check");
    return apiUrl;
  }
  const localInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8")) as {
    gitHash?: string;
    dirty?: boolean;
  };

  type SpokeVersion = { gitHash?: string; dirty?: boolean; buildTime?: string; startTime?: string };
  let spokeVersion: SpokeVersion | null = null;
  try {
    const resp = await fetch(`${apiUrl}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      // Naming the type rather than `typeof spokeVersion` avoids a tsc edge
      // case where the self-referential `typeof` narrows the cast target to
      // `never` after the initial `= null` flow analysis.
      spokeVersion = (await resp.json()) as SpokeVersion;
    }
  } catch {
    // pre-flight endpoint may not exist on older spokes — treat as mismatch
  }

  const localHash = `${localInfo.gitHash ?? ""}${localInfo.dirty ? "-dirty" : ""}`;
  const spokeHash = spokeVersion
    ? `${spokeVersion.gitHash ?? ""}${spokeVersion.dirty ? "-dirty" : ""}`
    : "<unreachable>";

  if (spokeVersion && spokeHash === localHash) {
    logOk(`Spoke build matches on-disk (gitHash=${spokeHash}, started ${spokeVersion.startTime ?? "?"})`);
    return apiUrl;
  }

  logWarn(`Spoke build mismatch — restarting before tests can run`);
  logInfo(`  spoke:  ${spokeHash}`);
  logInfo(`  local:  ${localHash}`);

  const startScript = path.join(projectRoot, "e2e", "start-livetest-deployer.sh");
  if (!existsSync(startScript)) {
    logFail(`Cannot auto-restart spoke: ${startScript} not found`);
    process.exit(1);
  }
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(startScript, [config.instance], {
    stdio: "inherit",
    cwd: projectRoot,
  });
  if (result.status !== 0) {
    logFail(`start-livetest-deployer.sh exited ${result.status} — aborting`);
    process.exit(1);
  }

  // Rediscover (port may have changed if config was edited mid-flight)
  const fresh = await discoverApiUrl(config.deployerUrl, config.deployerHttpsUrl);
  logOk(`Spoke restarted; API now at ${fresh}`);

  // Verify the freshly started spoke reports the matching hash. If it
  // doesn't, something is wrong with the build pipeline (e.g. the new
  // process loaded an older dist).
  try {
    const resp = await fetch(`${fresh}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const v = (await resp.json()) as { gitHash?: string; dirty?: boolean };
      const newHash = `${v.gitHash ?? ""}${v.dirty ? "-dirty" : ""}`;
      if (newHash !== localHash) {
        logFail(`Restarted spoke still reports ${newHash}, expected ${localHash}. Build pipeline issue?`);
        process.exit(1);
      }
    }
  } catch {
    logWarn("Could not verify restarted spoke's build hash — proceeding anyway");
  }
  return fresh;
}

/** Remove the first occurrence of `--name <value>` from `args` and return value. */
function popValueFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

/** Remove every `--name <value>` from `args`, returning values in order. */
function popAllValueFlags(args: string[], name: string): string[] {
  const out: string[] = [];
  while (true) {
    const v = popValueFlag(args, name);
    if (v === undefined) return out;
    out.push(v);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${NC}`, err.message || err);
  process.exit(1);
});
