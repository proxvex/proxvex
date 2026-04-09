/**
 * Whole-VM snapshot manager for live integration tests.
 *
 * Creates snapshots of the entire nested PVE VM (QEMU) from the outer
 * Proxmox host using `qm snapshot`. A single snapshot captures everything:
 * all LXC containers, their disks, configs, volumes, and the ZFS pool.
 *
 * For dev instances (deployer runs locally), the local context files
 * (storagecontext.json, secret.txt) are copied to the nested VM before
 * snapshot creation and restored after rollback. This ensures stack
 * passwords match the snapshot state.
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
   * Files are saved as storagecontext-NNN-<label>.json in the context dir.
   */
  private saveContextSnapshot(label: string): void {
    const src = path.join(this.localContextPath, "storagecontext.json");
    if (!existsSync(src)) return;
    // Only save if context is plaintext (not encrypted)
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

  /** Check if a snapshot exists for the nested VM */
  exists(name: string): boolean {
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
   * Called before snapshot creation so passwords are embedded in the snapshot.
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
      // Flush to disk so live snapshot captures the files
      this.nestedSsh("sync");
      // Verify backup was written
      const verify = this.nestedSsh(`ls ${CONTEXT_BACKUP_DIR}/ 2>&1`);
      this.log(`Local context backed up to nested VM (${verify.replace(/\n/g, ", ")})`);
    } catch (err) {
      this.log(`Warning: context backup failed (non-fatal): ${err}`);
    }
  }

  /**
   * Restore local context files from the nested VM.
   * Called after snapshot rollback so passwords match the restored state.
   */
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
   * Create a live snapshot of the entire nested PVE VM.
   * No VM stop needed — ZFS snapshots are atomic.
   * Takes ~2s on ZFS backend.
   */
  create(name: string, buildHash?: string): void {
    this.log(`Creating VM snapshot @${name}...`);

    // Save debug snapshot before backup
    this.saveContextSnapshot(`before-create-${name}`);

    // Backup local context to nested VM (embedded in snapshot)
    this.backupContext();

    // Delete existing snapshot with same name (idempotent)
    try {
      this.outerSsh(
        `qm delsnapshot ${this.nestedVmId} ${name} 2>/dev/null; true`,
        30000,
      );
    } catch { /* ignore */ }

    // Create live snapshot (no VM stop needed, --vmstate 0 skips RAM)
    const desc = buildHash ? `build:${buildHash}` : "livetest";
    this.outerSsh(
      `qm snapshot ${this.nestedVmId} ${name} --vmstate 0 --description ${JSON.stringify(desc)}`,
      30000,
    );

    this.saveContextSnapshot(`after-create-${name}`);
    this.log(`Snapshot @${name} created`);
  }

  /**
   * Rollback the entire nested PVE VM to a snapshot.
   * Stops the VM, rolls back, starts it, waits for SSH.
   * Restores local context files from the VM so passwords match.
   */
  rollback(name: string): void {
    this.log(`Rolling back to @${name}...`);
    this.saveContextSnapshot(`before-rollback-${name}`);

    // Delete snapshots newer than the target so rollback succeeds.
    // PVE requires the target to be the most recent snapshot on each disk.
    try {
      const snapList = this.outerSsh(`qm listsnapshot ${this.nestedVmId}`, 15000);
      const allNames: string[] = [];
      for (const line of snapList.split("\n")) {
        const m = line.match(/[`|]\->\s+(\S+)/);
        if (m && m[1] !== "current") allNames.push(m[1]);
      }
      const targetIdx = allNames.indexOf(name);
      if (targetIdx >= 0) {
        // Delete all snapshots after the target (in reverse order)
        for (let i = allNames.length - 1; i > targetIdx; i--) {
          this.log(`Deleting intermediate snapshot @${allNames[i]}`);
          try {
            this.outerSsh(`qm delsnapshot ${this.nestedVmId} ${allNames[i]}`, 30000);
          } catch { /* ignore — may already be gone */ }
        }
      }
    } catch {
      this.log("Warning: could not clean intermediate snapshots");
    }

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

    // Restore local context from VM (passwords match snapshot state)
    this.restoreContext();
    this.saveContextSnapshot(`after-rollback-${name}`);

    this.log(`Rollback to @${name} complete`);
  }

  /** Delete a snapshot (best-effort, ignores errors) */
  deleteSnapshot(name: string): void {
    try {
      this.outerSsh(`qm delsnapshot ${this.nestedVmId} ${name} 2>/dev/null; true`, 30000);
    } catch { /* ignore */ }
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
   * Check if a snapshot's description contains the expected build hash.
   * Returns true if no buildHash is provided (skip validation).
   */
  private matchesBuild(name: string, buildHash?: string): boolean {
    if (!buildHash) return true;
    try {
      const output = this.outerSsh(
        `qm listsnapshot ${this.nestedVmId}`,
        15000,
      );
      // qm listsnapshot format: " `-> name   date   description"
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
   * If buildHash is provided, only snapshots matching the hash are considered.
   */
  findBestSnapshot(depScenarioIds: string[], buildHash?: string): { name: string; index: number } | null {
    for (let i = depScenarioIds.length - 1; i >= 0; i--) {
      const name = this.snapshotName(depScenarioIds[i]!);
      if (this.exists(name) && this.matchesBuild(name, buildHash)) {
        return { name, index: i };
      }
    }
    return null;
  }
}
