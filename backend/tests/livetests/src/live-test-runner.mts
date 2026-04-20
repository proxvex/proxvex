#!/usr/bin/env tsx
/**
 * TypeScript Live Integration Test Runner for OCI LXC Deployer.
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
 *   tsx live-test-runner.mts [instance] [test-name|--all] [--queue] [--fixtures]
 *
 * Examples:
 *   tsx live-test-runner.mts github-action postgres/ssl
 *   tsx live-test-runner.mts github-action zitadel        # runs all zitadel/* + deps
 *   tsx live-test-runner.mts github-action --all
 *   tsx live-test-runner.mts github-action --queue         # parallel queue worker mode
 *   KEEP_VM=1 tsx live-test-runner.mts github-action zitadel/ssl
 */

import { nestedSsh, nestedSshStrict } from "./ssh-helpers.mjs";
import { collectWithDeps, selectScenarios, planScenarios } from "./scenario-planner.mjs";
import { TestResultWriter } from "./test-result-writer.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario, TestResult } from "./livetest-types.mjs";
import { apiFetch, type AppMeta } from "./verifier.mjs";
import { collectDiagnostics } from "./diagnostics.mjs";
import { runCleanupSql, destroyStaleVms, ensureStacks } from "./stack-manager.mjs";
import { rollbackToBaseline, restoreBestSnapshot, prepareVms } from "./vm-lifecycle.mjs";
import { executeScenarios } from "./scenario-executor.mjs";
import { RED, GREEN, NC, logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";

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

  return {
    instance,
    pveHost,
    portPveSsh,
    pveWebUrl,
    deployerUrl,
    deployerHttpsUrl,
    bridge: inst.bridge || "vmbr0",
    veHost,
    veSshPort,
    vmId: inst.vmId,
    snapshot,
    registryMirror,
    portForwarding,
  };
}

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/** Find an existing managed container by application_id or hostname prefix via the installations API */
async function findExistingVm(
  apiUrl: string,
  veHost: string,
  applicationId: string,
  hostname?: string,
): Promise<{ vm_id: number; addons?: string[] } | null> {
  const veContextKey = `ve_${veHost}`;
  const containers = await apiFetch<Array<{ vm_id: number; application_id?: string; hostname?: string; addons?: string[] }>>(
    apiUrl,
    `/api/${veContextKey}/installations`,
  );
  if (!containers) return null;
  // Match by application_id first, then fallback to hostname prefix
  return containers.find((c) => c.application_id === applicationId)
    ?? (hostname ? containers.find((c) => c.hostname === hostname) : null)
    ?? containers.find((c) => c.hostname?.startsWith(`${applicationId}-`))
    ?? null;
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
  const filteredArgs = args.filter(a => a !== "--fixtures" && a !== "--queue");
  const instance = filteredArgs[0] || undefined;
  const testArg = filteredArgs[1] || "--all";

  const config = loadConfig(instance);
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");

  console.log("========================================");
  console.log(" OCI LXC Deployer - Live Integration Test");
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

  // Ensure VE host SSH config exists on the deployer
  const veHost = config.veHost;
  const deploySshPort = config.veSshPort;
  let veContextKey = "";
  const veConfigResp = await apiFetch<{ key: string }>(apiUrl, `/api/ssh/config/${encodeURIComponent(veHost)}`);
  if (veConfigResp?.key) {
    veContextKey = veConfigResp.key;
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
      // Fetch the newly created key
      const newConfig = await apiFetch<{ key: string }>(apiUrl, `/api/ssh/config/${encodeURIComponent(veHost)}`);
      if (newConfig?.key) veContextKey = newConfig.key;
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

  // Set up registry mirror DNS + insecure config on nested PVE host
  // Local mirrors (set up by step2): Docker Hub on 10.0.0.1:443, ghcr.io on 10.0.0.2:443
  if (config.registryMirror) {
    const fwd = config.registryMirror.dnsForwarder;
    try {
      // a) dnsmasq: docker-registry-mirror → production mirror (for mirror_detect in containers)
      //    registry-1.docker.io/index.docker.io → 10.0.0.1 (local Docker Hub mirror)
      //    ghcr.io → 10.0.0.2 (local ghcr.io mirror)
      const dnsCheck = nestedSsh(config.pveHost, config.portPveSsh,
        `grep -q 'address=/ghcr.io/' /etc/dnsmasq.d/e2e-nat.conf 2>/dev/null && echo "exists" || echo "missing"`,
        5000);
      if (dnsCheck.trim() === "missing") {
        nestedSsh(config.pveHost, config.portPveSsh,
          `cat >> /etc/dnsmasq.d/e2e-nat.conf <<'DNS'\n` +
          `server=/docker-registry-mirror/${fwd}\n` +
          `address=/registry-1.docker.io/10.0.0.1\n` +
          `address=/index.docker.io/10.0.0.1\n` +
          `address=/ghcr.io/10.0.0.2\n` +
          `DNS\n` +
          `systemctl restart dnsmasq`,
          10000);
        logOk(`dnsmasq forwarding: docker-registry-mirror -> ${fwd}`);
        logOk("dnsmasq forwarding: registry-1.docker.io -> 10.0.0.1 (local mirror)");
        logOk("dnsmasq forwarding: ghcr.io -> 10.0.0.2 (local mirror)");
      } else {
        logOk("dnsmasq forwarding already configured");
      }

      // b) Skopeo insecure config for local mirrors
      const skopeoCheck = nestedSsh(config.pveHost, config.portPveSsh,
        `grep -q ghcr.io /etc/containers/registries.conf.d/mirror.conf 2>/dev/null && echo "exists" || echo "missing"`,
        5000);
      if (skopeoCheck.trim() === "missing") {
        nestedSsh(config.pveHost, config.portPveSsh,
          `mkdir -p /etc/containers/registries.conf.d && printf '[[registry]]\\nlocation = "registry-1.docker.io"\\ninsecure = true\\n\\n[[registry]]\\nlocation = "index.docker.io"\\ninsecure = true\\n\\n[[registry]]\\nlocation = "ghcr.io"\\ninsecure = true\\n' > /etc/containers/registries.conf.d/mirror.conf`,
          10000);
        logOk("Skopeo insecure config for registry mirrors written");
      } else {
        logOk("Skopeo insecure config already exists");
      }
    } catch {
      logInfo("Warning: Could not configure registry mirror (non-fatal)");
    }
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
  const apps = await apiFetch<Array<{ id: string; stacktype?: string | string[]; extends?: string; tags?: string[]; verification?: AppMeta["verification"] }>>(apiUrl, "/api/applications");
  if (apps) {
    for (const app of apps) {
      if (app.stacktype) appStacktypes.set(app.id, app.stacktype);
      appMetaMap.set(app.id, {
        extends: app.extends,
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

  // Select and resolve dependencies
  let selectedIds: string[];
  try {
    selectedIds = selectScenarios(testArg, allTests);
  } catch (err: any) {
    logFail(err.message);
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

  // Mark dependencies vs explicitly selected targets
  const selectedIdSet = new Set(selectedIds);
  for (const p of planned) {
    p.isDependency = !selectedIdSet.has(p.scenario.id);
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
  const { stackIdMap, appStackIdsMap } = await ensureStacks(planned, apiUrl, appStacktypes);

  // Execute scenarios sequentially (topologically sorted)
  const keepVm = !!process.env.KEEP_VM;
  const fixtureBaseDir = fixturesFlag
    ? path.join(projectRoot, "frontend/src/test-fixtures")
    : undefined;
  const resultWriter = new TestResultWriter(projectRoot, config.instance);
  const result = await executeScenarios(planned, config, apiUrl, veHost, projectRoot, appMetaMap, allTests, appStackIdsMap, resultWriter, fixtureBaseDir);
  const allResults = [result];

  // Collect diagnostics before cleanup (VMs still running)
  const diagPath = collectDiagnostics(allResults, config.pveHost, config.portPveSsh, projectRoot);
  if (diagPath) {
    logOk(`Diagnostics saved: ${diagPath}`);
  }

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

main().catch((err) => {
  console.error(`${RED}Fatal error:${NC}`, err.message || err);
  process.exit(1);
});
