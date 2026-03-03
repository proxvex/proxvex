import { spawnAsync, type SpawnAsyncResult } from "@src/spawn-utils.mjs";
import type { TemplateTestConfig } from "./template-test-config.mjs";

export class TestStateManager {
  private sshArgs: string[];

  constructor(private config: TemplateTestConfig) {
    this.sshArgs = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-p",
      String(config.sshPort),
      `root@${config.host}`,
      "sh",
    ];
  }

  async execOnHost(
    command: string,
    timeout = 30000,
  ): Promise<SpawnAsyncResult> {
    return spawnAsync("ssh", this.sshArgs, { input: command, timeout });
  }

  private assertSuccess(
    result: SpawnAsyncResult,
    context: string,
  ): void {
    if (result.exitCode !== 0) {
      throw new Error(
        `${context} failed (exit code ${result.exitCode}):\n` +
          `  stdout: ${result.stdout.trim()}\n` +
          `  stderr: ${result.stderr.trim()}`,
      );
    }
  }

  private async getContainerStatus(
    vmId: string,
  ): Promise<"running" | "stopped" | "absent"> {
    const { stdout, exitCode } = await this.execOnHost(
      `pct status ${vmId} 2>/dev/null`,
    );
    if (exitCode !== 0) return "absent";
    if (stdout.includes("running")) return "running";
    if (stdout.includes("stopped")) return "stopped";
    return "absent";
  }

  async findOsTemplate(osType: "alpine" | "debian"): Promise<string> {
    // Check locally available templates
    const { stdout } = await this.execOnHost("pveam list local");
    const pattern = osType === "alpine" ? /alpine-\d/ : /debian-\d/;
    const lines = stdout.split("\n").filter((l) => pattern.test(l));

    if (lines.length > 0) {
      return lines[lines.length - 1]!.trim().split(/\s+/)[0]!;
    }

    // Download if not available locally
    const updateResult = await this.execOnHost("pveam update", 60000);
    this.assertSuccess(updateResult, "pveam update");

    const { stdout: available } = await this.execOnHost(
      `pveam available --section system | grep '${osType}'`,
    );
    const availableLines = available.split("\n").filter((l) => l.trim());

    if (availableLines.length === 0) {
      throw new Error(`No ${osType} template available for download`);
    }

    const templateFile = availableLines[availableLines.length - 1]!
      .trim()
      .split(/\s+/)[1]!;
    const dlResult = await this.execOnHost(
      `pveam download local ${templateFile}`,
      120000,
    );
    this.assertSuccess(dlResult, `pveam download ${templateFile}`);
    return `local:vztmpl/${templateFile}`;
  }

  private async findStorage(): Promise<string> {
    const { stdout } = await this.execOnHost(
      "pvesm status --content rootdir 2>/dev/null | tail -n +2 | awk '{print $1}' | head -1",
    );
    const storage = stdout.trim();
    if (!storage) {
      throw new Error("No storage with rootdir content found");
    }
    return storage;
  }

  async ensureNoContainer(vmId: string): Promise<void> {
    const status = await this.getContainerStatus(vmId);
    if (status === "absent") return;
    // Unlock first so --force --purge can proceed even with stale locks
    await this.execOnHost(`pct unlock ${vmId} 2>/dev/null || true`, 10000);
    await this.execOnHost(`pct destroy ${vmId} --force --purge`, 30000);
  }

  /**
   * Resolves stale container locks left by interrupted operations.
   * Reads lock state from `pct status` output (more reliable than pct config).
   * - lock=create or lock=destroyed: container is unreliable → unlock + destroy
   * - other locks (migrate, …): unlock only, let normal flow continue
   */
  private async resolveLockIfNeeded(
    vmId: string,
  ): Promise<"absent" | "stopped" | "running"> {
    const { stdout } = await this.execOnHost(
      `pct status ${vmId} 2>/dev/null || true`,
    );
    const lockMatch = stdout.match(/^lock:\s*(\S+)/m);
    if (!lockMatch) return this.getContainerStatus(vmId);

    const lock = lockMatch[1];
    // Unlock first so subsequent commands work
    await this.execOnHost(`pct unlock ${vmId} 2>/dev/null || true`, 10000);

    if (lock === "create" || lock === "destroyed") {
      // Container is in an unusable state – destroy so it can be recreated cleanly
      await this.execOnHost(
        `pct destroy ${vmId} --force --purge 2>/dev/null || true`,
        30000,
      );
      return "absent";
    }
    return this.getContainerStatus(vmId);
  }

  async ensureContainerCreatedStopped(
    vmId: string,
    opts?: {
      hostname?: string;
      osType?: "alpine" | "debian";
      memory?: number;
      storage?: string;
    },
  ): Promise<void> {
    const status = await this.getContainerStatus(vmId);
    if (status === "stopped") return;
    if (status === "running") {
      this.assertSuccess(
        await this.execOnHost(`pct stop ${vmId}`, 30000),
        `pct stop ${vmId}`,
      );
      return;
    }

    const osType = opts?.osType || "alpine";
    const hostname = opts?.hostname || `tmpl-test-${osType}`;
    const memory = opts?.memory || 256;
    const storage = opts?.storage || (await this.findStorage());
    const template = await this.findOsTemplate(osType);

    this.assertSuccess(
      await this.execOnHost(
        `pct create ${vmId} ${template}` +
          ` --hostname ${hostname} --memory ${memory}` +
          ` --rootfs ${storage}:1` +
          ` --net0 name=eth0,bridge=vmbr0,ip=dhcp` +
          ` --unprivileged 1`,
        60000,
      ),
      `pct create ${vmId}`,
    );
  }

  async ensureContainerRunning(
    vmId: string,
    opts?: {
      hostname?: string;
      osType?: "alpine" | "debian";
      memory?: number;
      storage?: string;
    },
  ): Promise<void> {
    let status = await this.getContainerStatus(vmId);
    if (status === "running") return;
    if (status !== "absent") {
      status = await this.resolveLockIfNeeded(vmId);
    }
    if (status === "running") return;
    if (status === "absent") {
      await this.ensureContainerCreatedStopped(vmId, opts);
    }
    this.assertSuccess(
      await this.execOnHost(`pct start ${vmId}`, 30000),
      `pct start ${vmId}`,
    );
  }

  async ensureContainerReady(
    vmId: string,
    opts?: {
      hostname?: string;
      osType?: "alpine" | "debian";
      memory?: number;
      storage?: string;
      timeoutMs?: number;
    },
  ): Promise<void> {
    await this.ensureContainerRunning(vmId, opts);

    const timeout = opts?.timeoutMs || 60000;
    const start = Date.now();
    const sleep = 3000;

    while (Date.now() - start < timeout) {
      const { exitCode } = await this.execOnHost(
        `pct exec ${vmId} -- sh -c 'hostname -i 2>/dev/null && (apk --version 2>/dev/null || dpkg --version 2>/dev/null || true)'`,
      );
      if (exitCode === 0) return;
      await new Promise((r) => setTimeout(r, sleep));
    }

    throw new Error(`Container ${vmId} not ready within ${timeout}ms`);
  }

  async cleanup(vmId: string): Promise<void> {
    await this.ensureNoContainer(vmId);
  }
}
