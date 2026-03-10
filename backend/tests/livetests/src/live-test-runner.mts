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
 *   tsx live-test-runner.mts [instance] [test-name|--all]
 *
 * Examples:
 *   tsx live-test-runner.mts github-action postgres/ssl
 *   tsx live-test-runner.mts github-action zitadel        # runs all zitadel/* + deps
 *   tsx live-test-runner.mts github-action --all
 *   KEEP_VM=1 tsx live-test-runner.mts github-action zitadel/ssl
 */

import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  addons?: string[];
  wait_seconds?: number;
  verify?: Record<string, boolean | number>;
}

/** Discovered scenario with resolved identity */
export interface ResolvedScenario extends TestScenario {
  id: string;
  application: string;
  appTestDir: string;
}

/** Planned scenario ready for execution */
interface PlannedScenario {
  vmId: number;
  hostname: string;
  stackName: string;
  scenario: ResolvedScenario;
  hasStacktype: boolean;
}

interface StepResult {
  vmId: number;
  hostname: string;
  application: string;
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
 * Discover all test scenarios from json/applications/<app>/tests/test.json.
 */
export function discoverTests(projectRoot: string): Map<string, ResolvedScenario> {
  const appsDir = path.join(projectRoot, "json/applications");
  const all = new Map<string, ResolvedScenario>();

  for (const dir of readdirSync(appsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const testFile = path.join(appsDir, dir.name, "tests", "test.json");
    if (!existsSync(testFile)) continue;

    const scenarios: Record<string, TestScenario> = JSON.parse(
      readFileSync(testFile, "utf-8"),
    );
    for (const [name, def] of Object.entries(scenarios)) {
      const id = `${dir.name}/${name}`;
      all.set(id, {
        ...def,
        id,
        application: dir.name,
        appTestDir: path.join(appsDir, dir.name, "tests"),
      });
    }
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

/**
 * Build CLI params array for a scenario.
 * Merges base params with scenario-specific params from <scenario>.json.
 * Supports set mode, append mode (for multiline vars like envs), and file: resolution.
 */
export function buildParams(
  scenario: ResolvedScenario,
  baseParams: { name: string; value: string }[],
  templateVars: Record<string, string>,
): { name: string; value: string }[] {
  const params = baseParams.map((p) => ({ ...p }));

  const scenarioName = scenario.id.split("/")[1]!;
  const paramsPath = path.join(scenario.appTestDir, `${scenarioName}.json`);

  if (!existsSync(paramsPath)) return params;

  let content = readFileSync(paramsPath, "utf-8");

  // Substitute template variables
  for (const [key, val] of Object.entries(templateVars)) {
    content = content.replace(
      new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
      val,
    );
  }

  const extra: { params: ParamEntry[] } = JSON.parse(content);

  for (const p of extra.params) {
    if (p.append) {
      // Append mode: extend multiline variable (e.g. envs)
      const existing = params.find((b) => b.name === p.name);
      const line = `${p.append}=${p.value ?? ""}`;
      if (existing) {
        existing.value = existing.value
          ? `${existing.value}\n${line}`
          : line;
      } else {
        params.push({ name: p.name, value: line });
      }
    } else {
      // Set mode: override or add
      let value = p.value ?? "";
      // Resolve file: paths relative to tests dir
      if (value.startsWith("file:")) {
        const relPath = value.slice(5);
        value = `file:${path.join(scenario.appTestDir, relPath)}`;
      }
      const existing = params.find((b) => b.name === p.name);
      if (existing) {
        existing.value = value;
      } else {
        params.push({ name: p.name, value });
      }
    }
  }

  return params;
}

// ── Configuration ──

function loadConfig(instanceName?: string): {
  instance: string;
  pveHost: string;
  portPveSsh: number;
  deployerUrl: string;
  deployerHttpsUrl: string;
  bridge: string;
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

  // Resolve ${VAR:-default} in pveHost
  const pveHost = inst.pveHost.replace(/\$\{(\w+):-(\w+)\}/g, (_, varName, defaultVal) =>
    process.env[varName] || defaultVal,
  );

  const offset = inst.portOffset;
  const portPveSsh = config.ports.pveSsh + offset;
  const portDeployer = config.ports.deployer + offset;
  const portDeployerHttps = config.ports.deployerHttps + offset;

  return {
    instance,
    pveHost,
    portPveSsh,
    deployerUrl: `http://${pveHost}:${portDeployer}`,
    deployerHttpsUrl: `https://${pveHost}:${portDeployerHttps}`,
    bridge: inst.bridge || "vmbr0",
  };
}

// ── SSH ──

function nestedSsh(
  pveHost: string,
  port: number,
  command: string,
  timeoutMs = 15000,
): string {
  try {
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ` +
      `-o BatchMode=yes -o ConnectTimeout=10 ` +
      `-p ${port} root@${pveHost} ${JSON.stringify(command)}`,
      { timeout: timeoutMs, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim();
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
  app: string,
  task: string,
  paramsFile: string,
  addons?: string[],
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cliPath = path.join(projectRoot, "cli/dist/cli/src/oci-lxc-cli.mjs");
    const args = [
      cliPath, "remote",
      "--server", apiUrl,
      "--ve", veHost,
      "--insecure",
      "--timeout", "600",
      "--quiet",
    ];

    if (addons && addons.length > 0) {
      args.push("--enable-addons", addons.join(","));
    }

    args.push(app, task, paramsFile);

    let output = "";
    const proc = spawn("node", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });

    proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { output += data.toString(); });

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

  dockerLogNoErrors(vmId: number) {
    const errors = this.ssh(
      `pct exec ${vmId} -- sh -c 'for cid in $(docker ps -q); do docker logs $cid 2>&1; done | grep -i error | head -10'`,
    );
    if (!errors) {
      logOk(`[${vmId}] Docker logs clean (no errors)`);
      this.passed++;
    } else {
      logWarn(`[${vmId}] Docker logs contain errors:`);
      errors.split("\n").slice(0, 5).forEach((l) => console.log(`  ${l}`));
    }
  }

  tlsConnect(vmId: number, port: number) {
    const ip = this.ssh(
      `pct exec ${vmId} -- ip -4 addr show eth0 | grep inet | awk '{print $2}' | cut -d/ -f1`,
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

  runAll(vmId: number, hostname: string, verify: Record<string, boolean | number>) {
    if (verify.container_running) this.containerRunning(vmId);
    if (verify.notes_managed) this.notesManaged(vmId);
    if (verify.services_up) this.servicesUp(vmId);
    if (verify.lxc_log_no_errors) this.lxcLogNoErrors(vmId, hostname);
    if (verify.docker_log_no_errors) this.dockerLogNoErrors(vmId);
    if (typeof verify.tls_connect === "number") this.tlsConnect(vmId, verify.tls_connect);
    if (verify.pg_ssl_on) this.pgSslOn(vmId);
    if (verify.db_ssl_connection) this.dbSslConnection(vmId);
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
  appStacktypes: Map<string, string>,
): PlannedScenario[] {
  let nextVmId = VM_ID_START;
  // Group by stacktype: scenarios sharing a stacktype share a stack
  const stackByType = new Map<string, string>();

  return scenarios.map((scenario) => {
    const vmId = nextVmId++;
    const appStacktype = appStacktypes.get(scenario.application);
    const hasStacktype = !!appStacktype;

    let stackName: string;
    if (appStacktype) {
      if (!stackByType.has(appStacktype)) {
        stackByType.set(appStacktype, String(VM_ID_START));
      }
      stackName = stackByType.get(appStacktype)!;
    } else {
      stackName = String(vmId);
    }

    return {
      vmId,
      hostname: `${scenario.application}-${stackName}`,
      stackName,
      scenario,
      hasStacktype,
    };
  });
}

// ── Execute all planned scenarios sequentially ──

async function executeScenarios(
  planned: PlannedScenario[],
  config: ReturnType<typeof loadConfig>,
  apiUrl: string,
  veHost: string,
  projectRoot: string,
): Promise<TestResult> {
  const result: TestResult = {
    name: planned.map((p) => p.scenario.id).join(", "),
    description: planned.map((p) => p.scenario.description).join("; "),
    passed: 0,
    failed: 0,
    steps: [],
    errors: [],
  };

  const verifier = new Verifier(config.pveHost, config.portPveSsh);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "livetest-"));

  try {
    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]!;
      const scenario = step.scenario;
      const task = scenario.task || "installation";

      logStep(
        `${i + 1}/${planned.length}`,
        `${scenario.id} (${task}) [VM ${step.vmId}]`,
      );

      // Build params
      const baseParams = [
        { name: "hostname", value: step.hostname },
        { name: "bridge", value: config.bridge },
        { name: "vm_id", value: String(step.vmId) },
      ];

      const templateVars: Record<string, string> = {
        vm_id: String(step.vmId),
        hostname: step.hostname,
        stack_name: step.stackName,
      };

      const params = buildParams(scenario, baseParams, templateVars);

      // Write params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const paramsObj: Record<string, unknown> = {
        params: params.map((p) => ({ name: p.name, value: p.value })),
      };

      if (step.hasStacktype) {
        paramsObj.stackId = step.stackName;
      }

      writeFileSync(paramsFile, JSON.stringify(paramsObj));

      if (scenario.addons?.length) {
        logInfo(`Addons: ${scenario.addons.join(", ")}`);
      }

      // Run CLI
      logInfo(`Running: ${scenario.application} ${task}...`);
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        scenario.application, task, paramsFile, scenario.addons,
      );

      if (cliResult.exitCode !== 0) {
        const errMsg = `Scenario failed: ${scenario.id} (${task})`;
        logFail(errMsg);
        result.errors.push(errMsg);
        result.failed++;
        const lastLines = cliResult.output.split("\n").slice(-20).join("\n");
        if (lastLines) console.log(lastLines);
        break;
      }

      logOk(`Container created: VM_ID=${step.vmId}, hostname=${step.hostname}`);
      result.steps.push({ vmId: step.vmId, hostname: step.hostname, application: scenario.application });

      // Wait for services if needed
      if (scenario.wait_seconds && scenario.wait_seconds > 0) {
        await waitForServices(config.pveHost, config.portPveSsh, step.vmId, scenario.wait_seconds);
      }

      // Run verifications
      if (scenario.verify) {
        logInfo("Verifying...");
        verifier.runAll(step.vmId, step.hostname, scenario.verify);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  result.passed = verifier.passed;
  result.failed += verifier.failed;
  return result;
}

// ── Cleanup ──

function cleanupVms(
  results: TestResult[],
  pveHost: string,
  sshPort: number,
  keepVm: boolean,
) {
  const allVms = results.flatMap((r) => r.steps.map((s) => s.vmId));
  if (allVms.length === 0) return;

  for (const vmId of allVms.reverse()) {
    if (keepVm) {
      logWarn(`KEEP_VM set - VM ${vmId} not destroyed`);
      console.log(`  ssh -p ${sshPort} root@${pveHost} 'pct stop ${vmId}; pct destroy ${vmId}'`);
    } else {
      logInfo(`Cleaning up VM ${vmId}...`);
      nestedSsh(pveHost, sshPort,
        `pct stop ${vmId} 2>/dev/null || true; pct destroy ${vmId} --force --purge 2>/dev/null || true`,
        30000,
      );
    }
  }
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const instance = args[0] || undefined;
  const testArg = args[1] || "--all";

  const config = loadConfig(instance);
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");

  console.log("========================================");
  console.log(" OCI LXC Deployer - Live Integration Test");
  console.log("========================================");
  console.log("");
  console.log(`Instance:  ${config.instance}`);
  console.log(`Test:      ${testArg}`);
  console.log(`Deployer:  ${config.deployerUrl} (HTTPS: ${config.deployerHttpsUrl})`);
  console.log(`PVE Host:  ${config.pveHost}`);
  console.log("");

  // Prerequisites
  logInfo("Checking prerequisites...");

  const cliPath = path.join(projectRoot, "cli/dist/cli/src/oci-lxc-cli.mjs");
  try {
    readFileSync(cliPath);
    logOk("CLI is built");
  } catch {
    logFail(`CLI not built. Run: cd ${projectRoot} && pnpm run build`);
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

  // Discover VE host
  const sshConfigs = await apiFetch<{ sshs: Array<{ host: string }> }>(apiUrl, "/api/sshconfigs");
  const veHost = sshConfigs?.sshs[0]?.host;
  if (!veHost) {
    logFail("Cannot determine VE host from deployer API");
    process.exit(1);
  }
  logOk(`VE host discovered: ${veHost}`);

  // Discover tests
  const allTests = discoverTests(projectRoot);
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

  // Fetch application stacktypes
  const appStacktypes = new Map<string, string>();
  const apps = await apiFetch<Array<{ id: string; stacktype?: string }>>(apiUrl, "/api/applications");
  if (apps) {
    for (const app of apps) {
      if (app.stacktype) appStacktypes.set(app.id, app.stacktype);
    }
  }

  // Plan: assign VM IDs and stack names
  const planned = planScenarios(scenariosToRun, appStacktypes);

  // Show plan
  console.log("");
  logInfo("Execution plan:");
  for (const p of planned) {
    console.log(`  ${p.scenario.id}: VM ${p.vmId}, stack=${p.stackName}`);
  }
  console.log("");

  // Pre-test cleanup: destroy stale VMs, volumes, and stacks
  const allPlannedVmIds = planned.map((p) => p.vmId);
  const allPlannedHostnames = planned.map((p) => p.hostname);
  const allPlannedStacks = [...new Set(planned.map((p) => p.stackName))];

  for (const vmId of allPlannedVmIds) {
    const status = nestedSsh(config.pveHost, config.portPveSsh,
      `pct status ${vmId} 2>/dev/null && echo exists || true`, 10000);
    if (status.includes("exists")) {
      logInfo(`Cleaning up stale VM ${vmId}...`);
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct stop ${vmId} 2>/dev/null || true; pct destroy ${vmId} --force --purge 2>/dev/null || true`,
        30000);
    }
  }

  for (const hostname of allPlannedHostnames) {
    nestedSsh(config.pveHost, config.portPveSsh,
      `find /rpool/data -maxdepth 4 -type d -name ${JSON.stringify(hostname)} -path "*/volumes/*" -exec rm -rf {} + 2>/dev/null || true`,
      15000);
  }

  for (const stackName of allPlannedStacks) {
    try {
      await fetch(`${apiUrl}/api/stack/${stackName}`, {
        method: "DELETE", signal: AbortSignal.timeout(5000),
      });
    } catch { /* ignore */ }
  }

  // Pre-create stacks
  const createdStacks = new Set<string>();
  for (const p of planned) {
    const stacktype = appStacktypes.get(p.scenario.application);
    if (stacktype && !createdStacks.has(p.stackName)) {
      try {
        const resp = await fetch(`${apiUrl}/api/stacks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: p.stackName, stacktype, entries: [] }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          logOk(`Stack '${p.stackName}' created (type: ${stacktype})`);
          createdStacks.add(p.stackName);
        }
      } catch {
        // Stack may already exist
      }
    }
  }

  // Execute scenarios sequentially (topologically sorted)
  const keepVm = !!process.env.KEEP_VM;
  const result = await executeScenarios(planned, config, apiUrl, veHost, projectRoot);
  const allResults = [result];

  // Cleanup
  cleanupVms(allResults, config.pveHost, config.portPveSsh, keepVm);

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

main().catch((err) => {
  console.error(`${RED}Fatal error:${NC}`, err.message || err);
  process.exit(1);
});
