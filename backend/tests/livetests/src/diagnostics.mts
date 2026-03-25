/**
 * Diagnostics collection for live integration tests.
 * Gathers container logs, configs, and docker state after test runs.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nestedSsh } from "./ssh-helpers.mjs";
import { logWarn } from "./log-helpers.mjs";
import type { TestResult } from "./livetest-types.mjs";

export function collectDiagnostics(
  results: TestResult[],
  pveHost: string,
  sshPort: number,
  projectRoot: string,
): string | null {
  const allSteps = results.flatMap((r) => r.steps);
  if (allSteps.length === 0) return null;

  const diagDir = mkdtempSync(path.join(tmpdir(), "livetest-diag-"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  for (const step of allSteps) {
    const stepDir = path.join(diagDir, `${step.vmId}-${step.application}`);
    mkdirSync(stepDir, { recursive: true });

    // Save CLI output
    if (step.cliOutput) {
      writeFileSync(path.join(stepDir, "cli-output.log"), step.cliOutput);
    }

    // Collect LXC config
    const lxcConf = nestedSsh(pveHost, sshPort,
      `cat /etc/pve/lxc/${step.vmId}.conf 2>/dev/null || echo '[not found]'`, 10000);
    if (lxcConf) {
      writeFileSync(path.join(stepDir, "lxc.conf"), lxcConf);
    }

    // Collect LXC log
    const lxcLog = nestedSsh(pveHost, sshPort,
      `cat /var/log/lxc/${step.hostname}-${step.vmId}.log 2>/dev/null || echo '[not found]'`, 10000);
    if (lxcLog) {
      writeFileSync(path.join(stepDir, "lxc.log"), lxcLog);
    }

    // Collect docker ps
    const dockerPs = nestedSsh(pveHost, sshPort,
      `pct exec ${step.vmId} -- docker ps -a 2>/dev/null || echo '[not available]'`, 10000);
    if (dockerPs) {
      writeFileSync(path.join(stepDir, "docker-ps.txt"), dockerPs);
    }

    // Collect docker compose file
    const composeFile = nestedSsh(pveHost, sshPort,
      `pct exec ${step.vmId} -- cat /opt/docker-compose.yml 2>/dev/null || ` +
      `pct exec ${step.vmId} -- cat /opt/docker-compose.yaml 2>/dev/null || echo '[not found]'`, 10000);
    if (composeFile) {
      writeFileSync(path.join(stepDir, "docker-compose.yml"), composeFile);
    }

    // Collect docker logs (last 200 lines per container)
    const containerNames = nestedSsh(pveHost, sshPort,
      `pct exec ${step.vmId} -- docker ps -a --format '{{.Names}}' 2>/dev/null || true`, 10000);
    if (containerNames) {
      for (const name of containerNames.split("\n").filter(Boolean)) {
        const logs = nestedSsh(pveHost, sshPort,
          `pct exec ${step.vmId} -- docker logs --tail 200 ${name} 2>&1 || true`, 15000);
        if (logs) {
          writeFileSync(path.join(stepDir, `docker-${name}.log`), logs);
        }
      }
    }
  }

  // Save test summary
  const summary = results.map((r) => ({
    name: r.name,
    passed: r.passed,
    failed: r.failed,
    errors: r.errors,
    steps: r.steps.map((s) => ({ vmId: s.vmId, hostname: s.hostname, application: s.application, scenarioId: s.scenarioId })),
  }));
  writeFileSync(path.join(diagDir, "summary.json"), JSON.stringify(summary, null, 2));

  // Create tar.gz
  const archiveName = `livetest-diag-${timestamp}.tar.gz`;
  const archivePath = path.join(projectRoot, archiveName);
  try {
    execSync(`tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(path.dirname(diagDir))} ${JSON.stringify(path.basename(diagDir))}`, {
      timeout: 30000,
    });
    rmSync(diagDir, { recursive: true, force: true });
    return archivePath;
  } catch {
    logWarn(`Failed to create diagnostic archive, files remain in ${diagDir}`);
    return diagDir;
  }
}
