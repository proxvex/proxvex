/**
 * Scenario execution engine for live integration tests.
 *
 * Runs planned scenarios sequentially: builds CLI parameters, executes the CLI,
 * verifies results, writes test results, and creates snapshots for dependencies.
 */

import { runCli } from "./cli-executor.mjs";
import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, waitForServices } from "./ssh-helpers.mjs";
import { buildParams, partitionAfterFailure } from "./scenario-planner.mjs";
import { TestResultWriter, type TestResultDependency } from "./test-result-writer.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario, TestResult } from "./livetest-types.mjs";
import { Verifier, apiFetch, buildDefaultVerify, type AppMeta } from "./verifier.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";
import { resolveVolumeStorage } from "./live-test-runner.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/** Find an existing managed container by application_id via the installations API */
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
  return containers.find((c) => c.application_id === applicationId)
    ?? (hostname ? containers.find((c) => c.hostname === hostname) : null)
    ?? containers.find((c) => c.hostname?.startsWith(`${applicationId}-`))
    ?? null;
}

export async function executeScenarios(
  planned: PlannedScenario[],
  config: {
    pveHost: string;
    vmId: number;
    portPveSsh: number;
    bridge: string;
    deployerUrl: string;
    snapshot?: { enabled: boolean };
  },
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
  allTests: Map<string, ResolvedScenario>,
  stackIdMap: Map<string, string[]>,
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

  // Build hash for snapshot invalidation
  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore */ }

  // Snapshot manager for creating dep snapshots after successful installation
  const allDepIds = new Set([...allTests.values()].flatMap((s) => s.depends_on ?? []));
  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  const snapMgr = config.snapshot?.enabled
    ? new SnapshotManager(config.pveHost, config.vmId, config.portPveSsh, (msg) => logInfo(msg), localContextPath)
    : null;

  const depsRestoredFromSnapshot = planned.some((p) => p.skipExecution && p.isDependency);

  // OIDC credentials for delegated access (loaded after Zitadel installation)
  let oidcCredentials: { issuerUrl: string; clientId: string; clientSecret: string } | undefined;

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

      // Skip dependencies restored from snapshot
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

      // Build params
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

      // For upgrade/reconfigure: find existing VM
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

      resolveVolumeStorage(config.pveHost, config.portPveSsh, buildResult.params);

      const allAddons = buildResult.selectedAddons ?? [];

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const paramsObj: Record<string, unknown> = {
        application: scenario.application,
        task,
        params: buildResult.params.map((p) => ({ name: p.name, value: p.value })),
      };

      if (allAddons.length > 0) paramsObj.selectedAddons = allAddons;
      if (isReplaceCt && existingVm?.addons && existingVm.addons.length > 0) {
        paramsObj.installedAddons = existingVm.addons;
        logInfo(`Installed addons: ${existingVm.addons.join(", ")}`);
      }
      if (buildResult.stackId) {
        paramsObj.stackId = buildResult.stackId;
      } else if (step.hasStacktype) {
        const appStackIds = stackIdMap.get(`${scenario.application}/${step.stackName}`);
        if (appStackIds && appStackIds.length > 1) {
          paramsObj.stackIds = appStackIds;
        } else if (appStackIds && appStackIds.length === 1) {
          paramsObj.stackId = appStackIds[0];
        }
      }

      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      if (allAddons.length > 0) logInfo(`Addons: ${allAddons.join(", ")}`);

      // Reload deployer
      try {
        const reloadResp = await fetch(`${apiUrl}/api/reload`, { method: "POST" });
        if (reloadResp.ok) logInfo("Deployer reloaded");
        else logInfo(`Deployer reload returned ${reloadResp.status} (continuing)`);
      } catch {
        logInfo("Deployer reload not available (continuing)");
      }

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const scenarioFixtureDir = fixtureBaseDir
        ? path.join(fixtureBaseDir, scenario.id.replace("/", "-"))
        : undefined;
      // Use OIDC credentials for scenarios with addon-oidc (delegated access)
      const useOidc = oidcCredentials && allAddons.includes("addon-oidc");
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout, scenarioFixtureDir,
        useOidc ? oidcCredentials : undefined,
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

        if (resultWriter) {
          resultWriter.write(TestResultWriter.buildResult({
            runId: resultWriter.getRunId(),
            scenarioId: scenario.id, application: scenario.application, task,
            status: "failed", vmId: step.vmId, hostname: step.hostname,
            stackName: step.stackName, addons: scenario.selectedAddons ?? [],
            startedAt: stepStartTime, finishedAt: new Date(),
            deployerVersion, deployerGitHash,
            dependencies: [], verifyResults: {}, errorMessage: errMsg,
          }));
        }

        // Partition remaining tests if dependency failed
        if (allDepIds.has(scenario.id)) {
          const remaining = planned.slice(i + 1);
          const allTestsMap = new Map(planned.map((p) => [p.scenario.id, p.scenario]));
          const { unaffected, blocked } = partitionAfterFailure(scenario.id, remaining, allTestsMap);

          if (unaffected.length > 0) {
            logInfo(`Dependency ${scenario.id} failed — running ${unaffected.length} unaffected test(s) first`);
            for (let u = 0; u < unaffected.length; u++) {
              planned[i + 1 + u] = unaffected[u]!;
            }
          }

          for (const b of blocked) {
            logWarn(`Skipping ${b.scenario.id} (blocked by failed dependency ${scenario.id})`);
            b.skipExecution = true;
            result.errors.push(`Skipped: ${b.scenario.id} (dependency ${scenario.id} failed)`);
          }

          for (let b = 0; b < blocked.length; b++) {
            planned[i + 1 + unaffected.length + b] = blocked[b]!;
          }
          continue;
        }

        break;
      }

      // For replace_ct: discover new VM ID
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

      // After Zitadel installation: load test-deployer credentials for OIDC addon
      if (scenario.application === "zitadel" && task === "installation" && !oidcCredentials) {
        try {
          const credJson = await nestedSsh(
            config.pveHost, config.portPveSsh,
            `pct exec ${step.vmId} -- cat /bootstrap/test-deployer.json`,
          );
          const creds = JSON.parse(credJson.trim());
          if (creds.client_id && creds.client_secret && creds.issuer_url) {
            oidcCredentials = {
              issuerUrl: creds.issuer_url,
              clientId: creds.client_id,
              clientSecret: creds.client_secret,
            };
            logOk("Test OIDC deployer credentials loaded from Zitadel bootstrap");
          }
        } catch {
          logInfo("No test-deployer.json found (OIDC delegated access not available)");
        }
      }

      // Wait for services
      const appMeta = appMetaMap.get(scenario.application) ?? {};
      const waitSeconds = scenario.wait_seconds ?? appMeta.verification?.wait_seconds ?? 0;
      if (waitSeconds > 0) {
        if (appMeta.extends === "docker-compose") {
          await waitForServices(config.pveHost, config.portPveSsh, step.vmId, waitSeconds, { info: logInfo, ok: logOk, warn: logWarn });
        } else {
          logInfo(`Waiting ${waitSeconds}s for container to be ready...`);
          await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        }
      }

      // Verify
      const defaultVerify = buildDefaultVerify(scenario, appMeta);
      const finalVerify = { ...defaultVerify, ...(scenario.verify ?? {}) };
      for (const [k, v] of Object.entries(finalVerify)) {
        if (v === false) delete finalVerify[k];
      }
      logInfo("Verifying...");
      await verifier.runAll(step.vmId, step.hostname, finalVerify, planned);

      // Write test result
      if (resultWriter) {
        const depInfos: TestResultDependency[] = (scenario.depends_on ?? []).map((depId) => {
          const depStep = planned.find((p) => p.scenario.id === depId);
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
            scenario_id: depId, vm_id: depStep?.vmId ?? 0,
            status: "passed" as const, version,
            snapshot_used: snapMgr?.snapshotName(depId) ?? null,
            snapshot_date: null,
          };
        });
        resultWriter.write(TestResultWriter.buildResult({
          runId: resultWriter.getRunId(),
          scenarioId: scenario.id, application: scenario.application, task,
          status: "passed", vmId: step.vmId, hostname: step.hostname,
          stackName: step.stackName, addons: scenario.selectedAddons ?? [],
          startedAt: stepStartTime, finishedAt: new Date(),
          deployerVersion, deployerGitHash,
          dependencies: depInfos,
          verifyResults: Object.fromEntries(
            Object.entries(finalVerify).map(([k, v]) => [k, !!v]),
          ),
        }));
      }

      // Create snapshot after dependency is installed
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
