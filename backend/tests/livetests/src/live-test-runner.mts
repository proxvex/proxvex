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

import { nestedSsh, nestedSshStrict } from "./ssh-helpers.mjs";
import { collectWithDeps, selectScenarios, planScenarios, applyTagFilter } from "./scenario-planner.mjs";
import { TestResultWriter } from "./test-result-writer.mjs";
import { renderResultsMarkdown } from "./result-summary.mjs";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario } from "./livetest-types.mjs";
import { apiFetch, type AppMeta } from "./verifier.mjs";
import { runCleanupSql, destroyStaleVms, ensureStacks } from "./stack-manager.mjs";
import { rollbackToBaseline, restoreBestSnapshot, prepareVms } from "./vm-lifecycle.mjs";
import { executeScenarios } from "./scenario-executor.mjs";
import { RED, GREEN, NC, logOk, logFail, logWarn, logInfo } from "./log-helpers.mjs";
import { analyzeCoverage } from "./coverage-analyzer.mjs";
import { renderMarkdown as renderCoverageMarkdown, renderJson as renderCoverageJson } from "./coverage-report.mjs";
import { buildAdHocFilter, buildFilter, loadTestSets, resolvePreset, type ResolvedFilter } from "./test-set-registry.mjs";

// Re-export types so existing imports from this module continue to work
export type { TestScenario, ResolvedScenario, PlannedScenario, StepResult, TestResult, E2EConfig, ParamEntry } from "./livetest-types.mjs";
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
  vmId: number;
  snapshot: { enabled: boolean } | undefined;
  registryMirror: { dnsForwarder: string } | undefined;
  portForwarding: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
  zitadelPat: string | undefined;
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

  // Resolve ${VAR:-default} and ${VAR} in config values
  const resolveEnv = (val: string) =>
    val
      .replace(/\$\{(\w+):-(\w+)\}/g, (_, varName, defaultVal) => process.env[varName] || defaultVal)
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

  // veHost/veSshPort: how the deployer (inside the nested VM) reaches the PVE host.
  // Defaults to pveHost:portPveSsh (same as external), but can be overridden
  // for nested setups where the deployer uses a different hostname/port.
  const veHost = inst.veHost ? resolveEnv(inst.veHost) : pveHost;
  const veSshPort = inst.veSshPort ?? portPveSsh;

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
    vmId: inst.vmId,
    snapshot,
    registryMirror,
    portForwarding,
    zitadelPat,
  };
}

/**
 * Resolve volume_storage parameter by querying PVE rootdir storages via SSH.
 * Prioritizes zfspool > dir > any other type.
 */
