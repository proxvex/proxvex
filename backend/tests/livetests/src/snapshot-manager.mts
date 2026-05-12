/**
 * Single-snapshot manager for live integration tests.
 *
 * Creates a single whole-nested-VM snapshot via `qm snapshot` on the outer
 * PVE host (not pct snapshot inside the nested VM). This guarantees an
 * atomic ZFS snapshot of vm-9002-disk-N, which captures all LXC rootfs,
 * all managed volumes, AND the storagecontext-backup on the nested-VM
 * host filesystem in one consistent state.
 *
 * Naming: `dep-stacks-ready` — created once after all stack-provider
 * scenarios (postgres/*, zitadel/*, nginx/*, etc.) have been installed,
 * reused as the rollback target for failed consumer tests.
 *
 * For dev instances (deployer runs locally on macOS), the local context
 * files (storagecontext.json, secret.txt) are copied to the nested VM
 * before snapshot creation and restored after rollback so the local
 * deployer's view stays consistent with the snapshot state.
 */
import { execSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SnapshotConfig {
  enabled: boolean;
}

const CONTEXT_BACKUP_DIR = "/root/.deployer-context-backup";

/**
 * Parse the `deps:a,b,c` segment from a snapshot description, returning a
 * set of captured application names. Returns an empty set for legacy
 * snapshots that pre-date the deps encoding.
 */
function parseDepsFromSnapshotDescription(desc: string): Set<string> {
  for (const segment of desc.split(";")) {
    const m = /^\s*deps:(.*)$/.exec(segment);
    if (m) return new Set(m[1]!.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return new Set();
}

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

  /** SSH to the outer PVE host (port 22) for qm commands */
  private outerSsh(cmd: string, timeout = 60000): string {
    const user = process.env.PVE_SSH_USER || "root";
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 ${user}@${this.outerPveHost} ${JSON.stringify(cmd)}`,
      { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  }

  /** Whether to drive qm via the PVE REST API (Phase A1) instead of SSH. */
  private get useApi(): boolean {
    return process.env.PVE_USE_API === "1"
      && !!process.env.PVE_API_TOKEN_ID
      && !!process.env.PVE_API_TOKEN_SECRET;
  }

  private apiNode(): string {
    return process.env.PVE_NODE || this.outerPveHost;
  }

  /** Authenticated curl against the PVE REST API. Returns stdout text. */
  private apiCurl(args: string[], timeout = 60000): string {
    const ca = process.env.PVE_API_CA || "/etc/pve/pve-root-ca.pem";
    const tokenHeader = `Authorization: PVEAPIToken=${process.env.PVE_API_TOKEN_ID}=${process.env.PVE_API_TOKEN_SECRET}`;
    const caArg = ca === "-" ? ["-k"] : ["--cacert", ca];
    const argv = ["curl", "-fsS", ...caArg, "-H", tokenHeader, ...args]
      .map((a) => JSON.stringify(a)).join(" ");
    return execSync(argv, { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  }

  /** Poll task status until stopped; throws on failure or timeout (s). */
  private apiWaitTask(upid: string, timeoutS = 300): void {
    const url = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/tasks/${encodeURIComponent(upid)}/status`;
    const end = Date.now() + timeoutS * 1000;
    while (Date.now() < end) {
      try {
        const body = this.apiCurl([url], 10000);
        const parsed = JSON.parse(body) as { data?: { status?: string; exitstatus?: string } };
        if (parsed.data?.status === "stopped") {
          const exitstatus = parsed.data.exitstatus ?? "OK";
          // OK and WARNINGS: ... are both successful task completions in PVE.
          if (exitstatus !== "OK" && !exitstatus.startsWith("WARNINGS:")) {
            throw new Error(`PVE task ${upid} failed: ${exitstatus}`);
          }
          return;
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("PVE task")) throw err;
        // transient curl/parse error — retry
      }
      execSync("sleep 1");
    }
    throw new Error(`PVE task ${upid} timeout after ${timeoutS}s`);
  }

  /** List snapshots (API or SSH). Returns `{name, description}` per entry. */
  private listSnapshots(): { name: string; description: string }[] {
    if (this.useApi) {
      const url = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/qemu/${this.nestedVmId}/snapshot`;
      const body = this.apiCurl([url]);
      const parsed = JSON.parse(body) as { data: { name: string; description?: string }[] };
      return parsed.data.map((s) => ({ name: s.name, description: s.description ?? "" }));
    }
    const out = this.outerSsh(`qm listsnapshot ${this.nestedVmId}`, 15000);
    const result: { name: string; description: string }[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/[`|]\->\s+(\S+)\s+\S+\s+\S+(?:\s+(.+))?$/);
      if (m && m[1] !== "current") {
        result.push({ name: m[1], description: (m[2] ?? "").trim() });
      }
    }
    return result;
  }

  /** SSH to the nested PVE VM (via port-forwarded port) */
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

  /** Check if a host-PVE qm snapshot with this name exists for the nested VM */
  exists(name: string): boolean {
    try {
      return this.listSnapshots().some((s) => s.name === name);
    } catch {
      return false;
    }
  }

  /**
   * Backup local deployer context files to the nested VM.
   * Called before snapshot creation so the snapshot embeds the latest
   * passwords/secrets generated by the local deployer.
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
   * Create a whole-nested-VM snapshot on the outer PVE host.
   * Captures all LXC rootfs, managed volumes, and the nested-VM host FS
   * (including the storagecontext-backup dir) in one atomic ZFS snapshot.
   */
  createHostSnapshot(name: string, buildHash?: string, deps?: readonly string[]): void {
    this.log(`Creating snapshot @${name}...`);

    this.saveContextSnapshot(`before-create-${name}`);
    this.backupContext();

    // Sync nested VM filesystem so the snapshot is consistent
    try { this.nestedSsh("sync", 10000); } catch { /* ignore */ }

    // Idempotent: drop existing snapshot with same name
    try {
      if (this.exists(name)) {
        if (this.useApi) {
          const url = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/qemu/${this.nestedVmId}/snapshot/${name}`;
          const upid = JSON.parse(this.apiCurl(["-X", "DELETE", url], 30000)).data;
          this.apiWaitTask(upid, 60);
        } else {
          this.outerSsh(`qm delsnapshot ${this.nestedVmId} ${name}`, 30000);
        }
      }
    } catch { /* ignore */ }

    const parts: string[] = [];
    if (buildHash) parts.push(`build:${buildHash}`);
    if (deps && deps.length > 0) {
      const sorted = [...new Set(deps)].sort();
      parts.push(`deps:${sorted.join(",")}`);
    }
    const desc = parts.length > 0 ? parts.join(";") : "livetest";
    if (this.useApi) {
      const url = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/qemu/${this.nestedVmId}/snapshot`;
      const upid = JSON.parse(this.apiCurl([
        "-X", "POST",
        "--data-urlencode", `snapname=${name}`,
        "--data-urlencode", "vmstate=0",
        "--data-urlencode", `description=${desc}`,
        url,
      ], 60000)).data;
      this.apiWaitTask(upid, 600);
    } else {
      this.outerSsh(
        `qm snapshot ${this.nestedVmId} ${name} --vmstate 0 --description ${JSON.stringify(desc)}`,
        60000,
      );
    }

    this.saveContextSnapshot(`after-create-${name}`);
    this.log(`Snapshot @${name} created`);
  }

  /**
   * Rollback to a whole-nested-VM snapshot on the outer PVE host.
   * Deletes any newer snapshots first (qm requires the target to be the most
   * recent), stops the VM, rolls back, restarts, waits for SSH, and restores
   * the local deployer context from the now-current snapshot state.
   */
  rollbackHostSnapshot(name: string): void {
    this.log(`Rolling back to @${name}...`);
    this.saveContextSnapshot(`before-rollback-${name}`);

    // Delete snapshots newer than target — qm rollback requires the target
    // snapshot to be the most recent one in the chain.
    try {
      const allNames = this.listSnapshots().map((s) => s.name);
      const targetIdx = allNames.indexOf(name);
      if (targetIdx >= 0) {
        for (let i = allNames.length - 1; i > targetIdx; i--) {
          this.log(`Deleting newer snapshot @${allNames[i]}`);
          try {
            if (this.useApi) {
              const url = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/qemu/${this.nestedVmId}/snapshot/${allNames[i]}`;
              const upid = JSON.parse(this.apiCurl(["-X", "DELETE", url], 30000)).data;
              this.apiWaitTask(upid, 60);
            } else {
              this.outerSsh(`qm delsnapshot ${this.nestedVmId} ${allNames[i]}`, 30000);
            }
          } catch { /* ignore */ }
        }
      }
    } catch {
      this.log("Warning: could not enumerate snapshots before rollback");
    }

    try {
      if (this.useApi) {
        const url = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/qemu/${this.nestedVmId}/status/stop`;
        const upid = JSON.parse(this.apiCurl(["-X", "POST", url], 60000)).data;
        this.apiWaitTask(upid, 60);
      } else {
        this.outerSsh(`qm stop ${this.nestedVmId}`, 60000);
      }
    } catch {
      this.log("Warning: qm stop failed (may already be stopped)");
    }

    if (this.useApi) {
      const baseUrl = `https://${this.outerPveHost}:8006/api2/json/nodes/${this.apiNode()}/qemu/${this.nestedVmId}`;
      const rollbackUpid = JSON.parse(this.apiCurl(["-X", "POST", `${baseUrl}/snapshot/${name}/rollback`], 120000)).data;
      this.apiWaitTask(rollbackUpid, 180);
      const startUpid = JSON.parse(this.apiCurl(["-X", "POST", `${baseUrl}/status/start`], 30000)).data;
      this.apiWaitTask(startUpid, 60);
    } else {
      this.outerSsh(`qm rollback ${this.nestedVmId} ${name}`, 120000);
      this.outerSsh(`qm start ${this.nestedVmId}`, 30000);
    }
    this.waitForNestedVm();

    this.restoreContext();
    this.saveContextSnapshot(`after-rollback-${name}`);
    this.log(`Rollback to @${name} complete`);
  }

  /**
   * Check whether a snapshot is safe to reuse for a run that needs the
   * given build hash and dependency set.
   *
   * Snapshot description format (from createHostSnapshot):
   *   build:<hash>;deps:a,b,c
   *
   * Reusable iff:
   *  - buildHash matches (when given — deployer build invalidates otherwise)
   *  - captured deps ⊇ requiredDeps (snapshot has every dep the run needs)
   *
   * Legacy snapshots without a `deps:` segment have an empty captured set,
   * so any run that needs deps will fall back to a fresh install.
   */
  coversRun(name: string, buildHash: string | undefined, requiredDeps: readonly string[]): boolean {
    let desc: string;
    try {
      const snap = this.listSnapshots().find((s) => s.name === name);
      if (!snap) return false;
      desc = snap.description;
    } catch {
      return false;
    }
    if (buildHash && !desc.includes(`build:${buildHash}`)) return false;
    const captured = parseDepsFromSnapshotDescription(desc);
    return requiredDeps.every((d) => captured.has(d));
  }

  /** Wait for the nested VM to become reachable via SSH after boot */
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
}
