/**
 * Per-container snapshot manager for live integration tests.
 *
 * Creates snapshots of individual LXC containers using `pct snapshot`
 * on the nested PVE host. Each snapshot captures the container's rootfs
 * and all Proxmox-managed volumes automatically.
 *
 * A dependency-group snapshot (e.g. "dep-zitadel-default") is applied
 * to all containers in the group (postgres + zitadel).
 *
 * For dev instances (deployer runs locally), the local context files
 * (storagecontext.json, secret.txt) are copied to the nested VM before
 * snapshot creation and restored after rollback.
 */
import { execSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SnapshotConfig {
  enabled: boolean;
}

const CONTEXT_BACKUP_DIR = "/root/.deployer-context-backup";

export class SnapshotManager {
  private debugIndex = 0;

  constructor(
    private outerPveHost: string,
    private nestedVmId: number,
    private nestedSshPort: number,
    private log: (msg: string) => void = console.log,
    private localContextPath?: string,
  ) {}

  /**
   * Save a copy of the storagecontext for debugging.
   * Only active when DEPLOYER_PLAINTEXT_CONTEXT=1.
   */
  private saveContextSnapshot(label: string): void {
    if (!this.localContextPath) return;
    const src = path.join(this.localContextPath, "storagecontext.json");
    if (!existsSync(src)) return;
    try {
      const head = readFileSync(src, "utf-8").slice(0, 4);
      if (head === "enc:") return;
    } catch { return; }
    try {
      const idx = String(this.debugIndex++).padStart(3, "0");
      const dest = path.join(this.localContextPath, `storagecontext-${idx}-${label}.json`);
      copyFileSync(src, dest);
      this.log(`Context snapshot saved: ${path.basename(dest)}`);
    } catch { /* ignore */ }
  }

  /** SSH to the outer PVE host (port 22) for qm commands (baseline only) */
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

  /** SCP files to the nested VM */
  private scpToNested(localFile: string, remotePath: string): void {
    execSync(
      `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -P ${this.nestedSshPort} ${JSON.stringify(localFile)} root@${this.outerPveHost}:${JSON.stringify(remotePath)}`,
      { timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  }

  /** SCP files from the nested VM */
  private scpFromNested(remotePath: string, localFile: string): void {
    execSync(
      `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -P ${this.nestedSshPort} root@${this.outerPveHost}:${JSON.stringify(remotePath)} ${JSON.stringify(localFile)}`,
      { timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  }

  /** Generate snapshot name from scenario ID: dep-<app>-<variant> */
  snapshotName(scenarioId: string): string {
    return "dep-" + scenarioId.replace(/\//g, "-");
  }

  /** Check if a snapshot exists on a specific container */
  private existsOnContainer(vmId: number, name: string): boolean {
    try {
      this.nestedSsh(
        `pct listsnapshot ${vmId} 2>/dev/null | grep -q ' ${name} \\| ${name}$'`,
        10000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a snapshot exists on ALL containers in the group.
   * Falls back to qm snapshot check for backward compatibility with old snapshots.
   */
  exists(name: string, vmIds?: number[]): boolean {
    if (vmIds && vmIds.length > 0) {
      return vmIds.every((vmId) => this.existsOnContainer(vmId, name));
    }
    // Fallback: check qm snapshot (old whole-VM snapshots)
    try {
      this.outerSsh(
        `qm listsnapshot ${this.nestedVmId} | grep -q ' ${name} '`,
        15000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Backup local context files to the nested VM.
   * Called before snapshot creation so passwords are embedded.
   */
  private backupContext(): void {
    if (!this.localContextPath) return;

    const ctxFile = `${this.localContextPath}/storagecontext.json`;
    const secretFile = `${this.localContextPath}/secret.txt`;

    if (!existsSync(ctxFile) && !existsSync(secretFile)) return;

    try {
      this.nestedSsh(`mkdir -p ${CONTEXT_BACKUP_DIR}`);
      if (existsSync(ctxFile)) {
        this.scpToNested(ctxFile, `${CONTEXT_BACKUP_DIR}/storagecontext.json`);
      }
      if (existsSync(secretFile)) {
        this.scpToNested(secretFile, `${CONTEXT_BACKUP_DIR}/secret.txt`);
      }
      this.nestedSsh("sync");
      const verify = this.nestedSsh(`ls ${CONTEXT_BACKUP_DIR}/ 2>&1`);
      this.log(`Local context backed up to nested VM (${verify.replace(/\n/g, ", ")})`);
    } catch (err) {
      this.log(`Warning: context backup failed (non-fatal): ${err}`);
    }
  }

  /** Public wrapper for restoreContext (used for retry after failed reload) */
  restoreContextPublic(): void { this.restoreContext(); }

  private restoreContext(): void {
    if (!this.localContextPath) return;

    try {
      this.scpFromNested(
        `${CONTEXT_BACKUP_DIR}/storagecontext.json`,
        `${this.localContextPath}/storagecontext.json`,
      );
      this.scpFromNested(
        `${CONTEXT_BACKUP_DIR}/secret.txt`,
        `${this.localContextPath}/secret.txt`,
      );
      this.log("Local context restored from snapshot");
    } catch (err) {
      this.log(`Warning: context restore failed (non-fatal): ${err}`);
    }
  }

  /**
   * Create per-container snapshots for a dependency group.
   * Each container in vmIds gets a snapshot with the given name.
   */
  create(name: string, buildHash?: string, vmIds?: number[]): void {
    this.log(`Creating snapshot @${name}...`);

    this.saveContextSnapshot(`before-create-${name}`);
    this.backupContext();

    if (vmIds && vmIds.length > 0) {
      // Per-container snapshots via pct
      const desc = buildHash ? `build:${buildHash}` : "livetest";
      for (const vmId of vmIds) {
        // Delete existing snapshot with same name (idempotent)
        try {
          this.nestedSsh(`pct delsnapshot ${vmId} ${name} 2>/dev/null; true`, 30000);
        } catch { /* ignore */ }

        this.nestedSsh(
          `pct snapshot ${vmId} ${name} --description ${JSON.stringify(desc)}`,
          30000,
        );
        this.log(`  pct snapshot ${vmId} @${name}`);
      }
    } else {
      // Fallback: whole-VM snapshot (for baseline etc.)
      try {
        this.outerSsh(
          `qm delsnapshot ${this.nestedVmId} ${name} 2>/dev/null; true`,
          30000,
        );
      } catch { /* ignore */ }

      const desc = buildHash ? `build:${buildHash}` : "livetest";
      this.outerSsh(
        `qm snapshot ${this.nestedVmId} ${name} --vmstate 0 --description ${JSON.stringify(desc)}`,
        30000,
      );
    }

    this.saveContextSnapshot(`after-create-${name}`);
    this.log(`Snapshot @${name} created`);
  }

  /**
   * Rollback per-container snapshots for a dependency group.
   * Each container is stopped, rolled back, and started.
   * No VM reboot needed — other containers stay running.
   */
  rollback(name: string, vmIds?: number[]): void {
    this.log(`Rolling back to @${name}...`);
    this.saveContextSnapshot(`before-rollback-${name}`);

    if (vmIds && vmIds.length > 0) {
      // Per-container rollback via pct
      for (const vmId of vmIds) {
        // Delete snapshots newer than target on this container
        try {
          const snapList = this.nestedSsh(`pct listsnapshot ${vmId}`, 10000);
          const allNames: string[] = [];
          for (const line of snapList.split("\n")) {
            const m = line.match(/[`|]\->\s+(\S+)/);
            if (m && m[1] !== "current") allNames.push(m[1]);
          }
          const targetIdx = allNames.indexOf(name);
          if (targetIdx >= 0) {
            for (let i = allNames.length - 1; i > targetIdx; i--) {
              this.log(`  Deleting @${allNames[i]} on CT ${vmId}`);
              try {
                this.nestedSsh(`pct delsnapshot ${vmId} ${allNames[i]}`, 30000);
              } catch { /* ignore */ }
            }
          }
        } catch {
          this.log(`Warning: could not clean intermediate snapshots on CT ${vmId}`);
        }

        try {
          this.nestedSsh(`pct stop ${vmId} 2>/dev/null; true`, 30000);
          this.nestedSsh(`pct rollback ${vmId} ${name}`, 60000);
          this.nestedSsh(`pct start ${vmId}`, 30000);
          this.log(`  pct rollback ${vmId} @${name}`);
        } catch (err) {
          this.log(`Warning: rollback of CT ${vmId} failed: ${err}`);
        }
      }
    } else {
      // Fallback: whole-VM rollback (old snapshots)
      try {
        const snapList = this.outerSsh(`qm listsnapshot ${this.nestedVmId}`, 15000);
        const allNames: string[] = [];
        for (const line of snapList.split("\n")) {
          const m = line.match(/[`|]\->\s+(\S+)/);
          if (m && m[1] !== "current") allNames.push(m[1]);
        }
        const targetIdx = allNames.indexOf(name);
        if (targetIdx >= 0) {
          for (let i = allNames.length - 1; i > targetIdx; i--) {
            this.log(`Deleting intermediate snapshot @${allNames[i]}`);
            try {
              this.outerSsh(`qm delsnapshot ${this.nestedVmId} ${allNames[i]}`, 30000);
            } catch { /* ignore */ }
          }
        }
      } catch {
        this.log("Warning: could not clean intermediate snapshots");
      }

      try {
        this.outerSsh(`qm stop ${this.nestedVmId}`, 60000);
      } catch {
        this.log("Warning: qm stop failed (may already be stopped)");
      }

      this.outerSsh(`qm rollback ${this.nestedVmId} ${name}`, 120000);
      this.outerSsh(`qm start ${this.nestedVmId}`, 30000);
      this.waitForNestedVm();
    }

    this.restoreContext();
    this.saveContextSnapshot(`after-rollback-${name}`);
    this.log(`Rollback to @${name} complete`);
  }

  /** Delete a snapshot from all containers in the group */
  deleteSnapshot(name: string, vmIds?: number[]): void {
    if (vmIds && vmIds.length > 0) {
      for (const vmId of vmIds) {
        try {
          this.nestedSsh(`pct delsnapshot ${vmId} ${name} 2>/dev/null; true`, 30000);
        } catch { /* ignore */ }
      }
    } else {
      try {
        this.outerSsh(`qm delsnapshot ${this.nestedVmId} ${name} 2>/dev/null; true`, 30000);
      } catch { /* ignore */ }
    }
  }

  /**
   * Wait for the nested VM to become reachable via SSH after boot.
   */
  private waitForNestedVm(timeoutMs = 120000): void {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        this.nestedSsh("echo ok", 5000);
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
   * Check if a snapshot's description matches the build hash.
   * Uses pct listsnapshot on the first vmId, or qm listsnapshot as fallback.
   */
  private matchesBuild(name: string, buildHash?: string, vmIds?: number[]): boolean {
    if (!buildHash) return true;
    try {
      let output: string;
      if (vmIds && vmIds.length > 0) {
        output = this.nestedSsh(`pct listsnapshot ${vmIds[0]}`, 10000);
      } else {
        output = this.outerSsh(`qm listsnapshot ${this.nestedVmId}`, 15000);
      }
      for (const line of output.split("\n")) {
        if (line.includes(` ${name} `) || line.includes(` ${name}\t`)) {
          return line.includes(`build:${buildHash}`);
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Find the best (latest) snapshot for a dependency chain.
   * Walks backwards through deps and returns the first existing snapshot.
   * vmIdMap maps scenario index to the list of VMIDs in that dependency group.
   */
  findBestSnapshot(
    depScenarioIds: string[],
    buildHash?: string,
    vmIdMap?: Map<number, number[]>,
  ): { name: string; index: number } | null {
    for (let i = depScenarioIds.length - 1; i >= 0; i--) {
      const name = this.snapshotName(depScenarioIds[i]!);
      const vmIds = vmIdMap?.get(i);
      if (this.exists(name, vmIds) && this.matchesBuild(name, buildHash, vmIds)) {
        return { name, index: i };
      }
    }
    return null;
  }
}
