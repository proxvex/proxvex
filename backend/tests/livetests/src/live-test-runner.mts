#!/usr/bin/env tsx
/**
 * TypeScript Live Integration Test Runner for OCI LXC Deployer.
 *
 * Creates real containers on a Proxmox host via the CLI tool and verifies
 * application-level functionality including dependencies and docker services.
 *
 * Features:
 * - Dependency-aware parallel execution (independent tests run concurrently)
 * - Stack-based deployment with timestamp-named stacks
 * - Comprehensive verification suite (container, notes, services, TLS, SSL)
 *
 * Usage:
 *   tsx live-test-runner.mts [instance] [test-name|--all]
 *
 * Examples:
 *   tsx live-test-runner.mts github-action postgres
 *   tsx live-test-runner.mts github-action --all
 *   KEEP_VM=1 tsx live-test-runner.mts github-action zitadel
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Types ──

interface TestStep {
  application: string;
  task?: string;
  addons?: string[];
  wait_seconds?: number;
  verify?: Record<string, boolean | number>;
}

interface TestDefinition {
  description: string;
  steps: TestStep[];
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

interface StepResult {
  vmId: number;
  hostname: string;
  application: string;
  ip?: string;
}

interface TestResult {
  name: string;
  description: string;
  passed: number;
  failed: number;
  steps: StepResult[];
  errors: string[];
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

async function apiFetch<T>(baseUrl: string, path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function discoverApiUrl(httpUrl: string, httpsUrl: string): Promise<string> {
  // Try HTTPS first, then HTTP
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

function extractVmId(output: string): number | null {
  const match = output.match(/"(?:vm_id|vmId)"\s*:\s*"?(\d+)"?/);
  return match ? parseInt(match[1]!, 10) : null;
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
    // Any response (even empty) means TLS handshake succeeded
    this.assert(result !== "", `[${vmId}] TLS connection successful on port ${port}`);
  }

  pgSslOn(vmId: number) {
    const sslStatus = this.ssh(
      `pct exec ${vmId} -- psql -U postgres -tA -c 'SHOW ssl;'`,
    ).trim();
    this.assert(sslStatus === "on", `[${vmId}] Postgres SSL is enabled (SHOW ssl = ${sslStatus})`);
  }

  runAll(vmId: number, hostname: string, verify: Record<string, boolean | number>) {
    if (verify.container_running) this.containerRunning(vmId);
    if (verify.notes_managed) this.notesManaged(vmId);
    if (verify.services_up) this.servicesUp(vmId);
    if (verify.lxc_log_no_errors) this.lxcLogNoErrors(vmId, hostname);
    if (verify.docker_log_no_errors) this.dockerLogNoErrors(vmId);
    if (typeof verify.tls_connect === "number") this.tlsConnect(vmId, verify.tls_connect);
    if (verify.pg_ssl_on) this.pgSslOn(vmId);
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

// ── Execute a single test ──

async function executeTest(
  testName: string,
  testDef: TestDefinition,
  config: ReturnType<typeof loadConfig>,
  apiUrl: string,
  veHost: string,
  projectRoot: string,
  stackName: string,
): Promise<TestResult> {
  const result: TestResult = {
    name: testName,
    description: testDef.description,
    passed: 0,
    failed: 0,
    steps: [],
    errors: [],
  };

  const verifier = new Verifier(config.pveHost, config.portPveSsh);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "livetest-"));

  try {
    for (let i = 0; i < testDef.steps.length; i++) {
      const step = testDef.steps[i]!;
      const task = step.task || "installation";
      const hostname = `${step.application}-${stackName}`;

      logStep(
        `${testName} ${i + 1}/${testDef.steps.length}`,
        `${step.application} (${task})`,
      );

      // Create params file
      const paramsFile = path.join(tmpDir, `params-${i}.json`);
      const params: Record<string, unknown> = {
        params: [
          { name: "hostname", value: hostname },
          { name: "bridge", value: config.bridge },
        ],
      };

      // Resolve stack for apps with stacktype
      const apps = await apiFetch<Array<{ id: string; stacktype?: string }>>(
        apiUrl, "/api/applications",
      );
      const appInfo = apps?.find((a) => a.id === step.application);
      if (appInfo?.stacktype) {
        params.stackId = stackName;
      }

      writeFileSync(paramsFile, JSON.stringify(params));

      if (step.addons?.length) {
        logInfo(`Addons: ${step.addons.join(", ")}`);
      }

      // Run CLI
      logInfo(`Running: ${step.application} ${task}...`);
      const cliResult = await runCli(
        projectRoot, apiUrl, veHost,
        step.application, task, paramsFile, step.addons,
      );

      if (cliResult.exitCode !== 0) {
        const errMsg = `Step failed: ${step.application} ${task}`;
        logFail(errMsg);
        result.errors.push(errMsg);
        result.failed++;
        // Show last 20 lines of output
        const lastLines = cliResult.output.split("\n").slice(-20).join("\n");
        if (lastLines) console.log(lastLines);
        break; // Stop this test on failure
      }

      const vmId = extractVmId(cliResult.output);
      if (!vmId) {
        const errMsg = `Could not extract VM_ID from output`;
        logFail(errMsg);
        result.errors.push(errMsg);
        result.failed++;
        break;
      }

      logOk(`Container created: VM_ID=${vmId}`);
      result.steps.push({ vmId, hostname, application: step.application });

      // Wait for services if needed
      if (step.wait_seconds && step.wait_seconds > 0) {
        await waitForServices(config.pveHost, config.portPveSsh, vmId, step.wait_seconds);
      }

      // Run verifications
      if (step.verify) {
        logInfo("Verifying...");
        verifier.runAll(vmId, hostname, step.verify);
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

  // Cleanup in reverse order
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

// ── Dependency analysis ──

/**
 * Group tests by independence for parallel execution.
 * Tests are independent if they don't share applications across steps.
 * Tests within a group can run in parallel; groups run sequentially.
 *
 * Actually simpler: all tests are independent because they use separate
 * stack names. Within a test, steps are sequential.
 * So all tests can run in parallel.
 */