export function resolveVolumeStorage(
  pveHost: string,
  sshPort: number,
  existingParams: { name: string; value: string }[],
): void {
  if (existingParams.some((p) => p.name === "volume_storage")) return;
  try {
    const raw = nestedSshStrict(pveHost, sshPort,
      "pvesm status --content rootdir 2>/dev/null | tail -n +2", 10000);
    const storages = raw.trim().split("\n")
      .map((line) => {
        const [name, type] = line.trim().split(/\s+/);
        return { name: name || "", type: type || "" };
      })
      .filter((s) => s.name);
    if (storages.length === 0) return;
    // Prioritize: zfspool > dir > first available
    const preferred =
      storages.find((s) => s.type === "zfspool") ??
      storages.find((s) => s.type === "dir") ??
      storages[0];
    existingParams.push({ name: "volume_storage", value: preferred.name });
    logInfo(`Auto-resolved volume_storage=${preferred.name} (${preferred.type})`);
  } catch {
    // SSH failed — continue without, CLI will validate
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

// ── Cleanup ──

function cleanupVms(
  planned: PlannedScenario[],
  pveHost: string,
  sshPort: number,
  keepVm: boolean,
) {
  for (const p of [...planned].reverse()) {
    if (p.isDependency) {
      logWarn(`Keeping dependency VM ${p.vmId} (${p.scenario.id})`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else if (keepVm) {
      logWarn(`KEEP_VM set - VM ${p.vmId} not destroyed`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else {
      logInfo(`Cleaning up VM ${p.vmId}...`);
      nestedSsh(pveHost, sshPort,
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
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

  const positionalArgs = args.filter((a, i, arr) =>
    a !== "--fixtures" &&
    a !== "--queue" &&
    a !== "--fail-fast" &&
    a !== "--include-untestable" &&
    a !== "--coverage-report" &&
    a !== "--gaps-only" &&
    a !== "--deps-only" &&
    !(arr[i - 1] === "--format")
  );
  const instance = positionalArgs[0] || undefined;
  const testArg = positionalArgs[1] || "--all";

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
  apiUrl = await ensureSpokeMatchesBuild(apiUrl, config, projectRoot);

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

  // Set up port forwarding for containers that need external access (e.g. Zitadel for OIDC)
  if (config.portForwarding.length > 0) {
    try {
      for (const fwd of config.portForwarding) {
        // a) dnsmasq static DHCP lease on nested VM
        const dhcpCheck = nestedSsh(config.pveHost, config.portPveSsh,
          `grep -q 'dhcp-host=${fwd.hostname}' /etc/dnsmasq.d/e2e-nat.conf 2>/dev/null && echo "exists" || echo "missing"`,
          5000);
        if (dhcpCheck.trim() === "missing") {
          nestedSsh(config.pveHost, config.portPveSsh,
            `echo "dhcp-host=${fwd.hostname},${fwd.ip}" >> /etc/dnsmasq.d/e2e-nat.conf`,
            5000);
        }

        // b) iptables DNAT on nested VM (inner forwarding)
        const innerCheck = nestedSsh(config.pveHost, config.portPveSsh,
          `iptables -t nat -C PREROUTING -p tcp --dport ${fwd.port} -j DNAT --to-destination ${fwd.ip}:${fwd.containerPort} 2>/dev/null && echo "exists" || echo "missing"`,
          5000);
        if (innerCheck.trim() === "missing") {
          nestedSsh(config.pveHost, config.portPveSsh,
            `iptables -t nat -A PREROUTING -p tcp --dport ${fwd.port} -j DNAT --to-destination ${fwd.ip}:${fwd.containerPort} && iptables -A FORWARD -p tcp -d ${fwd.ip} --dport ${fwd.containerPort} -j ACCEPT`,
            5000);
        }

        // c) iptables DNAT on outer PVE host (port 22, not nested port)
        // Forwards external port to nested VM which then forwards to container
        const nestedVmIp = "10.99.1.10";
        try {
          nestedSsh(config.pveHost, 22,
            `iptables -t nat -C PREROUTING -p tcp --dport ${fwd.port} -j DNAT --to-destination ${nestedVmIp}:${fwd.port} 2>/dev/null || (iptables -t nat -A PREROUTING -p tcp --dport ${fwd.port} -j DNAT --to-destination ${nestedVmIp}:${fwd.port} && iptables -A FORWARD -p tcp -d ${nestedVmIp} --dport ${fwd.port} -j ACCEPT)`,
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
    await runQueue(config, apiUrl, veHost, projectRoot, appMetaMap, resolveVolumeStorage);
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

  if (selectedIds.length === 0) {
    logFail("No scenarios matched after filter — nothing to run.");
    process.exit(1);
  }

  let scenariosToRun: ResolvedScenario[];
  try {
    scenariosToRun = collectWithDeps(selectedIds, allTests);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  logOk(`${scenariosToRun.length} scenario(s) to run (including dependencies)`);

  // Plan: assign VM IDs and stack names
  const planned = planScenarios(scenariosToRun, appStacktypes, allTests);

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

  // --deps-only: drop non-dependency steps so we install all providers, create
  // the dep-stacks-ready snapshot, and skip the target tests. Iteration loop
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

  // VM preparation: snapshot restore → pre-cleanup
  if (testArg === "--all") rollbackToBaseline(config, projectRoot);
  await restoreBestSnapshot(planned, allTests, config, apiUrl, projectRoot);
  prepareVms(planned, config, appStacktypes);

  // Stack management: cleanup SQL, stale VM detection, stack creation
  runCleanupSql(planned, config.pveHost, config.portPveSsh);
  await destroyStaleVms(planned, config.pveHost, config.portPveSsh, apiUrl, appStacktypes);
  const { appStackIdsMap } = await ensureStacks(planned, apiUrl, appStacktypes);

  // Execute scenarios sequentially (topologically sorted)
  const keepVm = !!process.env.KEEP_VM;
  const fixtureBaseDir = fixturesFlag
    ? path.join(projectRoot, "frontend/src/test-fixtures")
    : undefined;
  const commandLine = process.argv.join(" ");
  const resultWriter = new TestResultWriter(projectRoot, config.instance, testArg, commandLine, apiUrl);
  logInfo(`Results: ${resultWriter.getOutputDir()}`);
  if (failFastFlag) logInfo("--fail-fast enabled: aborting on first scenario failure");
  const result = await executeScenarios(planned, config, apiUrl, veHost, projectRoot, appMetaMap, allTests, appStackIdsMap, resultWriter, fixtureBaseDir, { failFast: failFastFlag, debugLevel });
  const allResults = [result];

  // Cleanup
  cleanupVms(planned, config.pveHost, config.portPveSsh, keepVm);

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

  let spokeVersion: { gitHash?: string; dirty?: boolean; buildTime?: string; startTime?: string } | null = null;
  try {
    const resp = await fetch(`${apiUrl}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      spokeVersion = (await resp.json()) as typeof spokeVersion;
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
