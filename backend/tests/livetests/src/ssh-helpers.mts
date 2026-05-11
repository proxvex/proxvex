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
 * Wait until `pct exec <vmId> -- /bin/true` succeeds — i.e. the LXC's init
 * (PID 1) is responsive enough for lxc-attach calls to land. `pct status:
 * running` flips as soon as the engine has spawned the container, but cgroup
 * setup, namespace mounts and init-process boot can take several more seconds.
 * Any pipeline step that immediately does `lxc-attach` after the engine
 * reports "running" hits a window where the call returns
 *   "lxc-attach: 406 Connection refused - Failed to get init pid"
 *
 * Symptom in the wild: upgrade scenarios use `replace_ct` (stop old, start
 * new with same VMID). The runner declares "Container ready" the moment
 * `pct status` returns "running"; if the very next scenario (or the very
 * next pipeline step inside the same scenario, e.g. docker-compose's
 * `012-host-docker-pull-in-existing` in the `image:` phase of reconfigure)
 * runs `lxc-attach <vmId>`, it races the still-initialising init and fails.
 *
 * Returns `{ ok: true, waitedMs }` on first successful exec, or `{ ok:
 * false, lastError, waitedMs }` after `maxWaitSeconds` of nothing. Caller
 * decides whether to fail the scenario or continue with a warning.
 */
export async function waitForLxcInit(
  pveHost: string,
  sshPort: number,
  vmId: number,
  maxWaitSeconds: number = 30,
  pollIntervalMs: number = 1000,
): Promise<{ ok: true; waitedMs: number } | { ok: false; lastError: string; waitedMs: number }> {
  const start = Date.now();
  const deadline = start + maxWaitSeconds * 1000;
  let lastError = "";
  while (true) {
    try {
      // /bin/true is the cheapest possible attach: nothing to read, no
      // syscalls beyond exec/exit. If it returns 0, init is responsive.
      nestedSsh(pveHost, sshPort,
        `pct exec ${vmId} -- /bin/true 2>&1`, 10000);
      return { ok: true, waitedMs: Date.now() - start };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Common transient signals while init is starting:
      //   "Failed to get init pid" — cgroup not ready
      //   "Connection refused"     — same root cause, different wording
      //   "Configuration file ... does not exist" — container being recreated
      // All retried; only a deadline miss surfaces.
    }
    if (Date.now() >= deadline) {
      return { ok: false, lastError, waitedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
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
