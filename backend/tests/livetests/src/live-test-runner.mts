#!/usr/bin/env tsx
/**
 * TypeScript Live Integration Test Runner for OCI LXC Deployer.
 *
 * Creates real containers on a Proxmox host via the CLI tool and verifies
 * application-level functionality including dependencies and docker services.
 *
 * Test definitions live in json/applications/<app>/tests/test.json.
 * Each scenario tests one application. Dependencies are declared via depends_on.
 *
 * Features:
 * - Pre-assigned VM IDs (200+) to avoid parallel conflicts
 * - Dependency-aware execution with topological sort
 * - Per-scenario params with set, append, and file: modes
 * - Comprehensive verification suite (container, notes, services, TLS, SSL)
 *
 * Usage:
 *   tsx live-test-runner.mts [instance] [test-name|--all] [--queue] [--fixtures]
 *
 * Examples:
 *   tsx live-test-runner.mts github-action postgres/ssl
 *   tsx live-test-runner.mts github-action zitadel        # runs all zitadel/* + deps
 *   tsx live-test-runner.mts github-action --all
 *   tsx live-test-runner.mts github-action --queue         # parallel queue worker mode
 *   KEEP_VM=1 tsx live-test-runner.mts github-action zitadel/ssl
 */

import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Constants ──

const VM_ID_START = 200;

// ── Types ──

/** One scenario from <app>/tests/test.json */
export interface TestScenario {
  description: string;
  depends_on?: string[];
  task?: string;
  vm_id?: number;
  addons?: string[];
  wait_seconds?: number;
  cli_timeout?: number;
  verify?: Record<string, boolean | number | string>;
  cleanup?: Record<string, string>;
}

/** Discovered scenario with resolved identity */
export interface ResolvedScenario extends TestScenario {
  id: string;
  application: string;
  /** Params from scenario params file (delivered by API) */
  params?: ParamEntry[];
  selectedAddons?: string[];
  stackId?: string;
  uploads?: { name: string; content: string }[];
}

/** Planned scenario ready for execution */
interface PlannedScenario {
  vmId: number;
  hostname: string;
  stackName: string;
  scenario: ResolvedScenario;
  hasStacktype: boolean;
  isDependency: boolean;
  skipExecution: boolean;
}

interface StepResult {
  vmId: number;
  hostname: string;
  application: string;
  cliOutput?: string;
  scenarioId?: string;
}

interface TestResult {
  name: string;
  description: string;
  passed: number;
  failed: number;
  steps: StepResult[];
  errors: string[];
}

interface E2EConfig {
  default: string;
  instances: Record<string, {
    pveHost: string;
    vmId: number;
    vmName: string;
    portOffset: number;
    subnet: string;
    bridge: string;
    filesystem?: string;
    deployerHost?: string;
    deployerPort?: string;
    veHost?: string;
    veSshPort?: number;
  }>;
  defaults: Record<string, unknown>;
  ports: {
    pveWeb: number;
    pveSsh: number;
    deployer: number;
    deployerHttps: number;
  };
}

/** Param entry in a scenario params file */
export interface ParamEntry {
  name: string;
  value?: string;
  append?: string;
}

// ── Colors ──

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const BLUE = "\x1b[0;34m";
const NC = "\x1b[0m";

function logOk(msg: string) { console.log(`${GREEN}\u2713${NC} ${msg}`); }
function logFail(msg: string) { console.log(`${RED}\u2717${NC} ${msg}`); }
function logWarn(msg: string) { console.log(`${YELLOW}!${NC} ${msg}`); }
function logInfo(msg: string) { console.log(`\u2192 ${msg}`); }
function logStep(step: string, desc: string) {
  console.log(`\n${BLUE}\u2500\u2500 ${step}: ${desc} \u2500\u2500${NC}`);
}

// ── Pure functions (exported for unit testing) ──

/**
 * Fetch all test scenarios from the deployer API.
 * Replaces the old filesystem-based discoverTests().
 */
