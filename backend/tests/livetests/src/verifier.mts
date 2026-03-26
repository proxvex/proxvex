/**
 * Verification logic for live integration tests.
 * Basic checks (container_running, notes_managed, services_up, lxc_log_no_errors,
 * docker_log_no_errors, file_exists, tls_connect, pg_ssl_on) are now handled by
 * check templates that run as part of the installation/upgrade CLI execution.
 *
 * Remaining here: complex integration test checks (zitadel, OIDC) that require
 * multi-step API interactions and test data setup. These will be migrated to
 * check templates in a follow-up.
 */

import { nestedSsh } from "./ssh-helpers.mjs";
import { logOk, logFail, logWarn } from "./log-helpers.mjs";
import type { ResolvedScenario, PlannedScenario } from "./livetest-types.mjs";

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
}

/**
 * Build verify checks from test.json scenario.
 * Basic checks are now handled by check templates in the CLI.
 * Only test-specific checks remain here.
 */
export function buildDefaultVerify(
  _scenario: ResolvedScenario,
  _appMeta: AppMeta,
): Record<string, boolean | number | string> {
  // Basic checks (container_running, notes_managed, lxc_log_no_errors,
  // services_up, docker_log_no_errors, file_exists, tls_connect, pg_ssl_on)
  // are now handled by check templates auto-appended to installation/upgrade.
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

  private assert(condition: boolean, message: string) {
    if (condition) {
      logOk(message);
      this.passed++;
    } else {
      logFail(message);
      this.failed++;
    }
  }

  private async fetchDockerLogs(vmId: number, lines = 100): Promise<string | null> {
    const veContextKey = `ve_${this.veHost}`;
    const url = `${this.apiUrl}/api/${veContextKey}/ve/logs/${vmId}/docker?lines=${lines}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) return null;
      const data = await resp.json() as { success: boolean; content?: string; error?: string };
      return data.success ? (data.content ?? null) : null;
    } catch {
      return null;
    }
  }

  async dumpDockerLogs(vmId: number) {
    logWarn(`[${vmId}] Dumping docker logs (last 50 lines)...`);
    const content = await this.fetchDockerLogs(vmId, 50);
    if (content) {
      console.log(content);
    } else {
      logWarn(`[${vmId}] Could not fetch docker logs via API`);
    }
  }

  private getContainerIp(vmId: number): string | null {
    const ip = this.ssh(
      `pct exec ${vmId} -- ip -4 addr show eth0 | sed -n 's/.*inet \\([0-9.]*\\).*/\\1/p' | head -1`,
    ).trim();
    return ip || null;
  }

  private getContainerHostname(vmId: number): string | null {
    const hostname = this.ssh(`pct exec ${vmId} -- hostname`).trim();
    return hostname || null;
  }

  /**
   * Set up a test project in Zitadel with a test user and admin role.
   * Provides prerequisites for downstream OIDC tests (e.g. oci-lxc-deployer).
   */
  zitadelSetupTestProject(vmId: number) {
    const ip = this.getContainerIp(vmId);
    if (!ip) {
      logFail(`[${vmId}] Cannot determine container IP`);
      this.failed++;
      return;
    }

    // Read admin PAT
    const pat = this.ssh(
      `pct exec ${vmId} -- cat /bootstrap/admin-client.pat`,
    ).trim();
    if (!pat) {
      logFail(`[${vmId}] Cannot read admin-client.pat`);
      this.failed++;
      return;
    }

    const hostname = this.getContainerHostname(vmId) ?? ip;
    const issuerUrl = `http://${ip}:8080`;
    const mgmtApi = `${issuerUrl}/management/v1`;
    const curlAuth = `curl -sf -H 'Host: ${hostname}:8080' -H 'Authorization: Bearer ${pat}' -H 'Content-Type: application/json'`;

    // 1. Create project "proxmox" with projectRoleAssertion (includes roles in JWT tokens)
    let projectId: string | undefined;
    const projectResult = this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/projects -d '{"name":"proxmox","projectRoleAssertion":true}'`,
      15000,
    );
    try {
      const parsed = JSON.parse(projectResult);
      projectId = parsed.id;
    } catch { /* ignore */ }

    if (!projectId) {
      // Project might already exist
      const projectSearch = this.ssh(
        `${curlAuth} -X POST ${mgmtApi}/projects/_search -d '{"queries":[{"nameQuery":{"name":"proxmox","method":"TEXT_QUERY_METHOD_EQUALS"}}]}'`,
        15000,
      );
      try {
        const parsed = JSON.parse(projectSearch);
        projectId = parsed.result?.[0]?.id;
      } catch { /* ignore */ }
    }

    if (!projectId) {
      logFail(`[${vmId}] Cannot create/find project 'proxmox'`);
      this.failed++;
      return;
    }

    // Ensure projectRoleAssertion is enabled (adds role claims to tokens)
    this.ssh(
      `${curlAuth} -X PUT ${mgmtApi}/projects/${projectId} -d '{"name":"proxmox","projectRoleAssertion":true}'`,
      15000,
    );
    logOk(`[${vmId}] Zitadel project 'proxmox': ${projectId} (projectRoleAssertion=true)`);

    // 2. Create role "admin"
    this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/projects/${projectId}/roles -d '{"roleKey":"admin","displayName":"Admin"}' 2>/dev/null || true`,
      15000,
    );
    logOk(`[${vmId}] Role 'admin' ensured in project`);

    // 3. Create test user (human, verified email, known password)
    let testUserId: string | undefined;
    const userResult = this.ssh(
      `${curlAuth} -X POST ${issuerUrl}/v2/users/human -d '{"username":"testadmin","profile":{"givenName":"Test","familyName":"Admin"},"email":{"email":"testadmin@zitadel-default","isVerified":true},"password":{"password":"TestAdmin-1234","changeRequired":false}}'`,
      15000,
    );
    try {
      const parsed = JSON.parse(userResult);
      testUserId = parsed.userId;
    } catch { /* ignore */ }

    if (!testUserId) {
      // User might already exist
      const userSearch = this.ssh(
        `${curlAuth} -X POST ${mgmtApi}/users/_search -d '{"queries":[{"userNameQuery":{"userName":"testadmin","method":"TEXT_QUERY_METHOD_EQUALS"}}]}'`,
        15000,
      );
      try {
        const parsed = JSON.parse(userSearch);
        testUserId = parsed.result?.[0]?.id;
      } catch { /* ignore */ }
    }

    if (!testUserId) {
      logFail(`[${vmId}] Cannot create/find test user 'testadmin'`);
      this.failed++;
      return;
    }
    logOk(`[${vmId}] Test user 'testadmin': ${testUserId}`);

    // 4. Grant admin role to test user
    this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/users/${testUserId}/grants -d '{"projectId":"${projectId}","roleKeys":["admin"]}' 2>/dev/null || true`,
      15000,
    );
    logOk(`[${vmId}] Test user granted 'admin' role in project 'proxmox'`);
  }

  oidcEnabled(vmId: number) {
    const ip = this.getContainerIp(vmId);
    if (!ip) {
      logFail(`[${vmId}] Cannot determine container IP for OIDC check`);
      this.failed++;
      return;
    }
    const result = this.ssh(
      `curl -sf --connect-timeout 5 http://${ip}:3080/api/auth/config`,
      20000,
    );
    let ok = false;
    try {
      const parsed = JSON.parse(result);
      ok = parsed.oidcEnabled === true;
    } catch { /* ignore */ }
    this.assert(ok, `[${vmId}] OIDC is enabled (/api/auth/config)`);
  }

  oidcApiProtected(vmId: number) {
    // Retry: deployer reboots after OIDC configuration (IP may change via DHCP)
    let statusCode = "000";
    for (let attempt = 0; attempt < 6; attempt++) {
      const ip = this.getContainerIp(vmId);
      if (!ip) {
        if (attempt < 5) { this.ssh("sleep 5"); }
        continue;
      }
      statusCode = this.ssh(
        `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 http://${ip}:3080/api/applications`,
        30000,
      ).trim();
      if (statusCode === "401") break;
      if (attempt < 5) {
        this.ssh("sleep 5");
      }
    }
    this.assert(statusCode === "401", `[${vmId}] API is protected (status=${statusCode}, expected 401)`);
  }

  async oidcMachineLogin(vmId: number, planned: PlannedScenario[]) {
    const ip = this.getContainerIp(vmId);
    if (!ip) {
      logFail(`[${vmId}] Cannot determine container IP for OIDC machine login`);
      this.failed++;
      return;
    }

    // Find the Zitadel dependency VM
    const zitadelVm = planned.find((p) => p.scenario.application === "zitadel");
    if (!zitadelVm) {
      logFail(`[${vmId}] No Zitadel dependency found in planned scenarios`);
      this.failed++;
      return;
    }

    const zitadelIp = this.getContainerIp(zitadelVm.vmId);
    if (!zitadelIp) {
      logFail(`[${vmId}] Cannot determine Zitadel container IP`);
      this.failed++;
      return;
    }

    // Read PAT from Zitadel container
    const pat = this.ssh(
      `pct exec ${zitadelVm.vmId} -- cat /bootstrap/admin-client.pat`,
    ).trim();
    if (!pat) {
      logFail(`[${vmId}] Cannot read Zitadel PAT from VM ${zitadelVm.vmId}`);
      this.failed++;
      return;
    }

    const zitadelHostname = this.getContainerHostname(zitadelVm.vmId) ?? zitadelIp;
    const issuerUrl = `http://${zitadelIp}:8080`;
    const mgmtApi = `${issuerUrl}/management/v1`;
    const curlAuth = `curl -sf -H 'Host: ${zitadelHostname}:8080' -H 'Authorization: Bearer ${pat}' -H 'Content-Type: application/json'`;

    // 1. Find the project (search for "proxmox" project)
    const projectSearch = this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/projects/_search -d '{"queries":[{"nameQuery":{"name":"proxmox","method":"TEXT_QUERY_METHOD_EQUALS"}}]}'`,
      20000,
    );
    let projectId: string | undefined;
    try {
      const parsed = JSON.parse(projectSearch);
      projectId = parsed.result?.[0]?.id;
    } catch { /* ignore */ }

    if (!projectId) {
      logFail(`[${vmId}] Cannot find Zitadel project 'proxmox'`);
      this.failed++;
      return;
    }
    logOk(`[${vmId}] Found Zitadel project: ${projectId}`);

    // 2. Ensure role 'admin' exists in project
    const roleBody = JSON.stringify({ roleKey: "admin", displayName: "Admin", group: "deployer" });
    this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/projects/${projectId}/roles -d '${roleBody}' 2>/dev/null || true`,
      15000,
    );

    // 3. Create a Machine User
    const machineBody = JSON.stringify({
      userName: "oidc-test-machine",
      name: "OIDC Test Machine",
      accessTokenType: "ACCESS_TOKEN_TYPE_JWT",
    });
    const machineResult = this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/users/machine -d '${machineBody}'`,
      15000,
    );
    let machineUserId: string | undefined;
    try {
      const parsed = JSON.parse(machineResult);
      machineUserId = parsed.userId;
    } catch { /* ignore */ }

    if (!machineUserId) {
      // User might already exist, search for it
      const userSearch = this.ssh(
        `${curlAuth} -X POST ${mgmtApi}/users/_search -d '{"queries":[{"userNameQuery":{"userName":"oidc-test-machine","method":"TEXT_QUERY_METHOD_EQUALS"}}]}'`,
        15000,
      );
      try {
        const parsed = JSON.parse(userSearch);
        machineUserId = parsed.result?.[0]?.id;
      } catch { /* ignore */ }
    }

    if (!machineUserId) {
      logFail(`[${vmId}] Cannot create/find machine user`);
      this.failed++;
      return;
    }
    logOk(`[${vmId}] Machine user ID: ${machineUserId}`);

    // 4. Generate client secret for machine user
    const secretResult = this.ssh(
      `${curlAuth} -X PUT ${mgmtApi}/users/${machineUserId}/secret`,
      15000,
    );
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    try {
      const parsed = JSON.parse(secretResult);
      clientId = parsed.clientId;
      clientSecret = parsed.clientSecret;
    } catch { /* ignore */ }

    if (!clientId || !clientSecret) {
      logFail(`[${vmId}] Cannot generate machine user credentials`);
      this.failed++;
      return;
    }

    // 5. Grant admin role to machine user
    const grantBody = JSON.stringify({
      projectId,
      roleKeys: ["admin"],
    });
    this.ssh(
      `${curlAuth} -X POST ${mgmtApi}/users/${machineUserId}/grants -d '${grantBody}' 2>/dev/null || true`,
      15000,
    );

    // 6. Fetch JWT via Client Credentials Grant (include project audience + roles scopes)
    const projectAudScope = `urn:zitadel:iam:org:project:id:${projectId}:aud`;
    const rolesScope = "urn:zitadel:iam:org:projects:roles";
    const tokenResult = this.ssh(
      `curl -sf -H 'Host: ${zitadelHostname}:8080' -X POST -u '${clientId}:${clientSecret}' -d 'grant_type=client_credentials&scope=openid+${projectAudScope}+${rolesScope}' ${issuerUrl}/oauth/v2/token`,
      20000,
    );
    let accessToken: string | undefined;
    try {
      const parsed = JSON.parse(tokenResult);
      accessToken = parsed.access_token;
    } catch { /* ignore */ }

    if (!accessToken) {
      logFail(`[${vmId}] Cannot obtain JWT via Client Credentials Grant`);
      this.failed++;
      return;
    }
    logOk(`[${vmId}] Obtained JWT access token`);

    // 7. Call deployer API with JWT
    const apiResult = this.ssh(
      `curl -sf -H 'Authorization: Bearer ${accessToken}' --connect-timeout 5 http://${ip}:3080/api/applications`,
      20000,
    );
    let apiOk = false;
    try {
      const parsed = JSON.parse(apiResult);
      apiOk = Array.isArray(parsed);
    } catch { /* ignore */ }

    this.assert(apiOk, `[${vmId}] Machine user API call with JWT succeeded`);
  }

  async runAll(vmId: number, _hostname: string, verify: Record<string, boolean | number | string>, planned?: PlannedScenario[]) {
    const failedBefore = this.failed;

    // Basic checks (container_running, notes_managed, services_up, lxc_log_no_errors,
    // docker_log_no_errors, file_exists, tls_connect, pg_ssl_on, db_ssl_connection)
    // are now handled by check templates auto-appended to installation/upgrade.

    // Complex integration test checks remain here until migrated to templates
    if (verify.zitadel_setup_test_project) this.zitadelSetupTestProject(vmId);
    if (verify.oidc_enabled) this.oidcEnabled(vmId);
    if (verify.oidc_api_protected) this.oidcApiProtected(vmId);
    if (verify.oidc_machine_login && planned) await this.oidcMachineLogin(vmId, planned);

    // Dump docker logs if any verification failed
    if (this.failed > failedBefore) {
      await this.dumpDockerLogs(vmId);
    }
  }
}
