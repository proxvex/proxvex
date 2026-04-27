/**
 * Failure log collection for live integration tests.
 *
 * Called from the scenario executor on failure, BEFORE the pre-test snapshot
 * rollback runs — so we capture the broken state, not the restored one.
 * Produces compact summaries (error lines + tail) that get embedded into the
 * per-scenario result JSON.
 */

import { nestedSsh } from "./ssh-helpers.mjs";

export interface LogSummary {
  name: string;
  errors: string[];
  last_lines: string[];
}

const MAX_ERRORS = 50;
const MAX_LINE_CHARS = 500;

function trim(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}...[truncated]`
    : line;
}

function summarizeLog(name: string, content: string): LogSummary {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const errors = lines.filter((l) => /error/i.test(l)).slice(0, MAX_ERRORS).map(trim);
  const last_lines = lines.slice(-10).map(trim);
  return { name, errors, last_lines };
}

export function collectFailureLogs(
  pveHost: string,
  sshPort: number,
  vmId: number,
  hostname: string,
  cliOutput: string | undefined,
): LogSummary[] {
  const logs: LogSummary[] = [];

  if (cliOutput && cliOutput.trim()) {
    logs.push(summarizeLog("cli-output", cliOutput));
  }

  const lxcLog = nestedSsh(
    pveHost, sshPort,
    `cat /var/log/lxc/${hostname}-${vmId}.log 2>/dev/null || true`,
    10000,
  );
  if (lxcLog && lxcLog.trim()) {
    logs.push(summarizeLog("lxc", lxcLog));
  }

  const containerNames = nestedSsh(
    pveHost, sshPort,
    `pct exec ${vmId} -- docker ps -a --format '{{.Names}}' 2>/dev/null || true`,
    10000,
  );
  for (const name of containerNames.split("\n").map((n) => n.trim()).filter(Boolean)) {
    const dockerLog = nestedSsh(
      pveHost, sshPort,
      `pct exec ${vmId} -- docker logs --tail 200 ${name} 2>&1 || true`,
      15000,
    );
    if (dockerLog && dockerLog.trim()) {
      logs.push(summarizeLog(`docker-${name}`, dockerLog));
    }
  }

  return logs;
}