export async function fetchTestScenarios(apiUrl: string): Promise<Map<string, ResolvedScenario>> {
  const resp = await fetch(`${apiUrl}/api/test-scenarios`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch test scenarios: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json() as { scenarios: Array<ResolvedScenario & { params?: ParamEntry[] }> };

  const all = new Map<string, ResolvedScenario>();
  for (const s of data.scenarios) {
    all.set(s.id, s);
  }
  return all;
}

/**
 * Collect selected scenarios and all their transitive dependencies.
 * Returns topologically sorted (dependencies first).
 * Detects circular dependencies.
 */
export function collectWithDeps(
  selected: string[],
  all: Map<string, ResolvedScenario>,
): ResolvedScenario[] {
  const visited = new Set<string>();
  const visiting = new Set<string>(); // for cycle detection
  const ordered: ResolvedScenario[] = [];

  function visit(id: string, chain: string[]) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular dependency detected: ${[...chain, id].join(" → ")}`);
    }

    visiting.add(id);
    const s = all.get(id);
    if (!s) throw new Error(`Unknown test scenario: ${id}`);

    for (const dep of s.depends_on ?? []) {
      visit(dep, [...chain, id]);
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(s);
  }

  for (const id of selected) {
    visit(id, []);
  }

  return ordered;
}

/**
 * Select scenarios based on CLI argument.
 * - "app" → all scenarios under app/*
 * - "app/scenario" → exact match
 * - "--all" → everything
 * Returns selected scenario IDs (without deps — call collectWithDeps after).
 */
export function selectScenarios(
  testArg: string,
  all: Map<string, ResolvedScenario>,
): string[] {
  if (testArg === "--all") {
    return [...all.keys()];
  }

  // Exact match: "app/scenario"
  if (testArg.includes("/")) {
    if (!all.has(testArg)) {
      throw new Error(`Unknown test scenario: '${testArg}'`);
    }
    return [testArg];
  }

  // App-level match: "app" → all scenarios under app/*
  const matches = [...all.keys()].filter((id) => id.startsWith(`${testArg}/`));
  if (matches.length === 0) {
    throw new Error(
      `No test scenarios found for '${testArg}'. ` +
      `Expected json/applications/${testArg}/tests/test.json`,
    );
  }
  return matches;
}

/** Result of building params from a scenario params file */
export interface BuildParamsResult {
  params: { name: string; value: string }[];
  selectedAddons?: string[];
  stackId?: string;
}

/**
 * Build CLI params for a scenario.
 * Merges base params with scenario params from the API response.
 * Also extracts selectedAddons and stackId.
 * Supports set mode and append mode (for multiline vars like envs).
 * Resolves file: references using upload data from the API (written to tmpDir).
 */
export function buildParams(
  scenario: ResolvedScenario,
  baseParams: { name: string; value: string }[],
  templateVars: Record<string, string>,
  tmpDir?: string,
): BuildParamsResult {
  const params = baseParams.map((p) => ({ ...p }));

  if (!scenario.params || scenario.params.length === 0) {
    return {
      params,
      ...(scenario.selectedAddons ? { selectedAddons: scenario.selectedAddons } : {}),
      ...(scenario.stackId ? { stackId: scenario.stackId } : {}),
    };
  }

  // Write upload files to tmpDir so file: references can be resolved
  const uploadMap = new Map<string, string>();
  if (tmpDir && scenario.uploads) {
    const uploadsDir = path.join(tmpDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    for (const upload of scenario.uploads) {
      const filePath = path.join(uploadsDir, upload.name);
      writeFileSync(filePath, Buffer.from(upload.content, "base64"));
      uploadMap.set(upload.name, filePath);
    }
  }

  // These params are controlled by the test runner (VM allocation) and must not be overridden
  const runnerControlled = new Set(["vm_id", "hostname"]);

  for (const p of scenario.params) {
    // Skip runner-controlled params — they're set via baseParams
    if (runnerControlled.has(p.name) && !p.append) continue;

    // Substitute template variables in values
    let value = String(p.value ?? "");
    for (const [key, val] of Object.entries(templateVars)) {
      value = value.replace(
        new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
        val,
      );
    }

    if (p.append) {
      let appendVal = p.append;
      for (const [key, val] of Object.entries(templateVars)) {
        appendVal = appendVal.replace(
          new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
          val,
        );
      }
      // Append mode: extend multiline variable (e.g. envs)
      const existing = params.find((b) => b.name === p.name);
      const line = `${appendVal}=${value}`;
      if (existing) {
        existing.value = existing.value
          ? `${existing.value}\n${line}`
          : line;
      } else {
        params.push({ name: p.name, value: line });
      }
    } else {
      // Set mode: override or add
      // Resolve file: references using uploads from API
      if (value.startsWith("file:")) {
        const fileName = value.slice(5);
        const localPath = uploadMap.get(fileName);
        if (localPath) {
          value = `file:${localPath}`;
        }
      }
      const existing = params.find((b) => b.name === p.name);
      if (existing) {
        existing.value = value;
      } else {
        params.push({ name: p.name, value });
      }
    }
  }

  return {
    params,
    ...(scenario.selectedAddons ? { selectedAddons: scenario.selectedAddons } : {}),
    ...(scenario.stackId ? { stackId: scenario.stackId } : {}),
  };
}

// ── Configuration ──

function loadConfig(instanceName?: string): {
  instance: string;
  pveHost: string;
  portPveSsh: number;
  pveWebUrl: string;
  deployerUrl: string;
  deployerHttpsUrl: string;
  bridge: string;
  veHost: string;
  veSshPort: number;
} {
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");
  const configPath = path.join(projectRoot, "e2e/config.json");
  const config: E2EConfig = JSON.parse(readFileSync(configPath, "utf-8"));

  const instance = instanceName || config.default;
  const inst = config.instances[instance];
  if (!inst) {
    console.error(`Instance '${instance}' not found. Available: ${Object.keys(config.instances).join(", ")}`);
    process.exit(1);
  }

  // Resolve ${VAR:-default} and ${VAR} in config values
  const resolveEnv = (val: string) =>
    val
      .replace(/\$\{(\w+):-(\w+)\}/g, (_, varName, defaultVal) => process.env[varName] || defaultVal)
      .replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || "");

  const pveHost = resolveEnv(inst.pveHost);

  const offset = inst.portOffset;
  const portPveSsh = config.ports.pveSsh + offset;
  const pveWebUrl = `https://${pveHost}:${config.ports.pveWeb + offset}`;

  // Allow explicit deployer host/port override (for dev environments)
  let deployerUrl: string;
  let deployerHttpsUrl: string;
  if (inst.deployerHost && inst.deployerPort) {
    const deployerHost = resolveEnv(inst.deployerHost);
    const deployerPort = resolveEnv(inst.deployerPort);
    deployerUrl = `http://${deployerHost}:${deployerPort}`;
    deployerHttpsUrl = `https://${deployerHost}:${deployerPort}`;
  } else {
    const portDeployer = config.ports.deployer + offset;
    const portDeployerHttps = config.ports.deployerHttps + offset;
    deployerUrl = `http://${pveHost}:${portDeployer}`;
    deployerHttpsUrl = `https://${pveHost}:${portDeployerHttps}`;
  }

  // veHost/veSshPort: how the deployer (inside the nested VM) reaches the PVE host.
  // Defaults to pveHost:portPveSsh (same as external), but can be overridden
  // for nested setups where the deployer uses a different hostname/port.
  const veHost = inst.veHost ? resolveEnv(inst.veHost) : pveHost;
  const veSshPort = inst.veSshPort ?? portPveSsh;

  return {
    instance,
    pveHost,
    portPveSsh,
    pveWebUrl,
    deployerUrl,
    deployerHttpsUrl,
    bridge: inst.bridge || "vmbr0",
    veHost,
    veSshPort,
  };
}

// ── SSH ──

function nestedSshStrict(
  pveHost: string,
  port: number,
  command: string,
  timeoutMs = 15000,
): string {
  const result = execSync(
    `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
    `-o BatchMode=yes -o ConnectTimeout=10 ` +
    `-p ${port} root@${pveHost} ${JSON.stringify(command)}`,
    { timeout: timeoutMs, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  return result.trim();
}

function nestedSsh(
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

// ── API helpers ──

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

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/** Find an existing managed container by application_id via the installations API */
async function findExistingVm(
  apiUrl: string,
  veHost: string,
  applicationId: string,
): Promise<{ vm_id: number; addons?: string[] } | null> {
  const veContextKey = `ve_${veHost}`;
  const containers = await apiFetch<Array<{ vm_id: number; application_id?: string; addons?: string[] }>>(
    apiUrl,
    `/api/${veContextKey}/installations`,
  );
  if (!containers) return null;
  return containers.find((c) => c.application_id === applicationId) ?? null;
}

/**
 * Resolve volume_storage parameter by querying PVE rootdir storages via SSH.
 * Prioritizes zfspool > dir > any other type.
 */
function resolveVolumeStorage(
  pveHost: string,
  sshPort: number,
  existingParams: { name: string; value: string }[],
): void {
  if (existingParams.some((p) => p.name === "volume_storage")) return;
  try {
    const raw = nestedSshStrict(pveHost, sshPort,
      "pvesm status --content rootdir 2>/dev/null | tail -n +2", 10000);
    const storages = raw.trim().split("\n")
      .map((line) => {
        const [name, type] = line.trim().split(/\s+/);
        return { name: name || "", type: type || "" };
      })
      .filter((s) => s.name);
    if (storages.length === 0) return;
    // Prioritize: zfspool > dir > first available
    const preferred =
      storages.find((s) => s.type === "zfspool") ??
      storages.find((s) => s.type === "dir") ??
      storages[0];
    existingParams.push({ name: "volume_storage", value: preferred.name });
    logInfo(`Auto-resolved volume_storage=${preferred.name} (${preferred.type})`);
  } catch {
    // SSH failed — continue without, CLI will validate
  }
}

async function discoverApiUrl(httpUrl: string, httpsUrl: string): Promise<string> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  try {
    const resp = await fetch(`${httpsUrl}/`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok || resp.status < 500) return httpsUrl;
  } catch { /* try HTTP */ }

  try {
    const resp = await fetch(`${httpUrl}/api/sshconfigs`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return httpUrl;
  } catch { /* fail */ }

  throw new Error(`Deployer not reachable at ${httpsUrl} or ${httpUrl}`);
}

// ── CLI execution ──

function runCli(
  projectRoot: string,
  apiUrl: string,
  veHost: string,
  paramsFile: string,
  addons?: string[],
  cliTimeout = 600,
  fixturePath?: string,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    // Auto-detect dev mode: if TypeScript source exists, use tsx
    const tsSource = path.join(projectRoot, "cli/src/oci-lxc-cli.mts");
    const devMode = existsSync(tsSource);

    const cliArgs = [
      "remote",
      "--server", apiUrl,
      "--ve", veHost,
      "--insecure",
      "--timeout", String(cliTimeout),
      "--quiet",
    ];

    if (addons && addons.length > 0) {
      cliArgs.push("--enable-addons", addons.join(","));
    }

    if (fixturePath) {
      cliArgs.push("--fixture-path", fixturePath);
    }

    cliArgs.push(paramsFile);

    let cmd: string;
    let args: string[];
    if (devMode) {
      cmd = "npx";
      args = ["tsx", tsSource, ...cliArgs];
    } else {
      cmd = "node";
      args = [path.join(projectRoot, "cli/dist/cli/src/oci-lxc-cli.mjs"), ...cliArgs];
    }

    let output = "";
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });

    proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });

    proc.on("close", (code) => {
      resolve({ output, exitCode: code ?? 1 });
    });
  });
}

// ── Verifications ──

class Verifier {
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

  containerRunning(vmId: number) {
    const status = this.ssh(`pct status ${vmId}`);
    this.assert(status.includes("running"), `[${vmId}] Container is running (${status.trim()})`);
  }

  notesManaged(vmId: number) {
    const notes = this.ssh(`pct config ${vmId} | grep -a -A100 'description:'`);
    const hasMarker = /oci-lxc-deployer(:managed|%3Amanaged)/.test(notes);
    this.assert(hasMarker, `[${vmId}] Notes contain managed marker`);
  }

  servicesUp(vmId: number) {
    const services = this.ssh(`pct exec ${vmId} -- docker ps --format '{{.Names}}:{{.Status}}'`);
    if (!services) {
      logFail(`[${vmId}] No docker services found`);
      this.failed++;
      return;
    }
    const lines = services.split("\n").filter(Boolean);
    const notUp = lines.filter((l) => !l.includes("Up"));
    if (notUp.length === 0) {
      logOk(`[${vmId}] All docker services are up`);
      this.passed++;
    } else {
      logFail(`[${vmId}] Some docker services not up: ${notUp.join(", ")}`);
      this.failed++;
    }
  }

  lxcLogNoErrors(vmId: number, hostname: string) {
    const errors = this.ssh(
      `cat /var/log/lxc/${hostname}-${vmId}.log 2>/dev/null | grep -i error | head -10`,
    );
    if (!errors) {
      logOk(`[${vmId}] LXC log clean (no errors)`);
      this.passed++;
    } else {
      logWarn(`[${vmId}] LXC log contains errors:`);
      errors.split("\n").slice(0, 5).forEach((l) => console.log(`  ${l}`));
    }
  }

  async dockerLogNoErrors(vmId: number) {
    const content = await this.fetchDockerLogs(vmId, 200);
    if (content === null) {
      logWarn(`[${vmId}] Could not fetch docker logs via API`);
      return;
    }
    const errorLines = content.split("\n").filter((l) => /error/i.test(l));
    if (errorLines.length === 0) {
      logOk(`[${vmId}] Docker logs clean (no errors)`);
      this.passed++;
    } else {
      logWarn(`[${vmId}] Docker logs contain errors:`);
      errorLines.slice(0, 10).forEach((l) => console.log(`  ${l}`));
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

  tlsConnect(vmId: number, port: number) {
    const ip = this.ssh(
      `pct exec ${vmId} -- ip -4 addr show eth0 | sed -n 's/.*inet \\([0-9.]*\\).*/\\1/p' | head -1`,
    );
    if (!ip) {
      logFail(`[${vmId}] Cannot determine container IP for TLS check`);
      this.failed++;
      return;
    }
    const result = this.ssh(
      `curl -sk --connect-timeout 5 https://${ip}:${port}/`,
      20000,
    );
    this.assert(result !== "", `[${vmId}] TLS connection successful on port ${port}`);
  }

  pgSslOn(vmId: number) {
    const sslStatus = this.ssh(
      `pct exec ${vmId} -- psql -U postgres -tA -c 'SHOW ssl;'`,
    ).trim();
    this.assert(sslStatus === "on", `[${vmId}] Postgres SSL is enabled (SHOW ssl = ${sslStatus})`);
  }

  dbSslConnection(vmId: number) {
    const sslInUse = this.ssh(
      `pct exec ${vmId} -- psql -U postgres -tA -c "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();"`,
    ).trim();
    this.assert(sslInUse === "t", `[${vmId}] DB connection uses SSL (pg_stat_ssl = ${sslInUse})`);
  }

  fileExists(vmId: number, filePath: string) {
    const result = this.ssh(
      `pct exec ${vmId} -- test -f ${filePath} && echo exists || echo missing`,
    ).trim();
    this.assert(result === "exists", `[${vmId}] File exists: ${filePath}`);
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

  async runAll(vmId: number, hostname: string, verify: Record<string, boolean | number | string>, planned?: PlannedScenario[]) {
    const failedBefore = this.failed;

    if (verify.container_running) this.containerRunning(vmId);
    if (verify.notes_managed) this.notesManaged(vmId);
    if (verify.services_up) this.servicesUp(vmId);
    if (verify.lxc_log_no_errors) this.lxcLogNoErrors(vmId, hostname);
    if (verify.docker_log_no_errors) await this.dockerLogNoErrors(vmId);
    if (typeof verify.tls_connect === "number") this.tlsConnect(vmId, verify.tls_connect);
    if (verify.pg_ssl_on) this.pgSslOn(vmId);
    if (verify.db_ssl_connection) this.dbSslConnection(vmId);
    if (typeof verify.file_exists === "string") this.fileExists(vmId, verify.file_exists);
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

// ── Wait for services ──

async function waitForServices(
  pveHost: string,
  sshPort: number,
  vmId: number,
  maxWait: number,
): Promise<void> {
  logInfo(`Waiting for docker services (max ${maxWait}s)...`);
  const deadline = Date.now() + maxWait * 1000;

  while (Date.now() < deadline) {
    const output = nestedSsh(pveHost, sshPort,
      `pct exec ${vmId} -- docker ps --format '{{.Status}}'`);
    if (output) {
      const lines = output.split("\n").filter(Boolean);
      const allUp = lines.every((l) => l.includes("Up"));
      if (allUp && lines.length > 0) {
        const elapsed = Math.round((Date.now() + maxWait * 1000 - deadline) / 1000);
        logOk(`Docker services ready after ~${elapsed}s`);
        return;
      }
    }
    await sleep(5000);
  }
  logWarn(`Docker services not fully ready after ${maxWait}s`);
}

// ── Planning: assign VM IDs and stack names ──

function planScenarios(
  scenarios: ResolvedScenario[],
  appStacktypes: Map<string, string | string[]>,
): PlannedScenario[] {
  let nextVmId = VM_ID_START;

  return scenarios.map((scenario) => {
    const vmId = scenario.vm_id ?? nextVmId++;
    const rawStacktype = appStacktypes.get(scenario.application);
    const stacktypes = rawStacktype ? (Array.isArray(rawStacktype) ? rawStacktype : [rawStacktype]) : [];
    const hasStacktype = stacktypes.length > 0;

    // Stack name = scenario variant (e.g. "default", "ssl")
    const stackName = scenario.id.split("/")[1] ?? "default";

    return {
      vmId,
      hostname: `${scenario.application}-${stackName}`,
      stackName,
      scenario,
      hasStacktype,
      isDependency: false,
      skipExecution: false,
    };
  });
}

// ── Auto-verify defaults ──

/** Application metadata used for auto-determining verifications */
interface AppMeta {
  extends?: string | undefined;
  stacktype?: string | string[] | undefined;
  tags?: string[] | undefined;
  verification?: {
    wait_seconds?: number;
    checks?: Record<string, boolean | number | string | { enabled?: boolean; fatal?: boolean }>;
  };
}

/**
 * Build default verifications from application metadata and scenario addons.
 * test.json can override/extend these defaults.
 */
function buildDefaultVerify(
  scenario: ResolvedScenario,
  appMeta: AppMeta,
): Record<string, boolean | number | string> {
  const verify: Record<string, boolean | number | string> = {
    container_running: true,
    notes_managed: true,
    lxc_log_no_errors: true,
  };

  // Docker-compose apps additionally check docker services
  if (appMeta.extends === "docker-compose") {
    verify.services_up = true;
  }

  // Addon-based checks
  const allAddons = scenario.selectedAddons ?? [];
  const hasSSL = allAddons.includes("addon-ssl");

  if (hasSSL) {
    // Only check pg_ssl_on for actual postgres applications, not for apps
    // that merely use the postgres stacktype for shared variables
    if (scenario.application === "postgres") {
      verify.pg_ssl_on = true;
    }
  }

  // Merge application-level verification checks from application.json
  if (appMeta.verification?.checks) {
    for (const [key, value] of Object.entries(appMeta.verification.checks)) {
      if (typeof value === "object" && value !== null) {
        // { enabled?: boolean; fatal?: boolean } - only add if enabled (default true)
        if (value.enabled !== false) {
          verify[key] = true;
        }
      } else {
        verify[key] = value;
      }
    }
  }

  return verify;
}
// ── Execute all planned scenarios sequentially ──

async function executeScenarios(
  planned: PlannedScenario[],
  config: ReturnType<typeof loadConfig>,
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
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

  // ZFS snapshot support for dependencies
  const depSteps = planned.filter((p) => p.isDependency && !p.skipExecution);
  const nonDepSteps = planned.filter((p) => !p.isDependency);
  const snapshotName = depSteps.length > 0
    ? "livetest-deps-" + depSteps
        .map((p) => p.scenario.id.replace(/\/default$/, "").replace(/\//g, "-"))
        .join("-")
        + (nonDepSteps.length > 0 ? "-" + nonDepSteps[0]!.stackName : "")
    : "";

  // Try to restore from ZFS snapshot (skip dependency installation)
  let depsRestoredFromSnapshot = false;
  if (snapshotName && depSteps.length > 0) {
    try {
      const checkSnap = nestedSsh(config.pveHost, config.portPveSsh,
        `zfs list -t snapshot -o name -H | grep '@${snapshotName}$' | head -1`, 30000);
      if (checkSnap.trim()) {
        logStep("ZFS", `Restoring dependencies from snapshot @${snapshotName}`);
        // Stop dependency containers
        for (const dep of depSteps) {
          nestedSsh(config.pveHost, config.portPveSsh,
            `pct stop ${dep.vmId} 2>/dev/null; true`, 30000);
        }
        // Rollback each dependency container's disk (recursive removes newer snapshots)
        for (const dep of depSteps) {
          const dataset = `rpool/data/subvol-${dep.vmId}-disk-0`;
          nestedSshStrict(config.pveHost, config.portPveSsh,
            `zfs rollback -r ${dataset}@${snapshotName}`, 60000);
        }
        // Also rollback the volumes dataset if it has the snapshot
        nestedSsh(config.pveHost, config.portPveSsh,
          `zfs rollback -r rpool/data/subvol-999999-oci-lxc-deployer-volumes@${snapshotName} 2>/dev/null; true`, 30000);
        // Start dependency containers
        for (const dep of depSteps) {
          nestedSshStrict(config.pveHost, config.portPveSsh,
            `pct start ${dep.vmId}`, 30000);
        }
        // Wait for docker services in last dependency (if docker-compose app)
        const lastDep = depSteps[depSteps.length - 1]!;
        const lastDepMeta = appMetaMap.get(lastDep.scenario.application) ?? {};
        if (lastDep.scenario.wait_seconds && lastDep.scenario.wait_seconds > 0 && lastDepMeta.extends === "docker-compose") {
          await waitForServices(config.pveHost, config.portPveSsh,
            lastDep.vmId, lastDep.scenario.wait_seconds);
        }
        depsRestoredFromSnapshot = true;
        logOk(`Dependencies restored from ZFS snapshot @${snapshotName}`);
      }
    } catch (err) {
      logInfo(`ZFS snapshot restore failed, will install normally: ${err}`);
    }
  }

  try {
    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]!;
      const scenario = step.scenario;
      const task = scenario.task || "installation";

      logStep(
        `${i + 1}/${planned.length}`,
        `${scenario.id} (${task}) [VM ${step.vmId}]`,
      );

      // Skip dependencies restored from ZFS snapshot
      if (depsRestoredFromSnapshot && step.isDependency) {
        logOk(`Skipping ${scenario.id} (restored from snapshot)`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        continue;
      }

      // Skip dependencies that are already running
      if (step.skipExecution) {
        logOk(`Skipping ${scenario.id} (already running)`);
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
        });
        continue;
      }

      // Build params — for replace_ct tasks, don't preset vm_id (create_ct assigns it)
      const isReplaceCt = REPLACE_CT_TASKS.includes(task);
      const baseParams = [
        { name: "hostname", value: step.hostname },
        { name: "bridge", value: config.bridge },
        ...(!isReplaceCt ? [{ name: "vm_id", value: String(step.vmId) }] : []),
      ];

      const templateVars: Record<string, string> = {
        vm_id: String(step.vmId),
        hostname: step.hostname,
        stack_name: step.stackName,
      };

      const buildResult = buildParams(scenario, baseParams, templateVars, tmpDir);

      // For upgrade/reconfigure: find existing VM via installations API
      if (isReplaceCt) {
        const existing = await findExistingVm(apiUrl, veHost, scenario.application);
        if (!existing) {
          const errMsg = `No existing VM found for ${scenario.application} — cannot ${task}`;
          logFail(errMsg);
          result.errors.push(errMsg);
          result.failed++;
          break;
        }
        buildResult.params.push({ name: "source_vm_id", value: String(existing.vm_id) });
        logInfo(`Found existing VM ${existing.vm_id} for ${task} (source_vm_id)`);
      }

      // Resolve enum defaults (e.g. volume_storage) via API
      resolveVolumeStorage(config.pveHost, config.portPveSsh, buildResult.params);

      // Addons come from scenario params file (selectedAddons)
      const allAddons = buildResult.selectedAddons ?? [];

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const paramsObj: Record<string, unknown> = {
        application: scenario.application,
        task,
        params: buildResult.params.map((p) => ({ name: p.name, value: p.value })),
      };

      if (allAddons.length > 0) {
        paramsObj.selectedAddons = allAddons;
      }
      if (buildResult.stackId) {
        paramsObj.stackId = buildResult.stackId;
      } else if (step.hasStacktype) {
        paramsObj.stackId = step.stackName;
      }

      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      if (allAddons.length > 0) {
        logInfo(`Addons: ${allAddons.join(", ")}`);
      }

      // Reload deployer to pick up any json/ changes
      try {
        const reloadResp = await fetch(`${apiUrl}/api/reload`, { method: "POST" });
        if (reloadResp.ok) {
          logInfo("Deployer reloaded");
        } else {
          logInfo(`Deployer reload returned ${reloadResp.status} (continuing)`);
        }
      } catch {
        logInfo("Deployer reload not available (continuing)");
      }

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const scenarioFixtureDir = fixtureBaseDir
        ? path.join(fixtureBaseDir, scenario.id.replace("/", "-"))
        : undefined;
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        paramsFile, allAddons, scenario.cli_timeout, scenarioFixtureDir,
      );

      if (cliResult.exitCode !== 0) {
        const errMsg = `Scenario failed: ${scenario.id} (${task})`;
        logFail(errMsg);
        result.errors.push(errMsg);
        result.failed++;
        result.steps.push({
          vmId: step.vmId, hostname: step.hostname,
          application: scenario.application, scenarioId: scenario.id,
          cliOutput: cliResult.output,
        });
        break;
      }

      // For replace_ct tasks: discover the new VM ID (create_ct assigned a new one)
      if (isReplaceCt) {
        const newVm = await findExistingVm(apiUrl, veHost, scenario.application);
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

      // Wait for services if needed (test.json overrides application.json default)
      const appMeta = appMetaMap.get(scenario.application) ?? {};
      const waitSeconds = scenario.wait_seconds ?? appMeta.verification?.wait_seconds ?? 0;
      if (waitSeconds > 0) {
        if (appMeta.extends === "docker-compose") {
          await waitForServices(config.pveHost, config.portPveSsh, step.vmId, waitSeconds);
        } else {
          // For non-docker apps (e.g. oci-image after reboot), wait a fixed time
          logInfo(`Waiting ${waitSeconds}s for container to be ready...`);
          await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        }
      }

      // Run verifications (auto-defaults merged with explicit verify from test.json)
      const defaultVerify = buildDefaultVerify(scenario, appMeta);
      const finalVerify = { ...defaultVerify, ...(scenario.verify ?? {}) };
      // Remove entries explicitly set to false
      for (const [k, v] of Object.entries(finalVerify)) {
        if (v === false) delete finalVerify[k];
      }
      logInfo("Verifying...");
      await verifier.runAll(step.vmId, step.hostname, finalVerify, planned);

      // Create ZFS snapshot after last dependency is installed and verified
      const nextStep = planned[i + 1];
      if (snapshotName && step.isDependency && nextStep && !nextStep.isDependency && !depsRestoredFromSnapshot) {
        try {
          logStep("ZFS", `Creating snapshot @${snapshotName}`);
          // Snapshot each dependency container
          for (const dep of depSteps) {
            const dataset = `rpool/data/subvol-${dep.vmId}-disk-0`;
            nestedSshStrict(config.pveHost, config.portPveSsh,
              `zfs destroy ${dataset}@${snapshotName} 2>/dev/null; zfs snapshot ${dataset}@${snapshotName}`, 30000);
          }
          // Also snapshot the volumes dataset
          nestedSsh(config.pveHost, config.portPveSsh,
            `zfs destroy rpool/data/subvol-999999-oci-lxc-deployer-volumes@${snapshotName} 2>/dev/null; zfs snapshot rpool/data/subvol-999999-oci-lxc-deployer-volumes@${snapshotName}`, 30000);
          logOk(`ZFS snapshot @${snapshotName} created`);
        } catch (err) {
          logInfo(`ZFS snapshot creation failed (non-fatal): ${err}`);
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

// ── Diagnostics collection ──

function collectDiagnostics(
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

// ── Cleanup ──

function cleanupVms(
  planned: PlannedScenario[],
  pveHost: string,
  sshPort: number,
  keepVm: boolean,
) {
  for (const p of [...planned].reverse()) {
    if (p.isDependency) {
      logWarn(`Keeping dependency VM ${p.vmId} (${p.scenario.id})`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else if (keepVm) {
      logWarn(`KEEP_VM set - VM ${p.vmId} not destroyed`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${p.vmId}; pct destroy ${p.vmId}'`);
    } else {
      logInfo(`Cleaning up VM ${p.vmId}...`);
      nestedSsh(pveHost, sshPort,
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
        30000,
      );
    }
  }
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const fixturesFlag = args.includes("--fixtures");
  const queueFlag = args.includes("--queue");
  const filteredArgs = args.filter(a => a !== "--fixtures" && a !== "--queue");
  const instance = filteredArgs[0] || undefined;
  const testArg = filteredArgs[1] || "--all";

  const config = loadConfig(instance);
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");

  console.log("========================================");
  console.log(" OCI LXC Deployer - Live Integration Test");
  console.log("========================================");
  console.log("");
  console.log(`Instance:  ${config.instance}`);
  console.log(`Test:      ${testArg}`);
  console.log(`Deployer:  ${config.deployerUrl} (HTTPS: ${config.deployerHttpsUrl})`);
  console.log(`PVE Host:  ${config.pveHost}:${config.portPveSsh}`);
  console.log(`VE Host:   ${config.veHost}:${config.veSshPort}`);
  console.log(`PVE Web:   ${config.pveWebUrl}`);
  console.log(`SSH:       ssh -p ${config.portPveSsh} root@${config.pveHost}`);
  console.log("");

  // Prerequisites
  logInfo("Checking prerequisites...");

  const tsSource = path.join(projectRoot, "cli/src/oci-lxc-cli.mts");
  const cliPath = path.join(projectRoot, "cli/dist/cli/src/oci-lxc-cli.mjs");
  if (existsSync(tsSource)) {
    logOk("CLI TypeScript source found (dev mode — using tsx)");
  } else if (existsSync(cliPath)) {
    logOk("CLI is built");
  } else {
    logFail(`CLI not found. Run: cd ${projectRoot} && pnpm run build`);
    process.exit(1);
  }

  // Discover API URL
  let apiUrl: string;
  try {
    apiUrl = await discoverApiUrl(config.deployerUrl, config.deployerHttpsUrl);
    logOk(`Deployer API reachable at ${apiUrl}`);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  // Ensure VE host SSH config exists on the deployer
  const veHost = config.veHost;
  const deploySshPort = config.veSshPort;
  let veContextKey = "";
  const veConfigResp = await apiFetch<{ key: string }>(apiUrl, `/api/ssh/config/${encodeURIComponent(veHost)}`);
  if (veConfigResp?.key) {
    veContextKey = veConfigResp.key;
    logOk(`VE host '${veHost}' already configured on deployer`);
  } else {
    logInfo(`VE host '${veHost}' not found on deployer, creating SSH config...`);
    try {
      const resp = await fetch(`${apiUrl}/api/sshconfig`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: veHost, port: deploySshPort, current: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "unknown" }));
        throw new Error(`${resp.status}: ${(err as any).error}`);
      }
      logOk(`VE host '${veHost}' created (port ${deploySshPort}, set as current)`);
      // Fetch the newly created key
      const newConfig = await apiFetch<{ key: string }>(apiUrl, `/api/ssh/config/${encodeURIComponent(veHost)}`);
      if (newConfig?.key) veContextKey = newConfig.key;
    } catch (err: any) {
      logFail(`Failed to create SSH config for '${veHost}': ${err.message}`);
      process.exit(1);
    }
  }

  // Fetch application metadata (stacktypes, extends, tags)
  const appStacktypes = new Map<string, string | string[]>();
  const appMetaMap = new Map<string, AppMeta>();
  const apps = await apiFetch<Array<{ id: string; stacktype?: string | string[]; extends?: string; tags?: string[]; verification?: AppMeta["verification"] }>>(apiUrl, "/api/applications");
  if (apps) {
    for (const app of apps) {
      if (app.stacktype) appStacktypes.set(app.id, app.stacktype);
      appMetaMap.set(app.id, {
        extends: app.extends,
        stacktype: app.stacktype,
        tags: app.tags,
        verification: app.verification,
      });
    }
  }

  // Queue worker mode — delegate all scenario management to the queue API
  if (queueFlag) {
    await runQueueWorker(config, apiUrl, veHost, projectRoot, appMetaMap);
    return;
  }

  // Discover tests via API
  const allTests = await fetchTestScenarios(apiUrl);
  logOk(`Discovered ${allTests.size} test scenario(s)`);

  // Select and resolve dependencies
  let selectedIds: string[];
  try {
    selectedIds = selectScenarios(testArg, allTests);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  let scenariosToRun: ResolvedScenario[];
  try {
    scenariosToRun = collectWithDeps(selectedIds, allTests);
  } catch (err: any) {
    logFail(err.message);
    process.exit(1);
  }

  logOk(`${scenariosToRun.length} scenario(s) to run (including dependencies)`);

  // Plan: assign VM IDs and stack names
  const planned = planScenarios(scenariosToRun, appStacktypes);

  // Mark dependencies vs explicitly selected targets
  const selectedIdSet = new Set(selectedIds);
  for (const p of planned) {
    p.isDependency = !selectedIdSet.has(p.scenario.id);
  }

  // Show plan
  console.log("");
  logInfo("Execution plan:");
  for (const p of planned) {
    const tag = p.isDependency ? " (dep)" : "";
    console.log(`  ${p.scenario.id}: VM ${p.vmId}, stack=${p.stackName}${tag}`);
  }
  console.log("");

  // Pre-test cleanup: smart handling of dependencies vs targets
  for (const p of planned) {
    let status: string;
    try {
      status = nestedSshStrict(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
    } catch (err: any) {
      logFail(`SSH connection failed during pre-cleanup: ${err.message}`);
      process.exit(1);
    }

    const task = p.scenario.task || "installation";
    if (p.isDependency && status.includes("running")) {
      logOk(`Dependency VM ${p.vmId} (${p.scenario.id}) running — reusing`);
      p.skipExecution = true;
    } else if (REPLACE_CT_TASKS.includes(task) && status.includes("running")) {
      // upgrade/reconfigure: keep existing VM, don't destroy
      logOk(`VM ${p.vmId} (${p.scenario.id}) running — ${task} in place`);
    } else if (!p.isDependency || status.includes("status:")) {
      // Target VMs: always try to destroy (even if status check failed)
      // Dependency VMs: only destroy if they exist but aren't running
      logInfo(`Destroying VM ${p.vmId} (${p.scenario.id})...`);
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
        30000);
    }

    // Clean volumes only for targets (not for reused dependencies or replace_ct tasks)
    if (!p.skipExecution && !REPLACE_CT_TASKS.includes(task)) {
      nestedSsh(config.pveHost, config.portPveSsh,
        `find /rpool/data -maxdepth 4 -type d -name ${JSON.stringify(p.hostname)} -path "*/volumes/*" -exec rm -rf {} + 2>/dev/null || true`,
        15000);
    }

    // Verify VM is actually gone (for targets, not replace_ct tasks)
    if (!p.skipExecution && !p.isDependency && !REPLACE_CT_TASKS.includes(task)) {
      const verify = nestedSsh(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
      if (verify.includes("status:")) {
        logFail(`Failed to destroy VM ${p.vmId} — aborting`);
        process.exit(1);
      }
    }
  }

  // Run cleanup SQL on reused dependency VMs (e.g. DROP DATABASE for target apps)
  for (const p of planned) {
    if (p.isDependency || !p.scenario.cleanup) continue;
    for (const [depApp, sql] of Object.entries(p.scenario.cleanup)) {
      const depVm = planned.find(d => d.scenario.application === depApp && d.skipExecution);
      if (depVm) {
        logInfo(`Cleanup SQL on ${depApp} (VM ${depVm.vmId}): ${sql}`);
        // Split into separate -c flags so DROP DATABASE doesn't run inside a transaction
        const sqlParts = sql.split(";").map(s => s.trim()).filter(Boolean);
        const cFlags = sqlParts.map(s => `-c ${JSON.stringify(s)}`).join(" ");
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct exec ${depVm.vmId} -- psql -U postgres ${cFlags}`,
          15000);
      }
    }
  }

  // Pre-create stacks: collect ALL stacktypes across all apps sharing a stack,
  // then create once — the server generates secrets for all stacktype variables.
  // If a stack already exists, reuse it to keep passwords stable across runs.
  const stackAllTypes = new Map<string, Set<string>>();
  for (const p of planned) {
    const rawStacktype = appStacktypes.get(p.scenario.application);
    const stacktypes = rawStacktype ? (Array.isArray(rawStacktype) ? rawStacktype : [rawStacktype]) : [];
    if (stacktypes.length === 0) continue;

    if (!stackAllTypes.has(p.stackName)) {
      stackAllTypes.set(p.stackName, new Set(stacktypes));
    } else {
      for (const st of stacktypes) {
        stackAllTypes.get(p.stackName)!.add(st);
      }
    }
  }

  // Only delete+recreate stacks whose ALL VMs are being destroyed (not reused)
  for (const [stackName, allTypes] of stackAllTypes) {
    const typesArray = [...allTypes];

    // Check if stack already exists
    let stackExists = false;
    try {
      const checkResp = await fetch(`${apiUrl}/api/stack/${stackName}`, {
        signal: AbortSignal.timeout(5000),
      });
      stackExists = checkResp.ok;
    } catch { /* ignore */ }

    if (stackExists) {
      // Check if all VMs using this stack are being re-executed (not reused)
      const stackVms = planned.filter(p => p.stackName === stackName);
      const allDestroyed = stackVms.every(p => !p.skipExecution);
      if (allDestroyed) {
        // All VMs destroyed — delete and recreate stack with fresh passwords
        try {
          await fetch(`${apiUrl}/api/stack/${stackName}`, {
            method: "DELETE", signal: AbortSignal.timeout(5000),
          });
        } catch { /* ignore */ }
        stackExists = false;
      } else {
        logOk(`Stack '${stackName}' exists — reusing (passwords unchanged)`);
      }
    }

    if (!stackExists) {
      try {
        const resp = await fetch(`${apiUrl}/api/stacks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: stackName,
            stacktype: typesArray.length === 1 ? typesArray[0] : typesArray,
            entries: [],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          logOk(`Stack '${stackName}' created (type: ${typesArray.join("+")})`);
        }
      } catch {
        // Stack creation failed — may already exist from concurrent run
      }
    }
  }

  // Execute scenarios sequentially (topologically sorted)
  const keepVm = !!process.env.KEEP_VM;
  const fixtureBaseDir = fixturesFlag
    ? path.join(projectRoot, "frontend/src/test-fixtures")
    : undefined;
  const result = await executeScenarios(planned, config, apiUrl, veHost, projectRoot, appMetaMap, fixtureBaseDir);
  const allResults = [result];

  // Collect diagnostics before cleanup (VMs still running)
  const diagPath = collectDiagnostics(allResults, config.pveHost, config.portPveSsh, projectRoot);
  if (diagPath) {
    logOk(`Diagnostics saved: ${diagPath}`);
  }

  // Cleanup
  cleanupVms(planned, config.pveHost, config.portPveSsh, keepVm);

  // Summary
  const totalPassed = allResults.reduce((s, r) => s + r.passed, 0);
  const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);
  const totalVms = allResults.flatMap((r) => r.steps.map((s) => s.vmId));

  console.log("");
  console.log("========================================");
  console.log(" Test Summary");
  console.log("========================================");
  console.log("");
  console.log(`Instance:     ${config.instance}`);

  for (const r of allResults) {
    const status = r.failed > 0 ? `${RED}FAILED${NC}` : `${GREEN}PASSED${NC}`;
    console.log(`  ${r.name}: ${status} (${r.passed} passed, ${r.failed} failed)`);
    for (const err of r.errors) {
      console.log(`    ${RED}> ${err}${NC}`);
    }
  }

  console.log("");
  console.log(`VMs created:  ${totalVms.join(" ")}`);
  console.log(`Tests Passed: ${totalPassed}`);
  console.log(`Tests Failed: ${totalFailed}`);
  console.log("");

  if (totalFailed > 0) {
    console.log(`${RED}FAILED${NC} - Some tests did not pass`);
    if (!keepVm) {
      console.log("\nTo inspect, re-run with: KEEP_VM=1 ...");
    }
    process.exit(1);
  } else {
    console.log(`${GREEN}PASSED${NC} - All tests passed`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Queue Worker Mode ──

interface QueueNextResponse {
  scenario?: ResolvedScenario;
  vmId?: number;
  hostname?: string;
  stackName?: string;
  wait?: boolean;
  done?: boolean;
}

async function runQueueWorker(
  config: ReturnType<typeof loadConfig>,
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  appMetaMap: Map<string, AppMeta>,
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
      const baseParams = [
        { name: "hostname", value: hostname },
        { name: "bridge", value: config.bridge },
        { name: "vm_id", value: String(vmId) },
      ];
      const templateVars: Record<string, string> = {
        vm_id: String(vmId),
        hostname,
        stack_name: stackName,
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
        paramsObj.stackId = stackName;
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
        // Destroy failed container
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
        await waitForServices(config.pveHost, config.portPveSsh, vmId, waitSeconds);
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

main().catch((err) => {
  console.error(`${RED}Fatal error:${NC}`, err.message || err);
  process.exit(1);
});
