/**
 * SSH helper functions for the live integration test runner.
 *
 * Provides functions to execute commands on the PVE host via SSH,
 * and to wait for docker services inside containers.
 */

import { execSync } from "node:child_process";

/**
 * Execute an SSH command on the PVE host.
 * Throws on failure (non-zero exit code or timeout).
 *
 * If `stdin` is provided, it is piped to the remote command's standard input.
 * This is used e.g. by the volume consistency check, which streams a
 * concatenated script (libraries + check) to `sh -s` on the host.
 */
export function nestedSshStrict(
  pveHost: string,
  port: number,
  command: string,
  timeoutMs = 15000,
  stdin?: string,
): string {
  const result = execSync(
    `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
    `-o BatchMode=yes -o ConnectTimeout=10 ` +
    `-p ${port} root@${pveHost} ${JSON.stringify(command)}`,
    {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(stdin !== undefined ? { input: stdin } : {}),
    },
  );
  return result.trim();
}

/**
 * Execute an SSH command on the PVE host.
 * Returns empty string on failure (swallows errors).
 */
export function nestedSsh(
  pveHost: string,
  port: number,
  command: string,
  timeoutMs = 15000,
): string {
  try {
    return nestedSshStrict(pveHost, port, command, timeoutMs);
  } catch {
    return "";
  }
}

/**
 * Wait for all docker services in a container to report "Up" status.
 * Polls every 5 seconds until all services are up or the deadline is reached.
 */
export async function waitForServices(
  pveHost: string,
  sshPort: number,
  vmId: number,
  maxWait: number,
  log: {
    info: (msg: string) => void;
    ok: (msg: string) => void;
    warn: (msg: string) => void;
  },
): Promise<void> {
  log.info(`Waiting for docker services (max ${maxWait}s)...`);
  const deadline = Date.now() + maxWait * 1000;

  while (Date.now() < deadline) {
    const output = nestedSsh(pveHost, sshPort,
      `pct exec ${vmId} -- docker ps --format '{{.Status}}'`);
    if (output) {
      const lines = output.split("\n").filter(Boolean);
      const allUp = lines.every((l) => l.includes("Up"));
      if (allUp && lines.length > 0) {
        const elapsed = Math.round((Date.now() + maxWait * 1000 - deadline) / 1000);
        log.ok(`Docker services ready after ~${elapsed}s`);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  log.warn(`Docker services not fully ready after ${maxWait}s`);
}

/**
 * Poll `pct status` over `maxWait` seconds and return early if the LXC
 * container leaves the `running` state (crashed, stopped, or vanished).
 *
 * The install-pipeline check `900-host-check-container.json` only samples
 * once near the end of the install — it cannot catch crashes that happen
 * *after* the installer has exited (e.g. postgres PANIC during initdb when
 * the data volume is too small). This polling fills the gap during the
 * test runner's `wait_seconds` window.
 *
 * Returns `{ ok: true }` when the container stayed `running` for the full
 * window, or `{ ok: false, status }` on the first non-running observation.
 * Transient SSH errors are swallowed (treated as "still running").
 */
export async function waitForContainerStable(
  pveHost: string,
  sshPort: number,
  vmId: number,
  maxWait: number,
  pollInterval: number = 5,
): Promise<{ ok: true } | { ok: false; status: string }> {
  const deadline = Date.now() + maxWait * 1000;
  while (true) {
    let status = "";
    try {
      status = nestedSsh(pveHost, sshPort,
        `pct status ${vmId} 2>/dev/null || echo "missing"`, 10000).trim();
      if (status && !status.includes("running")) {
        return { ok: false, status };
      }
    } catch {
      // Transient SSH error — assume still running, try again next tick
    }
    if (Date.now() >= deadline) return { ok: true };
    const remainingMs = deadline - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(pollInterval * 1000, remainingMs)));
  }
}
