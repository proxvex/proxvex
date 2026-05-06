/**
 * Parallel queue worker mode for live integration tests.
 *
 * Fetches scenarios from the deployer's test-queue API and executes them
 * one by one. Multiple workers can run in parallel on different machines.
 */

import { runCli } from "./cli-executor.mjs";
import { nestedSsh, waitForServices } from "./ssh-helpers.mjs";
import { buildParams } from "./scenario-planner.mjs";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedScenario } from "./livetest-types.mjs";
import { Verifier, buildDefaultVerify, type AppMeta } from "./verifier.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";

interface QueueNextResponse {
  scenario?: ResolvedScenario;
  vmId?: number;
  hostname?: string;
  stackName?: string;
  wait?: boolean;
  done?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runQueueWorker(
  config: {
    pveHost: string;
    portPveSsh: number;
    bridge: string;
  },
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
  resolveVolumeStorage: (pveHost: string, sshPort: number, params: { name: string; value: string }[]) => void,
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
      // Hidden apps (proxmox host reconfigure) target the PVE host itself.
      // Substitute the real PVE short hostname so backend cert-signing matches
      // the actual web UI hostname instead of the runner-derived variant name.
      const isHiddenApp = !appMetaMap.has(scenario.application);
      let effectiveHostname = hostname;
      if (isHiddenApp) {
        try {
          effectiveHostname = nestedSsh(
            config.pveHost, config.portPveSsh,
            "uname -n | cut -d. -f1",
            5000,
          ).trim() || hostname;
        } catch { /* fall back */ }
      }
      const baseParams = [
        { name: "hostname", value: effectiveHostname },
        { name: "bridge", value: config.bridge },
        { name: "vm_id", value: String(vmId) },
      ];
      const stacktypesArr = appMeta.stacktype
        ? (Array.isArray(appMeta.stacktype) ? appMeta.stacktype : [appMeta.stacktype])
        : [];
      const primaryStackId = stacktypesArr.length > 0 ? `${stacktypesArr[0]}_${stackName}` : stackName;
      const templateVars: Record<string, string> = {
        vm_id: String(vmId),
        hostname,
        stack_id: primaryStackId,
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
        const stacktypes = Array.isArray(appMeta.stacktype) ? appMeta.stacktype : [appMeta.stacktype];
        const ids = stacktypes.map(st => `${st}_${stackName}`);
        if (ids.length > 1) {
          paramsObj.stackIds = ids;
        } else if (ids.length === 1) {
          paramsObj.stackId = ids[0];
        }
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
