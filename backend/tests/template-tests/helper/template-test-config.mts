import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAsync } from "@src/spawn-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TemplateTestConfig {
  host: string;
  sshPort: number;
  repoRoot: string;
}

export function loadTemplateTestConfig(): TemplateTestConfig {
  const repoRoot = join(__dirname, "..", "..", "..", "..");
  const configPath = join(repoRoot, "e2e", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const instanceName = process.env["E2E_INSTANCE"] || config.default;
  const instance = config.instances[instanceName];

  const resolveEnv = (val: string) =>
    val
      .replace(/\$\{(\w+):-(\w+)\}/g, (_, varName, defaultVal) => process.env[varName] || defaultVal)
      .replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || "");

  return {
    host:
      process.env["TEMPLATE_TEST_HOST"] || resolveEnv(instance?.pveHost || "ubuntupve"),
    sshPort: process.env["TEMPLATE_TEST_SSH_PORT"]
      ? parseInt(process.env["TEMPLATE_TEST_SSH_PORT"], 10)
      : config.ports?.pveSsh || 1022,
    repoRoot,
  };
}

const sshBaseArgs = (config: TemplateTestConfig): string[] => [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-p",
  String(config.sshPort),
  `root@${config.host}`,
];

let _reachableCache: boolean | undefined;
let _skipReason: string | undefined;

/**
 * Checks whether the test host is reachable AND has Proxmox tools available.
 * Result is cached for the lifetime of the process.
 */
export async function isTestHostReachable(
  config: TemplateTestConfig,
): Promise<boolean> {
  if (_reachableCache !== undefined) return _reachableCache;

  // 0. Fast ping check – if host is unreachable, skip immediately
  const ping = await spawnAsync(
    "ping",
    ["-c", "1", "-W", "2", config.host],
    { timeout: 5000 },
  );

  if (ping.exitCode !== 0) {
    _skipReason = `Host not reachable (ping failed): ${config.host}`;
    _reachableCache = false;
    return false;
  }

  // 1. SSH connectivity
  const ssh = await spawnAsync(
    "ssh",
    [
      ...sshBaseArgs(config),
      "-o",
      "ConnectTimeout=5",
      "echo",
      "ok",
    ],
    { timeout: 10000 },
  );

  if (ssh.exitCode !== 0 || ssh.stdout.trim() !== "ok") {
    _skipReason = `SSH not reachable: ${config.host}:${config.sshPort}`;
    _reachableCache = false;
    return false;
  }

  // 2. Proxmox tools available (pct, pveam)
  const pve = await spawnAsync(
    "ssh",
    [...sshBaseArgs(config), "pveversion", "--verbose"],
    { timeout: 10000 },
  );

  if (pve.exitCode !== 0) {
    _skipReason = `Proxmox tools not available on ${config.host} (pveversion failed)`;
    _reachableCache = false;
    return false;
  }

  _reachableCache = true;
  return true;
}

/**
 * Returns the reason why the host was deemed unreachable, or undefined if reachable.
 */
export function getSkipReason(): string | undefined {
  return _skipReason;
}
