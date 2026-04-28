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
import { collectFailureLogs } from "./diagnostics.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedScenario, PlannedScenario, TestResult } from "./livetest-types.mjs";
import { Verifier, buildDefaultVerify, type AppMeta } from "./verifier.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";
import { resolveVolumeStorage } from "./live-test-runner.mjs";
import { checkVolumeConsistency } from "./volume-consistency-check.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

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
): Promise<{ vm_id: number; addons?: string[] } | null> {
  // Scan PVE host directly for running managed containers.
  // More reliable than deployer context which may be stale after rollbacks.
  try {
    const pctList = nestedSsh(pveHost, sshPort,
      `pct list 2>/dev/null | tail -n +2 | awk '{print $1}'`, 10000);
    let firstAppMatch: { vm_id: number; addons?: string[] } | null = null;
    for (const line of pctList.split("\n")) {
      const vmId = parseInt(line.trim(), 10);
      if (isNaN(vmId)) continue;
      try {
        const conf = nestedSsh(pveHost, sshPort,
          `pct config ${vmId} 2>/dev/null | head -40`, 5000);
        if (!conf.includes("proxvex") || !conf.includes("managed")) continue;
        const appMatch = conf.match(/application-id\s+(\S+)/);
        const appId = appMatch?.[1]?.replace(/%20/g, " ");
        if (appId !== applicationId) continue;
        const addonMatches = conf.matchAll(/addon\s+(\S+)/g);
        const addons = [...addonMatches].map(m => m[1]!).filter(Boolean);
        const result = { vm_id: vmId, addons: addons.length > 0 ? addons : undefined };
        if (expectedHostname) {
          const hostMatch = conf.match(/^hostname:\s*(\S+)/m);
          if (hostMatch?.[1] === expectedHostname) return result;
          if (!firstAppMatch) firstAppMatch = result;
          continue;
        }
        return result;
      } catch { continue; }
    }
    if (firstAppMatch) return firstAppMatch;
  } catch { /* ignore */ }
  return null;
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
    portForwarding?: Array<{ port: number; hostname: string; ip: string; containerPort: number }>;
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

  // Snapshot manager for the single dep-stacks-ready snapshot.
  // Provider/consumer distinction comes from `step.isDependency` set by the
  // planner (planned[].isDependency = true if not in selectedIdSet).
  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  const snapMgr = config.snapshot?.enabled
    ? new SnapshotManager(config.pveHost, config.vmId, config.portPveSsh, (msg) => logInfo(msg), localContextPath)
    : null;

  // OIDC credentials for delegated access (loaded after Zitadel installation)
  // Only used if the deployer itself has OIDC enabled (not for app-level OIDC addons)
  let oidcCredentials: { issuerUrl: string; clientId: string; clientSecret: string } | undefined;
  let deployerOidcEnabled = false;
  try {
    const authResp = await fetch(`${apiUrl}/api/auth/config`, { signal: AbortSignal.timeout(3000) });
    if (authResp.ok) {
      const authConfig = await authResp.json() as { enabled?: boolean };
      deployerOidcEnabled = !!authConfig.enabled;
    }
  } catch { /* deployer has no OIDC */ }

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

      // Skip dependencies that were restored from snapshot or are already running
      if (step.skipExecution) {
        logOk(`Skipping ${scenario.id} (${step.isDependency ? "restored from snapshot" : "already running"})`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        continue;
      }

      // Build params.
      // Note: `bridge` is the *container* bridge inside the nested VM, which is
      // always "vmbr1" (created by step1). config.bridge is the host-PVE-side
      // bridge of the outer VM (vmbr1/2/3 depending on instance) and is NOT
      // the same thing.
      const isReplaceCt = REPLACE_CT_TASKS.includes(task);
      const baseParams = [
        { name: "hostname", value: step.hostname },
        { name: "bridge", value: "vmbr1" },
        ...(!isReplaceCt ? [{ name: "vm_id", value: String(step.vmId) }] : []),
        ...(isReplaceCt ? [{ name: "vm_id_start", value: String(step.vmId) }] : []),
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

      // For upgrade/reconfigure: find existing VM. Prefer a same-application
      // dependency declared in `depends_on` (e.g. nginx/reconf-addons-on
      // explicitly clones from nginx/default — without this, when multiple
      // siblings exist, findExistingVm picked the lowest VMID and cloned the
      // wrong container).
      let existingVm: { vm_id: number; addons?: string[] } | null = null;
      if (isReplaceCt) {
        if (scenario.depends_on) {
          for (const depId of scenario.depends_on) {
            const depStep = planned.find((p) => p.scenario.id === depId);
            if (depStep && depStep.scenario.application === scenario.application) {
              existingVm = { vm_id: depStep.vmId };
              logInfo(`Using depended-on VM ${depStep.vmId} for ${task} (from ${depId})`);
              break;
            }
          }
        }
        if (!existingVm) {
          // Pre-replace lookup: the source container should match the
          // scenario's hostname before reconfigure runs.
          existingVm = await findExistingVm(apiUrl, veHost, scenario.application, config.pveHost, config.portPveSsh, step.hostname);
        }
        if (!existingVm) {
          const errMsg = `No existing VM found for ${scenario.application} — cannot ${task}`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          // Skip this scenario but keep running the rest of the --all plan.
          // Aborting here (via `break`) hid many passable scenarios whenever
          // a reconfigure/upgrade task's live dependency VM had already been
          // torn down by a previous scenario's cleanup.
          continue;
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

      // Reload deployer
      try {
        const reloadResp = await fetch(`${apiUrl}/api/reload`, { method: "POST" });
        if (reloadResp.ok) logInfo("Deployer reloaded");
        else logInfo(`Deployer reload returned ${reloadResp.status} (continuing)`);
      } catch {
        logInfo("Deployer reload not available (continuing)");
      }

      // No pre-test snapshot — failure rollback uses the single
      // dep-stacks-ready host snapshot (created once after all providers).

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const scenarioFixtureDir = fixtureBaseDir
        ? path.join(fixtureBaseDir, scenario.id.replace("/", "-"))
        : undefined;
      // Use OIDC credentials only if the deployer itself requires OIDC auth
      const useOidc = deployerOidcEnabled && oidcCredentials;
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout, scenarioFixtureDir,
        useOidc ? oidcCredentials : undefined,
      );

      if (cliResult.exitCode !== 0) {
        const errMsg = `Scenario failed: ${scenario.id} (${task})`;
        logFail(errMsg);

        // Collect failure logs BEFORE rollback (VM still in broken state)
        const failureLogs = collectFailureLogs(
          config.pveHost, config.portPveSsh,
          step.vmId, step.hostname, cliResult.output,
        );

        // Rollback to dep-stacks-ready (atomic whole-VM snapshot on host PVE)
        // to restore consistent state across all stack-provider LXCs and the
        // nested-VM host FS (storagecontext-backup, deployer-context, etc.).
        // Skipped if no providers were planned (no dep-stacks-ready snapshot).
        // KEEP_VM also skips the rollback so the failed LXC stays available
        // for inspection (rollback would destroy it atomically).
        const keepForDebug = !!process.env.KEEP_VM;
        if (keepForDebug) {
          logInfo(`KEEP_VM set — skipping rollback to dep-stacks-ready (failed VM ${step.vmId} preserved for inspection)`);
        }
        if (snapMgr && !step.isDependency && !keepForDebug && snapMgr.exists("dep-stacks-ready")) {
          try {
            snapMgr.rollbackHostSnapshot("dep-stacks-ready");
            checkVolumeConsistency(
              config.pveHost, config.portPveSsh, projectRoot,
              `rollback to dep-stacks-ready`,
            );
          } catch (err) {
            logInfo(`Warning: rollback to dep-stacks-ready failed: ${err}`);
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
          resultWriter.write(TestResultWriter.buildResult({
            runId: resultWriter.getRunId(),
            scenarioId: scenario.id, application: scenario.application, task,
            status: "failed", vmId: step.vmId, hostname: step.hostname,
            stackName: step.stackName, addons: scenario.selectedAddons ?? [],
            startedAt: stepStartTime, finishedAt: new Date(),
            deployerVersion, deployerGitHash,
            commandLine: resultWriter.getCommandLine(),
            dependencies: [], verifyResults: {}, errorMessage: errMsg,
            logs: failureLogs,
          }));
        }

        // Partition remaining tests: skip those that depend on the failed scenario
        const remaining = planned.slice(i + 1);
        const allTestsMap = new Map(planned.map((p) => [p.scenario.id, p.scenario]));
        const { unaffected, blocked } = partitionAfterFailure(scenario.id, remaining, allTestsMap);

        if (unaffected.length > 0 && blocked.length > 0) {
          logInfo(`${scenario.id} failed — running ${unaffected.length} unaffected test(s), skipping ${blocked.length} blocked`);
          for (let u = 0; u < unaffected.length; u++) {
            planned[i + 1 + u] = unaffected[u]!;
          }
          for (let b = 0; b < blocked.length; b++) {
            planned[i + 1 + unaffected.length + b] = blocked[b]!;
          }
        }

        for (const b of blocked) {
          logWarn(`Skipping ${b.scenario.id} (blocked by failed dependency ${scenario.id})`);
          b.skipExecution = true;
          result.errors.push(`Skipped: ${b.scenario.id} (dependency ${scenario.id} failed)`);
        }

        continue;
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
            let issuerUrl = creds.issuer_url as string;
            // Rewrite issuer URL for external access via port forwarding
            // e.g. http://zitadel-default:8080 -> http://ubuntupve:1808
            const portFwd = (config as any).portForwarding as Array<{ port: number; hostname: string; ip: string; containerPort: number }> | undefined;
            if (portFwd) {
              for (const fwd of portFwd) {
                if (issuerUrl.includes(fwd.hostname)) {
                  issuerUrl = issuerUrl.replace(
                    new RegExp(`${fwd.hostname}(:\\d+)?`),
                    `${config.pveHost}:${fwd.port}`,
                  );
                  logInfo(`Rewritten OIDC issuer URL for external access: ${issuerUrl}`);
                  break;
                }
              }
            }
            oidcCredentials = {
              issuerUrl,
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
                `sed -n 's/.*proxvex%3Aversion \\([^ <]*\\).*/\\1/p' /etc/pve/lxc/${depStep.vmId}.conf 2>/dev/null | head -1`,
                5000);
              version = decodeURIComponent(raw.trim());
            } catch { /* ignore */ }
          }
          return {
            scenario_id: depId, vm_id: depStep?.vmId ?? 0,
            status: "passed" as const, version,
            snapshot_used: snapMgr ? "dep-stacks-ready" : null,
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
          commandLine: resultWriter.getCommandLine(),
          dependencies: depInfos,
          verifyResults: Object.fromEntries(
            Object.entries(finalVerify).map(([k, v]) => [k, !!v]),
          ),
        }));
      }

      // Consumer-test success: destroy the consumer LXC. Provider LXCs stay
      // alive for subsequent consumer tests. Test-level cleanup (e.g. dropping
      // a database in postgres) is handled separately via test.json `cleanup`.
      if (snapMgr && !step.isDependency && !step.skipExecution) {
        try {
          nestedSsh(config.pveHost, config.portPveSsh,
            `pct stop ${step.vmId} 2>/dev/null; pct destroy ${step.vmId} --force --purge 2>/dev/null; true`,
            30000);
        } catch { /* ignore */ }
      }

      // After the LAST stack-provider step, create the single dep-stacks-ready
      // snapshot on the host PVE. All subsequent consumer tests use this as
      // their failure-rollback target.
      if (snapMgr && step.isDependency && !step.skipExecution
          && planned.slice(i + 1).every((p) => !p.isDependency)) {
        try {
          snapMgr.createHostSnapshot("dep-stacks-ready", buildHash);
        } catch (err) {
          logInfo(`Snapshot creation failed (non-fatal): ${err}`);
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
