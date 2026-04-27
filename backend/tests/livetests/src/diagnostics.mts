/**
 * Failure log collection for live integration tests.
 *
 * Called from the scenario executor on failure, BEFORE any rollback runs — so
 * we capture the broken state, not the restored one. Produces compact summaries
 * (error lines + tail) that get embedded into the per-scenario result JSON.
 *
 * Sources gathered (best-effort, each step skipped silently if unavailable):
 *   1. cli-output             — stdout (and stderr on failure) of the CLI run
 *   2. pct-status             — `pct status <vmid>` to confirm container exists
 *   3. lxc                    — /var/log/lxc/<hostname>-<vmid>.log start log
 *   4. lxc-conf               — /etc/pve/lxc/<vmid>.conf for config diagnosis
 *   5. journal                — `journalctl --no-pager -n 200` inside the LXC
 *   6. docker-ps              — `docker ps -a` (running + stopped containers)
 *   7. docker-compose-<proj>  — `docker compose -p <proj> logs --tail 300`
 *   8. docker-<container>     — `docker logs --tail 200 <container>` per ctr
 *   9. docker-inspect-<ctr>   — exit code + state for each non-running container
 */

import { nestedSsh } from "./ssh-helpers.mjs";

export interface LogSummary {
  name: string;
  errors: string[];
  last_lines: string[];
}

const MAX_ERRORS = 50;
const MAX_LINE_CHARS = 500;
const ERROR_PATTERN = /\b(error|err|fail|failed|failure|fatal|panic|exception|denied|refused|cannot|not found|unable|undefined|invalid|timeout|timed out)\b/i;

