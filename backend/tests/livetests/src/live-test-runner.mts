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

import { runCli } from "./cli-executor.mjs";
import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, nestedSshStrict, waitForServices } from "./ssh-helpers.mjs";
import {
  collectWithDeps,
  selectScenarios,
  buildParams,
  planScenarios,
  partitionAfterFailure,
} from "./scenario-planner.mjs";
import { TestResultWriter, type TestResultDependency } from "./test-result-writer.mjs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ResolvedScenario,
  type PlannedScenario,
  type TestResult,
  type E2EConfig,
  type ParamEntry,
} from "./livetest-types.mjs";
import { Verifier, apiFetch, buildDefaultVerify, type AppMeta } from "./verifier.mjs";
import { collectDiagnostics } from "./diagnostics.mjs";
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
function resolveVolumeStorage(
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

// ── Execute all planned scenarios sequentially ──

async function executeScenarios(
  planned: PlannedScenario[],
  config: ReturnType<typeof loadConfig>,
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
  resultWriter?: TestResultWriter,
  fixtureBaseDir?: string,
): Promise<TestResult> {
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

  // Build hash for snapshot invalidation — snapshots from different builds are stale
  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore — no build hash available */ }

  // Snapshot support for dependencies
  // A step is snapshot-worthy if another step in the plan depends on it
  const allDepIds = new Set(planned.flatMap((p) => p.scenario.depends_on ?? []));
  const depSteps = planned.filter((p) => allDepIds.has(p.scenario.id) && !p.skipExecution);
  // For dev (local deployer), use .livetest-data/ for context backup/restore with snapshots
  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  const snapMgr = config.snapshot?.enabled
    ? new SnapshotManager(config.pveHost, config.vmId, config.portPveSsh, (msg) => logInfo(msg), localContextPath)
    : null;

  // Try to restore from whole-VM snapshot (skip dependency installation)
  let depsRestoredFromSnapshot = false;
  if (snapMgr && depSteps.length > 0) {
    const depIds = depSteps.map((p) => p.scenario.id);
    const best = snapMgr.findBestSnapshot(depIds, buildHash);
    if (best) {
      try {
        logStep("Snapshot", `Restoring to @${best.name}`);
        snapMgr.rollback(best.name);
        depsRestoredFromSnapshot = true;

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

        // Mark all dependencies up to and including the snapshot as skipped
        for (let j = 0; j <= best.index; j++) {
          depSteps[j]!.skipExecution = true;
        }
        logOk(`Dependencies restored from VM snapshot @${best.name}`);
      } catch (err) {
        logInfo(`VM snapshot restore failed, will install normally: ${err}`);
      }
    }
  }

  try {
    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]!;
      const scenario = step.scenario;
      const task = scenario.task || "installation";

      logStep(
        `${i + 1}/${planned.length}`,
        `${scenario.id} (${task}) [VM ${step.vmId}]`,
      );

      const stepStartTime = new Date();

      // Skip dependencies restored from ZFS snapshot
      if (depsRestoredFromSnapshot && step.isDependency) {
        logOk(`Skipping ${scenario.id} (restored from snapshot)`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        continue;
      }

      // Skip dependencies that are already running
      if (step.skipExecution) {
        logOk(`Skipping ${scenario.id} (already running)`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        continue;
      }

      // Build params — for replace_ct tasks, don't preset vm_id (create_ct assigns it)
      const isReplaceCt = REPLACE_CT_TASKS.includes(task);
      const baseParams = [
        { name: "hostname", value: step.hostname },
        { name: "bridge", value: config.bridge },
        ...(!isReplaceCt ? [{ name: "vm_id", value: String(step.vmId) }] : []),
      ];

      const templateVars: Record<string, string> = {
        vm_id: String(step.vmId),
        hostname: step.hostname,
        stack_name: step.stackName,
      };

      const buildResult = buildParams(scenario, baseParams, templateVars, tmpDir);

      // For upgrade/reconfigure: find existing VM via installations API
      let existingVm: { vm_id: number; addons?: string[] } | null = null;
      if (isReplaceCt) {
        existingVm = await findExistingVm(apiUrl, veHost, scenario.application);
        if (!existingVm) {
          const errMsg = `No existing VM found for ${scenario.application} — cannot ${task}`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          break;
        }
        buildResult.params.push({ name: "previouse_vm_id", value: String(existingVm.vm_id) });
        logInfo(`Found existing VM ${existingVm.vm_id} for ${task} (previouse_vm_id)`);
      }

      // Resolve enum defaults (e.g. volume_storage) via API
      resolveVolumeStorage(config.pveHost, config.portPveSsh, buildResult.params);

      // Addons come from scenario params file (selectedAddons)
      const allAddons = buildResult.selectedAddons ?? [];

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const paramsObj: Record<string, unknown> = {
        application: scenario.application,
        task,
        params: buildResult.params.map((p) => ({ name: p.name, value: p.value })),
      };

      if (allAddons.length > 0) {
        paramsObj.selectedAddons = allAddons;
      }
      // For reconfigure: pass installed addons so route handler can compute delta
      if (isReplaceCt && existingVm?.addons && existingVm.addons.length > 0) {
        paramsObj.installedAddons = existingVm.addons;
        logInfo(`Installed addons: ${existingVm.addons.join(", ")}`);
      }
      if (buildResult.stackId) {
        paramsObj.stackId = buildResult.stackId;
      } else if (step.hasStacktype) {
        paramsObj.stackId = step.stackName;
      }

      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      if (allAddons.length > 0) {
        logInfo(`Addons: ${allAddons.join(", ")}`);
      }

      // Reload deployer to pick up any json/ changes
      try {
        const reloadResp = await fetch(`${apiUrl}/api/reload`, { method: "POST" });
        if (reloadResp.ok) {
          logInfo("Deployer reloaded");
        } else {
          logInfo(`Deployer reload returned ${reloadResp.status} (continuing)`);
        }
      } catch {
        logInfo("Deployer reload not available (continuing)");
      }

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const scenarioFixtureDir = fixtureBaseDir
        ? path.join(fixtureBaseDir, scenario.id.replace("/", "-"))
        : undefined;
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout, scenarioFixtureDir,
      );

      if (cliResult.exitCode !== 0) {
        const errMsg = `Scenario failed: ${scenario.id} (${task})`;
        logFail(errMsg);
        result.errors.push(errMsg);
        result.failed++;
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
          cliOutput: cliResult.output,
        });

        // Write failed test result
        if (resultWriter) {
          resultWriter.write(TestResultWriter.buildResult({
            runId: resultWriter.getRunId(),
            scenarioId: scenario.id,
            application: scenario.application,
            task,
            status: "failed",
            vmId: step.vmId,
            hostname: step.hostname,
            stackName: step.stackName,
            addons: scenario.selectedAddons ?? [],
            startedAt: stepStartTime,
            finishedAt: new Date(),
            deployerVersion,
            deployerGitHash,
            dependencies: [],
            verifyResults: {},
            errorMessage: errMsg,
          }));
        }

        // If a dependency failed, partition remaining tests:
        // run unaffected tests first, skip blocked tests
        if (allDepIds.has(scenario.id)) {
          const remaining = planned.slice(i + 1);
          const allTests = new Map(planned.map((p) => [p.scenario.id, p.scenario]));
          const { unaffected, blocked } = partitionAfterFailure(scenario.id, remaining, allTests);

          if (unaffected.length > 0) {
            logInfo(`Dependency ${scenario.id} failed — running ${unaffected.length} unaffected test(s) first`);
            // Re-order: run unaffected tests in the remaining slots
            for (let u = 0; u < unaffected.length; u++) {
              planned[i + 1 + u] = unaffected[u]!;
            }
          }

          // Mark blocked tests as skipped
          for (const b of blocked) {
            logWarn(`Skipping ${b.scenario.id} (blocked by failed dependency ${scenario.id})`);
            b.skipExecution = true;
            result.errors.push(`Skipped: ${b.scenario.id} (dependency ${scenario.id} failed)`);
          }

          // Append blocked (skipped) tests after unaffected
          for (let b = 0; b < blocked.length; b++) {
            planned[i + 1 + unaffected.length + b] = blocked[b]!;
          }
          continue; // Don't break — let the loop continue with reordered plan
        }

        break; // Non-dependency failure — stop execution
      }

      // For replace_ct tasks: discover the new VM ID (create_ct assigned a new one)
      if (isReplaceCt) {
        const newVm = await findExistingVm(apiUrl, veHost, scenario.application);
        if (newVm) {
          logOk(`replace_ct: new VM_ID=${newVm.vm_id} (was ${step.vmId})`);
          step.vmId = newVm.vm_id;
        }
      }

      logOk(`Container ready: VM_ID=${step.vmId}, hostname=${step.hostname}`);
      result.steps.push({
        vmId: step.vmId, hostname: step.hostname,
        application: scenario.application, scenarioId: scenario.id,
        cliOutput: cliResult.output,
      });

      // Wait for services if needed (test.json overrides application.json default)
      const appMeta = appMetaMap.get(scenario.application) ?? {};
      const waitSeconds = scenario.wait_seconds ?? appMeta.verification?.wait_seconds ?? 0;
      if (waitSeconds > 0) {
        if (appMeta.extends === "docker-compose") {
          await waitForServices(config.pveHost, config.portPveSsh, step.vmId, waitSeconds, { info: logInfo, ok: logOk, warn: logWarn });
        } else {
          // For non-docker apps (e.g. oci-image after reboot), wait a fixed time
          logInfo(`Waiting ${waitSeconds}s for container to be ready...`);
          await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        }
      }

      // Run verifications (auto-defaults merged with explicit verify from test.json)
      const defaultVerify = buildDefaultVerify(scenario, appMeta);
      const finalVerify = { ...defaultVerify, ...(scenario.verify ?? {}) };
      // Remove entries explicitly set to false
      for (const [k, v] of Object.entries(finalVerify)) {
        if (v === false) delete finalVerify[k];
      }
      logInfo("Verifying...");
      await verifier.runAll(step.vmId, step.hostname, finalVerify, planned);

      // Write test result JSON
      if (resultWriter) {
        const depInfos: TestResultDependency[] = (scenario.depends_on ?? []).map((depId) => {
          const depStep = planned.find((p) => p.scenario.id === depId);
          // Try CLI JSON result first (available after fresh install),
          // fallback to PVE host LXC notes (works after rollback too)
          const depApp = depId.split("/")[0] ?? "";
          const prefix = depApp.toUpperCase().replace(/-/g, "_");
          let version = cliResult.resolvedVersions.get(prefix) ?? "";
          if (!version && depStep) {
            try {
              const raw = nestedSsh(config.pveHost, config.portPveSsh,
                `sed -n 's/.*oci-lxc-deployer%3Aversion \\([^ <]*\\).*/\\1/p' /etc/pve/lxc/${depStep.vmId}.conf 2>/dev/null | head -1`,
                5000);
              version = decodeURIComponent(raw.trim());
            } catch { /* ignore */ }
          }
          return {
            scenario_id: depId,
            vm_id: depStep?.vmId ?? 0,
            status: "passed" as const,
            version,
            snapshot_used: snapMgr?.snapshotName(depId) ?? null,
            snapshot_date: null,
          };
        });
        resultWriter.write(TestResultWriter.buildResult({
          runId: resultWriter.getRunId(),
          scenarioId: scenario.id,
          application: scenario.application,
          task,
          status: "passed",
          vmId: step.vmId,
          hostname: step.hostname,
          stackName: step.stackName,
          addons: scenario.selectedAddons ?? [],
          startedAt: stepStartTime,
          finishedAt: new Date(),
          deployerVersion,
          deployerGitHash,
          dependencies: depInfos,
          verifyResults: Object.fromEntries(
            Object.entries(finalVerify).map(([k, v]) => [k, !!v]),
          ),
        }));
      }

      // Create whole-VM snapshot after each dependency is installed and verified
      if (snapMgr && allDepIds.has(step.scenario.id) && !step.skipExecution) {
        try {
          const depSnapName = snapMgr.snapshotName(step.scenario.id);
          snapMgr.create(depSnapName, buildHash);
        } catch (err) {
          logInfo(`VM snapshot creation failed (non-fatal): ${err}`);
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  result.passed = verifier.passed;
  result.failed += verifier.failed;
  return result;
}

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
    await runQueueWorker(config, apiUrl, veHost, projectRoot, appMetaMap);
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
  const planned = planScenarios(scenariosToRun, appStacktypes);

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

  // Pre-test cleanup: smart handling of dependencies vs targets
  for (const p of planned) {
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
      // Health check: verify the container is actually managed (not leftover from a failed run)
      let isManaged = false;
      try {
        const notes = nestedSsh(config.pveHost, config.portPveSsh,
          `pct config ${p.vmId} 2>/dev/null | grep -a 'description:' | head -1`, 5000);
        isManaged = /oci-lxc-deployer(%3A|:)managed/.test(notes);
      } catch { /* treat as not managed */ }
      if (isManaged) {
        logOk(`Dependency VM ${p.vmId} (${p.scenario.id}) running — reusing`);
        p.skipExecution = true;
      } else {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) running but not managed — destroying`);
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
          30000);
      }
    } else if (REPLACE_CT_TASKS.includes(task) && status.includes("running")) {
      // upgrade/reconfigure: keep existing VM, don't destroy
      logOk(`VM ${p.vmId} (${p.scenario.id}) running — ${task} in place`);
    } else if (!p.isDependency || status.includes("status:")) {
      // Target VMs: always try to destroy (even if status check failed)
      // Dependency VMs: only destroy if they exist but aren't running
      logInfo(`Destroying VM ${p.vmId} (${p.scenario.id})...`);
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
        30000);
    }

    // Clean volumes only for targets (not for reused dependencies or replace_ct tasks)
    if (!p.skipExecution && !REPLACE_CT_TASKS.includes(task)) {
      nestedSsh(config.pveHost, config.portPveSsh,
        `find /rpool/data -maxdepth 4 -type d -name ${JSON.stringify(p.hostname)} -path "*/volumes/*" -exec rm -rf {} + 2>/dev/null || true`,
        15000);
    }

    // Verify VM is actually gone (for targets, not replace_ct tasks)
    if (!p.skipExecution && !p.isDependency && !REPLACE_CT_TASKS.includes(task)) {
      const verify = nestedSsh(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
      if (verify.includes("status:")) {
        logFail(`Failed to destroy VM ${p.vmId} — aborting`);
        process.exit(1);
      }
    }
  }

  // Run cleanup SQL on reused dependency VMs (e.g. DROP DATABASE for target apps)
  for (const p of planned) {
    if (p.isDependency || !p.scenario.cleanup) continue;
    for (const [depApp, sql] of Object.entries(p.scenario.cleanup)) {
      const depVm = planned.find(d => d.scenario.application === depApp && d.skipExecution);
      if (depVm) {
        logInfo(`Cleanup SQL on ${depApp} (VM ${depVm.vmId}): ${sql}`);
        // Split into separate -c flags so DROP DATABASE doesn't run inside a transaction
        const sqlParts = sql.split(";").map(s => s.trim()).filter(Boolean);
        const cFlags = sqlParts.map(s => `-c ${JSON.stringify(s)}`).join(" ");
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct exec ${depVm.vmId} -- psql -U postgres ${cFlags}`,
          15000);
      }
    }
  }

  // Pre-create stacks: collect ALL stacktypes across all apps sharing a stack,
  // then create once — the server generates secrets for all stacktype variables.
  // If a stack already exists, reuse it to keep passwords stable across runs.
  const stackAllTypes = new Map<string, Set<string>>();
  for (const p of planned) {
    const rawStacktype = appStacktypes.get(p.scenario.application);
    const stacktypes = rawStacktype ? (Array.isArray(rawStacktype) ? rawStacktype : [rawStacktype]) : [];
    if (stacktypes.length === 0) continue;

    if (!stackAllTypes.has(p.stackName)) {
      stackAllTypes.set(p.stackName, new Set(stacktypes));
    } else {
      for (const st of stacktypes) {
        stackAllTypes.get(p.stackName)!.add(st);
      }
    }
  }

  // Only delete+recreate stacks whose ALL VMs are being destroyed (not reused)
  for (const [stackName, allTypes] of stackAllTypes) {
    const typesArray = [...allTypes];

    // Check if stack already exists
    let stackExists = false;
    try {
      const checkResp = await fetch(`${apiUrl}/api/stack/${stackName}`, {
        signal: AbortSignal.timeout(5000),
      });
      stackExists = checkResp.ok;
    } catch { /* ignore */ }

    if (stackExists) {
      // Check if all VMs using this stack are being re-executed (not reused)
      const stackVms = planned.filter(p => p.stackName === stackName);
      const allDestroyed = stackVms.every(p => !p.skipExecution);
      if (allDestroyed) {
        // All VMs destroyed — delete and recreate stack with fresh passwords
        try {
          await fetch(`${apiUrl}/api/stack/${stackName}`, {
            method: "DELETE", signal: AbortSignal.timeout(5000),
          });
        } catch { /* ignore */ }
        stackExists = false;
      } else {
        logOk(`Stack '${stackName}' exists — reusing (passwords unchanged)`);
      }
    }

    if (!stackExists) {
      try {
        const resp = await fetch(`${apiUrl}/api/stacks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: stackName,
            stacktype: typesArray.length === 1 ? typesArray[0] : typesArray,
            entries: [],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          logOk(`Stack '${stackName}' created (type: ${typesArray.join("+")})`);
        }
      } catch {
        // Stack creation failed — may already exist from concurrent run
      }
    }
  }

  // Execute scenarios sequentially (topologically sorted)
  const keepVm = !!process.env.KEEP_VM;
  const fixtureBaseDir = fixturesFlag
    ? path.join(projectRoot, "frontend/src/test-fixtures")
    : undefined;
  const resultWriter = new TestResultWriter(projectRoot, config.instance);
  const result = await executeScenarios(planned, config, apiUrl, veHost, projectRoot, appMetaMap, resultWriter, fixtureBaseDir);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Queue Worker Mode ──

interface QueueNextResponse {
  scenario?: ResolvedScenario;
  vmId?: number;
  hostname?: string;
  stackName?: string;
  wait?: boolean;
  done?: boolean;
}

async function runQueueWorker(
  config: ReturnType<typeof loadConfig>,
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
) {
  const workerId = `worker-${process.pid}`;
  logInfo(`Queue worker started: ${workerId}`);

  // Init queue (idempotent — only first worker actually initializes)
  try {
    await fetch(`${apiUrl}/api/test-queue/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err: any) {
    logFail(`Failed to init queue: ${err.message}`);
    process.exit(1);
  }

  const verifier = new Verifier(config.pveHost, config.portPveSsh, apiUrl, veHost);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "livetest-queue-"));
  let scenarioCount = 0;
  let failedCount = 0;

  try {
    // Worker loop
    while (true) {
      const resp = await fetch(
        `${apiUrl}/api/test-queue/next?workerId=${encodeURIComponent(workerId)}`,
        { signal: AbortSignal.timeout(10000) },
      );
      const data = await resp.json() as QueueNextResponse;

      if (data.done) {
        logInfo("Queue complete — no more scenarios.");
        break;
      }

      if (data.wait) {
        logInfo("Waiting for dependencies to complete...");
        await sleep(10000);
        continue;
      }

      const scenario = data.scenario!;
      const vmId = data.vmId!;
      const hostname = data.hostname!;
      const stackName = data.stackName!;
      const scenarioId = scenario.id;
      const task = scenario.task || "installation";
      scenarioCount++;

      logStep(workerId, `${scenarioId} (${task}) [VM ${vmId}]`);

      // Destroy any existing VM at this ID
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct stop ${vmId} 2>/dev/null || true; pct destroy ${vmId} --force --purge 2>/dev/null || true`,
        30000);

      // Clean volumes
      nestedSsh(config.pveHost, config.portPveSsh,
        `find /rpool/data -maxdepth 4 -type d -name ${JSON.stringify(hostname)} -path "*/volumes/*" -exec rm -rf {} + 2>/dev/null || true`,
        15000);

      // Build params
      const appMeta = appMetaMap.get(scenario.application) ?? {};
      const hasStacktype = !!appMeta.stacktype;
      const baseParams = [
        { name: "hostname", value: hostname },
        { name: "bridge", value: config.bridge },
        { name: "vm_id", value: String(vmId) },
      ];
      const templateVars: Record<string, string> = {
        vm_id: String(vmId),
        hostname,
        stack_name: stackName,
      };

      const buildResult = buildParams(scenario, baseParams, templateVars, tmpDir);

      // Resolve enum defaults (e.g. volume_storage) via API
      resolveVolumeStorage(config.pveHost, config.portPveSsh, buildResult.params);

      const allAddons = buildResult.selectedAddons ?? [];

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${scenarioCount}.json`);
      const paramsObj: Record<string, unknown> = {
        application: scenario.application,
        task,
        params: buildResult.params.map((p) => ({ name: p.name, value: p.value })),
      };
      if (allAddons.length > 0) paramsObj.selectedAddons = allAddons;
      if (buildResult.stackId) {
        paramsObj.stackId = buildResult.stackId;
      } else if (hasStacktype) {
        paramsObj.stackId = stackName;
      }
      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout,
      );

      if (cliResult.exitCode !== 0) {
        logFail(`Scenario failed: ${scenarioId}`);
        failedCount++;
        // Destroy failed container
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${vmId} 2>/dev/null || true; pct destroy ${vmId} --force --purge 2>/dev/null || true`,
          30000);
        await fetch(`${apiUrl}/api/test-queue/fail/${scenarioId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10000),
        });
        continue;
      }

      logOk(`Container created: VM_ID=${vmId}, hostname=${hostname}`);

      // Wait for services
      const waitSeconds = scenario.wait_seconds ?? appMeta.verification?.wait_seconds ?? 0;
      if (waitSeconds > 0) {
        await waitForServices(config.pveHost, config.portPveSsh, vmId, waitSeconds, { info: logInfo, ok: logOk, warn: logWarn });
      }

      // Verify
      const defaultVerify = buildDefaultVerify(scenario, appMeta);
      const finalVerify = { ...defaultVerify, ...(scenario.verify ?? {}) };
      for (const [k, v] of Object.entries(finalVerify)) {
        if (v === false) delete finalVerify[k];
      }
      logInfo("Verifying...");
      const prevFailed = verifier.failed;
      await verifier.runAll(vmId, hostname, finalVerify);

      if (verifier.failed > prevFailed) {
        failedCount++;
        await fetch(`${apiUrl}/api/test-queue/fail/${scenarioId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10000),
        });
      } else {
        await fetch(`${apiUrl}/api/test-queue/complete/${scenarioId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10000),
        });
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Summary
  console.log("");
  console.log(`${workerId}: ${scenarioCount} scenarios processed, ${failedCount} failed`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${NC}`, err.message || err);
  process.exit(1);
});
