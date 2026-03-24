/**
 * VM-level snapshot manager for live integration tests.
 *
 * Snapshots the entire nested PVE VM (qm snapshot) instead of individual
 * LXC containers. This captures all containers, volumes, and state in one
 * atomic operation.
 *
 * /etc/pve/lxc is on pmxcfs (FUSE) and NOT included in ZFS snapshots,
 * so we backup/restore it manually to the volumes dataset.
 */
import { execSync } from "node:child_process";

export interface SnapshotConfig {
  enabled: boolean;
  parentHost: string;
  parentPort: number;
  nestedVmId: number;
}

/** SSH to the root Proxmox host (parent of the nested VM) */
function parentSsh(config: SnapshotConfig, cmd: string, timeout = 30000): string {
  return execSync(
    `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p ${config.parentPort} root@${config.parentHost} ${JSON.stringify(cmd)}`,
    { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

/** SSH to the nested PVE (inside the VM) */
function nestedSsh(config: SnapshotConfig, nestedPort: number, cmd: string, timeout = 30000): string {
  return execSync(
    `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p ${nestedPort} root@${config.parentHost} ${JSON.stringify(cmd)}`,
    { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

const PVE_LXC_BACKUP_DIR = "/rpool/data/subvol-999999-oci-lxc-deployer-volumes/.pve-lxc-backup";

export class SnapshotManager {
  constructor(
    private config: SnapshotConfig,
    private nestedSshPort: number, // e.g. 1022
    private log: (msg: string) => void = console.log,
  ) {}

  /** Generate snapshot name from scenario ID: dep-<app>-<variant> */
  snapshotName(scenarioId: string): string {
    return "dep-" + scenarioId.replace(/\//g, "-");
  }

  /** Check if a snapshot exists on the parent Proxmox */
  exists(name: string): boolean {
    try {
      const result = parentSsh(this.config,
        `qm listsnapshot ${this.config.nestedVmId} | grep -q '${name}'`);
      return true;
    } catch {
      return false;
    }
  }

  /** List all dep-* snapshots */
  listSnapshots(): string[] {
    try {
      const output = parentSsh(this.config,
        `qm listsnapshot ${this.config.nestedVmId}`);
      return output.split("\n")
        .map(line => line.trim().split(/\s+/)[1] ?? "")
        .filter(name => name.startsWith("dep-"));
    } catch {
      return [];
    }
  }

  /**
   * Create a snapshot of the nested VM.
   * 1. Backup /etc/pve/lxc configs (pmxcfs not in ZFS snapshot)
   * 2. qm snapshot on parent Proxmox
   */
  create(name: string, description: string): void {
    this.log(`Creating VM snapshot @${name}...`);

    // 1. Backup /etc/pve/lxc on the nested PVE
    try {
      nestedSsh(this.config, this.nestedSshPort,
        `mkdir -p ${PVE_LXC_BACKUP_DIR} && cp -a /etc/pve/lxc/*.conf ${PVE_LXC_BACKUP_DIR}/ 2>/dev/null || true`,
        15000);
    } catch (err) {
      this.log(`Warning: /etc/pve/lxc backup failed (non-fatal): ${err}`);
    }

    // 2. Delete old snapshot with same name if exists, then create new
    try {
      parentSsh(this.config,
        `qm delsnapshot ${this.config.nestedVmId} ${name} 2>/dev/null || true; qm snapshot ${this.config.nestedVmId} ${name} --description ${JSON.stringify(description)}`,
        120000);
      this.log(`Snapshot @${name} created`);
    } catch (err) {
      throw new Error(`Failed to create snapshot @${name}: ${err}`);
    }
  }

  /**
   * Rollback the nested VM to a snapshot.
   * 1. qm rollback on parent Proxmox (stops + restores VM)
   * 2. Wait for nested PVE SSH to be available
   * 3. Restore /etc/pve/lxc configs from backup
   * 4. Wait for LXC containers to start
   */
  rollback(name: string): void {
    this.log(`Rolling back VM to @${name}...`);

    // 1. Rollback (this stops the VM, restores disk, and restarts)
    parentSsh(this.config,
      `qm rollback ${this.config.nestedVmId} ${name} --start 1`,
      120000);

    // 2. Wait for nested PVE SSH
    this.log(`Waiting for nested PVE to come back online...`);
    const maxWait = 60;
    for (let i = 0; i < maxWait; i++) {
      try {
        nestedSsh(this.config, this.nestedSshPort, "echo ok", 5000);
        break;
      } catch {
        if (i === maxWait - 1) throw new Error(`Nested PVE not reachable after ${maxWait}s`);
        execSync("sleep 1");
      }
    }

    // 3. Restore /etc/pve/lxc configs
    try {
      nestedSsh(this.config, this.nestedSshPort,
        `if [ -d ${PVE_LXC_BACKUP_DIR} ]; then cp -a ${PVE_LXC_BACKUP_DIR}/*.conf /etc/pve/lxc/ 2>/dev/null || true; fi`,
        15000);
    } catch (err) {
      this.log(`Warning: /etc/pve/lxc restore failed (non-fatal): ${err}`);
    }

    // 4. Wait for LXC containers to come up (they auto-start via onboot)
    this.log(`Waiting for containers to start...`);
    execSync("sleep 5");

    this.log(`Rollback to @${name} complete`);
  }

  /**
   * Find the best (latest) snapshot for a dependency chain.
   * Walks backwards through deps and returns the first existing snapshot.
   * That snapshot contains the cumulative state of all previous dependencies.
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
