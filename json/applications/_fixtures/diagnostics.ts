/**
 * Shared Playwright fixture: auto-attach container diagnostics on test failure.
 *
 * On any failing test, this fixture SSHs to the nested-VM PVE host (where
 * the application container actually runs) and pulls:
 *   - /var/log/lxc/<hostname>-<vmid>.log  → LXC console log
 *   - pct config <vmid>                   → container config (mp*, addons, …)
 *   - pct status <vmid>                   → current state
 *   - pct exec <vmid> -- journalctl -n 200 → in-container journal tail
 *   - pct exec <vmid> -- docker ps -a + docker logs (for docker-compose apps)
 *
 * Each artefact is attached to the failing test via `testInfo.attach()`, so
 * it shows up in the Playwright HTML report (and in the JSON reporter at
 * report.json under `attachments`). The HTML report can be opened with
 * `npx playwright show-report <report-dir>` or directly via the static
 * `index.html` produced under `playwright-report-html/`.
 *
 * Specs use this fixture by importing `{ test, expect }` from this file
 * instead of from `@playwright/test`:
 *
 *   import { test, expect } from "../../../_fixtures/diagnostics.js";
 *
 * The fixture is opt-in by import path — existing specs that don't import
 * it keep working unchanged.
 *
 * Env vars consumed (set by collectScenarioEnv in the livetest runner):
 *   - PVE_HOST          (e.g. ubuntupve)
 *   - PVE_SSH_PORT      (e.g. 1222 for yellow)
 *   - APP_HOSTNAME      (e.g. proxvex-default)
 *   - APP_VM_ID         (e.g. 239)
 *
 * When the env is missing (e.g. spec run stand-alone outside the runner),
 * the fixture logs a warning to stderr and skips collection — the test
 * itself is not impacted.
 */

import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";

export { expect };

interface DiagnosticsEnv {
  pveHost: string;
  pveSshPort: number;
  appHostname: string;
  appVmId: string;
}

function readDiagnosticsEnv(): DiagnosticsEnv | null {
  const pveHost = process.env.PVE_HOST;
  const pveSshPortRaw = process.env.PVE_SSH_PORT;
  const appHostname = process.env.APP_HOSTNAME;
  const appVmId = process.env.APP_VM_ID;
  if (!pveHost || !pveSshPortRaw || !appHostname || !appVmId) {
    return null;
  }
  const pveSshPort = Number(pveSshPortRaw);
  if (!Number.isFinite(pveSshPort) || pveSshPort <= 0) return null;
  return { pveHost, pveSshPort, appHostname, appVmId };
}

/**
 * Run a one-shot SSH command and return stdout. stderr is captured but only
 * surfaced in the returned text if the command exited non-zero (so an
 * "unknown command" or missing file shows up in the attachment instead of
 * silently producing an empty file).
 *
 * 15s timeout per command — these are read-only inspections; if the host
 * can't answer in 15s, something is very wrong and we don't want to delay
 * the whole afterEach by ssh's default ~2min connection timeout.
 */
async function sshCapture(
  env: DiagnosticsEnv,
  command: string,
  timeoutMs = 15000,
): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "LogLevel=ERROR",
        "-p", String(env.pveSshPort),
        `root@${env.pveHost}`,
        command,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(`[diagnostics] command timed out after ${timeoutMs}ms: ${command}\n${stdout}\n--- stderr ---\n${stderr}`);
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        resolve(
          `[diagnostics] exit=${code} for: ${command}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(`[diagnostics] spawn error: ${err.message}\n${stderr}`);
    });
  });
}

/**
 * Auto-fixture pattern (option C): a worker-level fixture with `{ auto: true }`
 * runs for every test in any spec that imports this `test` symbol. Code after
 * `await use()` is the teardown — perfect spot to inspect `testInfo.status`
 * and attach diagnostics. Module-scope `test.afterEach()` would also work
 * INSIDE a spec but throws "did not expect afterEach() to be called here"
 * when invoked at top-level of an imported helper, which makes shared
 * fixtures impossible — auto-fixtures sidestep that.
 *
 *   • status === "failed" | "timedOut" → collect + attach diagnostics
 *   • status === "passed" | "skipped"  → no-op (keeps reports lean)
 *
 * Attachments use `text/plain` so the HTML report's preview pane shows the
 * content inline; binary content (none currently) would use
 * `application/octet-stream`.
 */
type DiagnosticsFixtures = {
  _autoCollectDiagnostics: void;
};

export const test = base.extend<DiagnosticsFixtures>({
  _autoCollectDiagnostics: [
    async ({}, use, testInfo) => {
      await use();

      if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;

      const env = readDiagnosticsEnv();
      if (!env) {
        testInfo.annotations.push({
          type: "diagnostics-skipped",
          description:
            "PVE_HOST / PVE_SSH_PORT / APP_HOSTNAME / APP_VM_ID env not all set — running outside the livetest runner?",
        });
        return;
      }

      const probes: Array<{ name: string; cmd: string }> = [
        {
          name: "01-lxc-console.log",
          cmd: `cat /var/log/lxc/${env.appHostname}-${env.appVmId}.log 2>&1 || echo '[no lxc log for ${env.appHostname}-${env.appVmId}]'`,
        },
        {
          name: "02-pct-config.txt",
          cmd: `pct config ${env.appVmId} 2>&1 || echo '[pct config failed for ${env.appVmId}]'`,
        },
        {
          name: "03-pct-status.txt",
          cmd: `pct status ${env.appVmId} 2>&1; echo '---'; pct list | head -20`,
        },
        {
          name: "04-journal-tail.txt",
          cmd: `pct exec ${env.appVmId} -- journalctl --no-pager -n 200 2>&1 || echo '[no journal — container down or no journald]'`,
        },
        {
          name: "05-docker-ps.txt",
          cmd: `pct exec ${env.appVmId} -- sh -c 'docker ps -a 2>&1 || echo "[no docker in container]"' 2>&1`,
        },
        {
          name: "06-docker-logs.txt",
          cmd:
            `pct exec ${env.appVmId} -- sh -c '` +
            `for c in $(docker ps --format "{{.Names}}" 2>/dev/null); do ` +
            `echo "=== $c (last 100) ==="; docker logs --tail 100 "$c" 2>&1 | head -200; ` +
            `done || echo "[docker logs unavailable]"' 2>&1`,
        },
        {
          name: "07-dmesg-tail.txt",
          cmd: `dmesg | tail -50 2>&1`,
        },
      ];

      await Promise.all(
        probes.map(async ({ name, cmd }) => {
          const body = await sshCapture(env, cmd);
          await testInfo.attach(name, { body, contentType: "text/plain" });
        }),
      );

      // A single index attachment that makes it obvious in the HTML report
      // which container was inspected — the test title alone may not carry
      // that info.
      await testInfo.attach("00-diagnostics-index.txt", {
        body:
          `Container diagnostics for failed test\n` +
          `  hostname:    ${env.appHostname}\n` +
          `  vm_id:       ${env.appVmId}\n` +
          `  pve_host:    ${env.pveHost}:${env.pveSshPort}\n` +
          `  test:        ${testInfo.title}\n` +
          `  status:      ${testInfo.status}\n` +
          `\nAttached files:\n` +
          probes.map((p) => `  - ${p.name}`).join("\n") +
          `\n`,
        contentType: "text/plain",
      });
    },
    { auto: true },
  ],
});
