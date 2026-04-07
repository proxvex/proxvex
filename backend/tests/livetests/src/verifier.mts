/**
 * Verification logic for live integration tests.
 *
 * All checks (container_running, notes_managed, services_up, lxc_log_no_errors,
 * docker_log_no_errors, file_exists, tls_connect, pg_ssl_on, oidc_enabled,
 * oidc_api_protected, oidc_machine_login, zitadel_setup_test_project) are now
 * handled by check/post_start templates that run as part of the CLI execution.
 *
 * This module retains only the API helper and metadata types used by the test runner.
 */

import { nestedSsh } from "./ssh-helpers.mjs";
import { logWarn } from "./log-helpers.mjs";
import type { PlannedScenario } from "./livetest-types.mjs";

// ── API helper ──

async function apiFetch<T>(baseUrl: string, apiPath: string): Promise<T | null> {
  try {
    const resp = await fetch(`${baseUrl}${apiPath}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export { apiFetch };

// ── Application metadata ──

/** Application metadata used for auto-determining verifications */
export interface AppMeta {
  extends?: string | undefined;
  stacktype?: string | string[] | undefined;
  tags?: string[] | undefined;
  verification?: { wait_seconds?: number; [key: string]: unknown } | undefined;
}

/**
 * Build verify checks from test.json scenario.
 * All checks are now handled by templates — this returns empty.
 */
export function buildDefaultVerify(
  _scenario: import("./livetest-types.mjs").ResolvedScenario,
  _appMeta: AppMeta,
): Record<string, boolean | number | string> {
  return {};
}

// ── Verifier class ──

export class Verifier {
  passed = 0;
  failed = 0;

  constructor(
    private pveHost: string,
    private sshPort: number,
    private apiUrl: string,
    private veHost: string,
  ) {}

  private ssh(cmd: string, timeout = 15000): string {
    return nestedSsh(this.pveHost, this.sshPort, cmd, timeout);
  }

  async dumpDockerLogs(vmId: number) {
    logWarn(`[${vmId}] Dumping docker logs (last 50 lines)...`);
    const veContextKey = `ve_${this.veHost}`;
    const url = `${this.apiUrl}/api/${veContextKey}/ve/logs/${vmId}/docker?lines=50`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) {
        logWarn(`[${vmId}] Could not fetch docker logs via API`);
        return;
      }
      const data = await resp.json() as { success: boolean; content?: string };
      if (data.success && data.content) {
        console.log(data.content);
      } else {
        logWarn(`[${vmId}] Could not fetch docker logs via API`);
      }
    } catch {
      logWarn(`[${vmId}] Could not fetch docker logs via API`);
    }
  }

  async runAll(_vmId: number, _hostname: string, _verify: Record<string, boolean | number | string>, _planned?: PlannedScenario[]) {
    // All checks are now handled by templates.
    // This method is kept for API compatibility but does nothing.
  }
}