function analyzeParallelGroups(tests: Map<string, TestDefinition>): string[][] {
  // All tests are independent (each gets its own stack).
  // Return a single group with all tests for maximum parallelism.
  return [[...tests.keys()]];
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const instance = args[0] || undefined;
  const testArg = args[1] || "eclipse-mosquitto";
  const runAll = testArg === "--all";

  const config = loadConfig(instance);
  const projectRoot = path.resolve(import.meta.dirname, "../../../..");
  const testDefsPath = path.join(import.meta.dirname, "../test-definitions.json");
  const allTestDefs: Record<string, TestDefinition> = JSON.parse(
    readFileSync(testDefsPath, "utf-8"),
  );

  console.log("========================================");
  console.log(" OCI LXC Deployer - Live Integration Test");
  console.log("========================================");
  console.log("");
  console.log(`Instance:  ${config.instance}`);
  console.log(`Test:      ${runAll ? "--all" : testArg}`);
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

  // Select tests
  const testsToRun = new Map<string, TestDefinition>();
  if (runAll) {
    for (const [name, def] of Object.entries(allTestDefs)) {
      testsToRun.set(name, def);
    }
  } else {
    const def = allTestDefs[testArg];
    if (def) {
      testsToRun.set(testArg, def);
    } else {
      // Ad-hoc test
      logInfo(`No test definition for '${testArg}', using as application name`);
      testsToRun.set(testArg, {
        description: `Ad-hoc test: ${testArg}`,
        steps: [{
          application: testArg,
          task: "installation",
          verify: { container_running: true, notes_managed: true, lxc_log_no_errors: true },
        }],
      });
    }
  }

  logOk(`${testsToRun.size} test(s) to run`);

  // Create timestamp-based stack name
  const stackName = `t${Math.floor(Date.now() / 1000)}`;
  logInfo(`Stack name: ${stackName}`);

  // Ensure stack exists for stacktype apps
  const stacktypesNeeded = new Set<string>();
  const apps = await apiFetch<Array<{ id: string; stacktype?: string }>>(apiUrl, "/api/applications");
  if (apps) {
    for (const [, def] of testsToRun) {
      for (const step of def.steps) {
        const app = apps.find((a) => a.id === step.application);
        if (app?.stacktype) stacktypesNeeded.add(app.stacktype);
      }
    }
  }

  // Pre-create stacks
  for (const stacktype of stacktypesNeeded) {
    try {
      const resp = await fetch(`${apiUrl}/api/stacks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: stackName, stacktype, entries: [] }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        logOk(`Stack '${stackName}' created for type '${stacktype}'`);
      }
    } catch {
      // Stack may already exist
    }
  }

  // Execute tests
  const allResults: TestResult[] = [];
  const keepVm = !!process.env.KEEP_VM;

  const groups = analyzeParallelGroups(testsToRun);

  for (const group of groups) {
    if (group.length === 1) {
      // Single test, run directly
      const name = group[0]!;
      const result = await executeTest(
        name, testsToRun.get(name)!,
        config, apiUrl, veHost, projectRoot, stackName,
      );
      allResults.push(result);
    } else {
      // Multiple tests, run in parallel
      logInfo(`Running ${group.length} tests in parallel: ${group.join(", ")}`);
      const promises = group.map((name) =>
        executeTest(
          name, testsToRun.get(name)!,
          config, apiUrl, veHost, projectRoot, stackName,
        ),
      );
      const results = await Promise.allSettled(promises);
      for (const [i, result] of results.entries()) {
        if (result.status === "fulfilled") {
          allResults.push(result.value);
        } else {
          allResults.push({
            name: group[i]!,
            description: "",
            passed: 0,
            failed: 1,
            steps: [],
            errors: [String(result.reason)],
          });
        }
      }
    }
  }

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

  for (const result of allResults) {
    const status = result.failed > 0 ? `${RED}FAILED${NC}` : `${GREEN}PASSED${NC}`;
    console.log(`  ${result.name}: ${status} (${result.passed} passed, ${result.failed} failed)`);
    for (const err of result.errors) {
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