function trim(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}...[truncated]`
    : line;
}

function summarizeLog(name: string, content: string, tail = 15): LogSummary {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const errors = lines.filter((l) => ERROR_PATTERN.test(l)).slice(0, MAX_ERRORS).map(trim);
  const last_lines = lines.slice(-tail).map(trim);
  return { name, errors, last_lines };
}

function pushIfContent(logs: LogSummary[], name: string, content: string, tail = 15): void {
  if (content && content.trim()) {
    logs.push(summarizeLog(name, content, tail));
  }
}

function safeNestedSsh(
  pveHost: string, sshPort: number, cmd: string, timeoutMs = 10000,
): string {
  try {
    return nestedSsh(pveHost, sshPort, cmd, timeoutMs);
  } catch {
    return "";
  }
}

/**
 * Run a single diagnostic step and swallow any error so one broken step
 * cannot abort the rest of collection. Errors are recorded as a log entry
 * named `diag-error-<step>` so we can see them in the result file.
 */
function safeStep(logs: LogSummary[], step: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    logs.push({ name: `diag-error-${step}`, errors: [msg.slice(0, 500)], last_lines: [] });
  }
}

export function collectFailureLogs(
  pveHost: string,
  sshPort: number,
  vmId: number,
  hostname: string,
  cliOutput: string | undefined,
): LogSummary[] {
  const logs: LogSummary[] = [];

  // 1. CLI output (always present in some form on real failures now that
  //    cli-executor appends stderr on non-zero exit).
  safeStep(logs, "cli-output", () => {
    pushIfContent(logs, "cli-output", cliOutput ?? "", 20);
  });

  // 2. Container existence — without this, every later step returns empty
  //    and we lose the cause.
  let pctStatus = "";
  safeStep(logs, "pct-status", () => {
    pctStatus = safeNestedSsh(pveHost, sshPort,
      `pct status ${vmId} 2>&1; echo '---'; pct config ${vmId} 2>&1 | head -50`,
      8000,
    );
    pushIfContent(logs, "pct-status", pctStatus, 25);
  });

  const containerExists = !/does not exist/i.test(pctStatus) && pctStatus.trim() !== "";

  // 3. LXC start log — reveals startup-phase failures (mount, idmap, etc.)
  if (containerExists) {
    safeStep(logs, "lxc", () => {
      const lxcLog = safeNestedSsh(pveHost, sshPort,
        `cat /var/log/lxc/${hostname}-${vmId}.log 2>/dev/null `
        + `|| cat /var/log/lxc/${vmId}.log 2>/dev/null `
        + `|| true`,
        8000,
      );
      pushIfContent(logs, "lxc", lxcLog, 20);
    });

    // 4. LXC config — for "bridge missing", "idmap broken", "mountpoint
    //    misconfigured" type failures.
    safeStep(logs, "lxc-conf", () => {
      const lxcConf = safeNestedSsh(pveHost, sshPort,
        `cat /etc/pve/lxc/${vmId}.conf 2>/dev/null || true`,
        5000,
      );
      pushIfContent(logs, "lxc-conf", lxcConf, 80);
    });
  }

  // From here on, everything requires `pct exec` to work — i.e. container
  // must be running. Bail early if not.
  const isRunning = /status:\s*running/i.test(pctStatus);
  if (!containerExists || !isRunning) {
    return logs;
  }

  // 5. systemd journal inside the LXC — covers cases where docker daemon
  //    didn't even come up, or the compose unit failed before any container
  //    was created.
  safeStep(logs, "journal", () => {
    const journal = safeNestedSsh(pveHost, sshPort,
      `pct exec ${vmId} -- journalctl --no-pager -n 200 2>/dev/null || true`,
      15000,
    );
    pushIfContent(logs, "journal", journal, 30);
  });

  // 6. docker ps -a — includes Created/Exited containers, not just running.
  let containerLines: string[] = [];
  let containerNames: string[] = [];
  safeStep(logs, "docker-ps", () => {
    const containersRaw = safeNestedSsh(pveHost, sshPort,
      `pct exec ${vmId} -- docker ps -a --format '{{.Names}}\\t{{.Status}}' 2>/dev/null || true`,
      10000,
    );
    pushIfContent(logs, "docker-ps", containersRaw, 30);
    containerLines = containersRaw.split("\n").map((l) => l.trim()).filter(Boolean);
    containerNames = containerLines.map((l) => l.split("\t")[0] ?? "").filter(Boolean);
  });

  // 7. docker compose: per project we want (a) the source compose file(s) as
  //    rendered by the deployer, (b) the resolved config docker actually used,
  //    and (c) the multiplexed logs across all services. Source + resolved
  //    compose are critical when "everything looks fine in proxvex" but the
  //    container behaves differently — they reveal substitution mismatches.
  safeStep(logs, "docker-compose", () => {
    const composeProjects = safeNestedSsh(pveHost, sshPort,
      `pct exec ${vmId} -- docker compose ls --all --format json 2>/dev/null || true`,
      10000,
    );
    if (!composeProjects || !composeProjects.trim().startsWith("[")) return;
    let parsed: Array<{ Name?: string; ConfigFiles?: string }> = [];
    try {
      parsed = JSON.parse(composeProjects);
    } catch {
      return;
    }
    for (const p of parsed) {
      if (!p.Name) continue;
      const projName = p.Name;
      // (a) source compose files (comma-separated paths from compose ls)
      safeStep(logs, `compose-src-${projName}`, () => {
        if (!p.ConfigFiles) return;
        for (const cf of p.ConfigFiles.split(",").map((s) => s.trim()).filter(Boolean)) {
          const src = safeNestedSsh(pveHost, sshPort,
            `pct exec ${vmId} -- cat ${JSON.stringify(cf)} 2>/dev/null || true`,
            8000,
          );
          const shortName = cf.split("/").slice(-2).join("/");
          pushIfContent(logs, `compose-src-${projName}-${shortName}`, src, 200);
        }
      });
      // (b) rendered config — env vars + extends fully resolved
      safeStep(logs, `compose-config-${projName}`, () => {
        const resolved = safeNestedSsh(pveHost, sshPort,
          `pct exec ${vmId} -- docker compose -p ${projName} config 2>&1 || true`,
          15000,
        );
        pushIfContent(logs, `compose-config-${projName}`, resolved, 200);
      });
      // (c) multiplexed logs
      safeStep(logs, `compose-logs-${projName}`, () => {
        const composeLog = safeNestedSsh(pveHost, sshPort,
          `pct exec ${vmId} -- docker compose -p ${projName} logs --tail 300 --no-color 2>&1 || true`,
          20000,
        );
        pushIfContent(logs, `compose-${projName}`, composeLog, 30);
      });
    }
  });

  // 7b. proxvex stack-state mounted into the container at /etc/proxvex.
  //     For docker-compose apps, this is where addon-state/secrets land that
  //     the compose file references via ${...}. Diff between this and the
  //     resolved compose config above pinpoints substitution issues.
  safeStep(logs, "proxvex-state", () => {
    const proxvexFiles = safeNestedSsh(pveHost, sshPort,
      `pct exec ${vmId} -- sh -c 'for f in /etc/proxvex/*; do `
      + `[ -f "$f" ] && echo "=== $f ===" && cat "$f" && echo; done' 2>/dev/null || true`,
      10000,
    );
    pushIfContent(logs, "proxvex-state", proxvexFiles, 200);
  });

  // 8. Per-container docker logs.
  for (const name of containerNames) {
    safeStep(logs, `docker-${name}`, () => {
      const dockerLog = safeNestedSsh(pveHost, sshPort,
        `pct exec ${vmId} -- docker logs --tail 200 ${name} 2>&1 || true`,
        15000,
      );
      pushIfContent(logs, `docker-${name}`, dockerLog, 20);
    });
  }

  // 9. docker inspect for non-running containers (exit code, OOMKilled, etc.)
  for (const line of containerLines) {
    const [name, status] = line.split("\t");
    if (!name || !status) continue;
    if (/^Up\b/i.test(status)) continue; // running, no inspect needed
    safeStep(logs, `inspect-${name}`, () => {
      const inspect = safeNestedSsh(pveHost, sshPort,
        `pct exec ${vmId} -- docker inspect --format `
        + `'{{.Name}} state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} `
        + `started={{.State.StartedAt}} finished={{.State.FinishedAt}} error={{.State.Error}}' `
        + `${name} 2>&1 || true`,
        8000,
      );
      pushIfContent(logs, `inspect-${name}`, inspect, 5);
    });
  }

  return logs;
}
