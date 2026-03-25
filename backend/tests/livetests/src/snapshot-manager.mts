/**
 * ZFS snapshot manager for live integration tests.
 *
 * Creates per-dependency ZFS snapshots of all container disks and the
 * shared volumes dataset inside the nested PVE. Each snapshot captures
 * the cumulative state of all dependencies installed up to that point.
 *
 * /etc/pve/lxc is on pmxcfs (FUSE) and NOT included in ZFS snapshots,
 * so we backup/restore it manually to the volumes dataset.
 */
import { execSync } from "node:child_process";

export interface SnapshotConfig {
  enabled: boolean;
}

const PVE_LXC_BACKUP_DIR = "/rpool/data/subvol-999999-oci-lxc-deployer-volumes/.pve-lxc-backup";
const VOLUMES_DATASET = "rpool/data/subvol-999999-oci-lxc-deployer-volumes";

export class SnapshotManager {
  constructor(
    private pveHost: string,
    private pveSshPort: number,
    private log: (msg: string) => void = console.log,
  ) {}

  private ssh(cmd: string, timeout = 30000): string {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p ${this.pveSshPort} root@${this.pveHost} ${JSON.stringify(cmd)}`,
      { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  }

  /** Generate snapshot name from scenario ID: dep-<app>-<variant> */
  snapshotName(scenarioId: string): string {
    return "dep-" + scenarioId.replace(/\//g, "-");
  }

  /** Check if a snapshot exists on the volumes dataset */
  exists(name: string): boolean {
    try {
      this.ssh(`zfs list -t snapshot -o name -H | grep -q '@${name}$'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create ZFS snapshots for all dependency VMs + volumes dataset.
   * 1. Backup /etc/pve/lxc configs to volumes dataset
   * 2. ZFS snapshot each VM disk + volumes dataset
   */
  create(name: string, depVmIds: number[]): void {
    this.log(`Creating ZFS snapshot @${name}...`);

    // 1. Backup /etc/pve/lxc
    try {
      this.ssh(
        `mkdir -p ${PVE_LXC_BACKUP_DIR} && cp -a /etc/pve/lxc/*.conf ${PVE_LXC_BACKUP_DIR}/ 2>/dev/null || true`,
        15000,
      );
    } catch (err) {
      this.log(`Warning: /etc/pve/lxc backup failed (non-fatal): ${err}`);
    }

    // 2. Snapshot each dependency VM disk
    for (const vmId of depVmIds) {
      const dataset = `rpool/data/subvol-${vmId}-disk-0`;
      try {
        this.ssh(
          `zfs destroy ${dataset}@${name} 2>/dev/null; zfs snapshot ${dataset}@${name}`,
          30000,
        );
      } catch (err) {
        this.log(`Warning: snapshot ${dataset}@${name} failed: ${err}`);
      }
    }

    // 3. Snapshot volumes dataset (includes /etc/pve/lxc backup)
    try {
      this.ssh(
        `zfs destroy ${VOLUMES_DATASET}@${name} 2>/dev/null; zfs snapshot ${VOLUMES_DATASET}@${name}`,
        30000,
      );
    } catch (err) {
      this.log(`Warning: volumes snapshot failed: ${err}`);
    }

    this.log(`Snapshot @${name} created`);
  }

  /**
   * Rollback ZFS snapshots for dependency VMs + volumes dataset.
   * 1. Stop dependency containers
   * 2. ZFS rollback each VM disk + volumes dataset
   * 3. Restore /etc/pve/lxc configs from backup
   * 4. Start dependency containers
   */
  rollback(name: string, depVmIds: number[]): void {
    this.log(`Rolling back to @${name}...`);

    // 1. Stop containers
    for (const vmId of depVmIds) {
      this.ssh(`pct stop ${vmId} 2>/dev/null; true`, 30000);
    }

    // 2. Rollback VM disks
    for (const vmId of depVmIds) {
      const dataset = `rpool/data/subvol-${vmId}-disk-0`;
      try {
        this.ssh(`zfs rollback -r ${dataset}@${name}`, 60000);
      } catch (err) {
        this.log(`Warning: rollback ${dataset}@${name} failed: ${err}`);
      }
    }

    // 3. Rollback volumes dataset
    try {
      this.ssh(
        `zfs rollback -r ${VOLUMES_DATASET}@${name}`,
        60000,
      );
    } catch (err) {
      this.log(`Warning: volumes rollback failed: ${err}`);
    }

    // 4. Restore /etc/pve/lxc configs from backup (now restored by volumes rollback)
    try {
      this.ssh(
        `if [ -d ${PVE_LXC_BACKUP_DIR} ]; then cp -a ${PVE_LXC_BACKUP_DIR}/*.conf /etc/pve/lxc/ 2>/dev/null || true; fi`,
        15000,
      );
    } catch (err) {
      this.log(`Warning: /etc/pve/lxc restore failed: ${err}`);
    }

    // 5. Start containers
    for (const vmId of depVmIds) {
      try {
        this.ssh(`pct start ${vmId}`, 30000);
      } catch (err) {
        this.log(`Warning: start VM ${vmId} failed: ${err}`);
      }
    }

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
