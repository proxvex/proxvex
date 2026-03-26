/**
 * Whole-VM snapshot manager for live integration tests.
 *
 * Creates snapshots of the entire nested PVE VM (QEMU) from the outer
 * Proxmox host using `qm snapshot`. A single snapshot captures everything:
 * all LXC containers, their disks, configs, volumes, and the ZFS pool.
 *
 * This eliminates the need for per-container ZFS snapshots, /etc/pve/lxc
 * backup/restore, and VM-ID remapping.
 */
import { execSync } from "node:child_process";

export interface SnapshotConfig {
  enabled: boolean;
}

export class SnapshotManager {
  constructor(
    private outerPveHost: string,
    private nestedVmId: number,
    private nestedSshPort: number,
    private log: (msg: string) => void = console.log,
  ) {}

  /** SSH to the outer PVE host (port 22) for qm commands */
  private outerSsh(cmd: string, timeout = 60000): string {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 root@${this.outerPveHost} ${JSON.stringify(cmd)}`,
      { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  }

  /** SSH to the nested PVE VM (via port-forwarded port) for pct commands */
  private nestedSsh(cmd: string, timeout = 15000): string {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p ${this.nestedSshPort} root@${this.outerPveHost} ${JSON.stringify(cmd)}`,
      { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  }

  /** Generate snapshot name from scenario ID: dep-<app>-<variant> */
  snapshotName(scenarioId: string): string {
    return "dep-" + scenarioId.replace(/\//g, "-");
  }

  /** Check if a snapshot exists for the nested VM */
  exists(name: string): boolean {
    try {
      const output = this.outerSsh(
        `qm listsnapshot ${this.nestedVmId} | grep -q ' ${name} '`,
        15000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a live snapshot of the entire nested PVE VM.
   * No VM stop needed — ZFS snapshots are atomic.
   * Takes ~2s on ZFS backend.
   */
  create(name: string): void {
    this.log(`Creating VM snapshot @${name}...`);

    // Delete existing snapshot with same name (idempotent)
    try {
      this.outerSsh(
        `qm delsnapshot ${this.nestedVmId} ${name} 2>/dev/null; true`,
        30000,
      );
    } catch { /* ignore */ }

    // Create live snapshot (no VM stop needed, --vmstate 0 skips RAM)
    this.outerSsh(
      `qm snapshot ${this.nestedVmId} ${name} --vmstate 0`,
      30000,
    );

    this.log(`Snapshot @${name} created`);
  }

  /**
   * Rollback the entire nested PVE VM to a snapshot.
   * Stops the VM, rolls back, starts it, waits for SSH.
   */
  rollback(name: string): void {
    this.log(`Rolling back to @${name}...`);

    // Stop nested VM
    try {
      this.outerSsh(`qm stop ${this.nestedVmId}`, 60000);
    } catch {
      this.log("Warning: qm stop failed (may already be stopped)");
    }

    // Rollback
    this.outerSsh(`qm rollback ${this.nestedVmId} ${name}`, 120000);

    // Start
    this.outerSsh(`qm start ${this.nestedVmId}`, 30000);

    // Wait for nested VM to be reachable via SSH
    this.waitForNestedVm();

    this.log(`Rollback to @${name} complete`);
  }

  /**
   * Wait for the nested VM to become reachable via SSH after boot.
   * Polls SSH on the port-forwarded port until success or timeout.
   */
  private waitForNestedVm(timeoutMs = 120000): void {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        this.nestedSsh("echo ok", 5000);
        // Extra wait for PVE to start onboot containers
        this.sleep(5);
        return;
      } catch {
        this.sleep(3);
      }
    }
    throw new Error(`Nested VM not reachable via SSH after ${timeoutMs / 1000}s`);
  }

  private sleep(seconds: number): void {
    execSync(`sleep ${seconds}`, { stdio: "ignore" });
  }

  /**
   * Find the best (latest) snapshot for a dependency chain.
   * Walks backwards through deps and returns the first existing snapshot.
   */
  findBestSnapshot(depScenarioIds: string[]): { name: string; index: number } | null {
    for (let i = depScenarioIds.length - 1; i >= 0; i--) {
      const name = this.snapshotName(depScenarioIds[i]!);
      if (this.exists(name)) {
        return { name, index: i };
      }
    }
    return null;
  }
}
