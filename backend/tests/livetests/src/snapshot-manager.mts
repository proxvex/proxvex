/**
 * Per-Container snapshot manager for live integration tests (pct-only).
 *
 * Schritt 3b der konvergierten Snapshot-Architektur: Whole-VM-Snapshots via
 * `qm snapshot` sind raus — sie stoppen die gesamte nested-VM und sind damit
 * unvereinbar mit Parallelisierung. Stattdessen verwaltet diese Klasse
 * **Per-CT-Snapshots** via `pct snapshot`/`pct rollback`/`pct listsnapshot`.
 * `pct rollback <vmid>` ist container-lokal; andere Cluster (andere vmids)
 * bleiben unberührt → restore ist parallel-sicher.
 *
 * Selbstbeschreibende Description-Format:
 *   build:<hash>;timestamp:<iso>;snap:<name>;members:postgres/default,zitadel/default[;desc:…]
 *
 * Build-Hash steht nur als **Information** in der Description — `coversRun`/
 * `findCoveringSnapshot` lehnen einen Snapshot nicht mehr wegen Build-Hash-
 * Mismatch ab; der Entwickler entscheidet über Refresh via erneutem
 * `livetest --snapshot <name> …`.
 *
 * Infra-Snapshots (`baseline`, `mirrors-ready`, `deployer-installed`) sind
 * step1/step2-script-verwaltet, NICHT durch diese Klasse — Baseline-Reset
 * läuft über das `--fresh`-Skill (direkt via ssh+`qm rollback`, außerhalb
 * des Runners).
 */
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { destroyCloneDescendantsCmd, nestedSshAsync, nestedSshStrictAsync } from "./ssh-helpers.mjs";

export interface SnapshotConfig {
  enabled: boolean;
}

/**
 * Parse the `members:a,b,c` segment from a snapshot description, returning a
 * set of declared member scenario ids (e.g. `postgres/default`,
 * `zitadel/default`). Returns an empty set for descriptions without `members:`.
 *
 * Backwards-compat: legacy descriptions used `deps:` for application names —
 * also accepted as a fallback, treated as scenario-name-less hints.
 */
function parseMembersFromSnapshotDescription(desc: string): Set<string> {
  for (const segment of desc.split(";")) {
    let m = /^\s*members:(.*)$/.exec(segment);
    if (m) return new Set(m[1]!.split(",").map((s) => s.trim()).filter(Boolean));
    m = /^\s*deps:(.*)$/.exec(segment);
    if (m) return new Set(m[1]!.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return new Set();
}

function parseBuildHashFromSnapshotDescription(desc: string): string | undefined {
  for (const segment of desc.split(";")) {
    const m = /^\s*build:(.*)$/.exec(segment);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

function parseTimestampFromSnapshotDescription(desc: string): string | undefined {
  for (const segment of desc.split(";")) {
    const m = /^\s*timestamp:(.*)$/.exec(segment);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

export interface CtSnapshotInfo {
  name: string;
  description: string;
  members: Set<string>;
  buildHash: string | undefined;
  timestamp: string | undefined;
}

/**
 * Find a snapshot name that exists on EVERY required vmid AND whose declared
 * members (taken as the union across the vmids) covers `requiredMembers`.
 * Returns the chosen snapshot name plus per-vmid info, or null when nothing
 * covers the run.
 *
 * Build-Hash-Mismatch wird hier **nicht** abgelehnt — die Caller soll bei
 * Bedarf warnen (siehe SnapshotManager.findCoveringSnapshot).
 */
function selectCoveringSnapshot(
  perVm: { vmid: number; snapshots: CtSnapshotInfo[] }[],
  requiredMembers: ReadonlyArray<string>,
): { name: string; perVmDesc: Map<number, CtSnapshotInfo> } | null {
  if (perVm.length === 0) return null;
  // Names present on every vmid.
  const firstNames = new Set(perVm[0]!.snapshots.map((s) => s.name));
  const candidateNames: string[] = [];
  for (const n of firstNames) {
    if (n === "current") continue;
    if (perVm.every((p) => p.snapshots.some((s) => s.name === n))) {
      candidateNames.push(n);
    }
  }
  // Filter: union of declared members must cover required.
  const required = new Set(requiredMembers);
  let best: { name: string; perVmDesc: Map<number, CtSnapshotInfo>; ts: string } | null = null;
  for (const name of candidateNames) {
    const union = new Set<string>();
    const perVmDesc = new Map<number, CtSnapshotInfo>();
    for (const p of perVm) {
      const snap = p.snapshots.find((s) => s.name === name)!;
      perVmDesc.set(p.vmid, snap);
      for (const m of snap.members) union.add(m);
    }
    const covers = [...required].every((m) => union.has(m));
    if (!covers) continue;
    // Prefer the most recent (timestamp).
    const ts = [...perVmDesc.values()]
      .map((s) => s.timestamp ?? "")
      .sort()
      .at(-1)!;
    if (best === null || ts > best.ts) {
      best = { name, perVmDesc, ts };
    }
  }
  return best === null ? null : { name: best.name, perVmDesc: best.perVmDesc };
}

export { selectCoveringSnapshot, parseMembersFromSnapshotDescription };

export class SnapshotManager {
  private debugIndex = 0;

  constructor(
    private pveHost: string,
    private nestedSshPort: number,
    private log: (msg: string) => void = console.log,
    private localContextPath?: string,
  ) {}

  /**
   * Optional debug helper: save a copy of the local storagecontext for
   * inspection. Only active when DEPLOYER_PLAINTEXT_CONTEXT=1; harmless
   * otherwise.
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

  /**
   * Build the self-describing snapshot description.
   * Format: `build:<hash>;timestamp:<iso>;snap:<name>;members:<csv>[;desc:<text>]`
   */
  static buildDescription(opts: {
    name: string;
    members: ReadonlyArray<string>;
    buildHash?: string;
    desc?: string;
  }): string {
    const parts: string[] = [];
    if (opts.buildHash) parts.push(`build:${opts.buildHash}`);
    parts.push(`timestamp:${new Date().toISOString()}`);
    parts.push(`snap:${opts.name}`);
    const sortedMembers = [...new Set(opts.members)].sort();
    if (sortedMembers.length > 0) parts.push(`members:${sortedMembers.join(",")}`);
    if (opts.desc) parts.push(`desc:${opts.desc.replace(/[;]/g, ",")}`);
    return parts.join(";");
  }

  /**
   * Create a per-CT snapshot. Idempotent: if a snapshot with the same name
   * already exists on this CT, it is dropped first, then re-created — that
   * way an explicit `livetest --snapshot <name> …` rebuild overwrites the
   * stale snapshot deterministically.
   */
  async createCtSnapshot(
    vmid: number,
    name: string,
    description: string,
  ): Promise<void> {
    this.saveContextSnapshot(`before-create-${name}-${vmid}`);
    // Sync filesystem inside the CT for a consistent snapshot.
    try {
      await nestedSshAsync(
        this.pveHost, this.nestedSshPort,
        `pct exec ${vmid} -- sync 2>/dev/null; true`,
        15000,
      );
    } catch { /* ignore */ }

    // Idempotent: drop existing snapshot with same name.
    try {
      const existing = await this.listCtSnapshots(vmid);
      if (existing.some((s) => s.name === name)) {
        this.log(`Dropping existing pct snapshot @${name} on VM ${vmid} (rebuild)`);
        await nestedSshAsync(
          this.pveHost, this.nestedSshPort,
          `pct delsnapshot ${vmid} ${name}`,
          60000,
        );
      }
    } catch { /* best-effort */ }

    this.log(`Creating pct snapshot @${name} on VM ${vmid}...`);
    // pct snapshot description: pipe via stdin to avoid quoting headaches.
    await nestedSshStrictAsync(
      this.pveHost, this.nestedSshPort,
      `pct snapshot ${vmid} ${name} --description "$(cat)"`,
      120000,
      description,
    );
    this.saveContextSnapshot(`after-create-${name}-${vmid}`);
    this.log(`pct snapshot @${name} on VM ${vmid} created`);
  }

  /**
   * Roll a CT back to a named pct snapshot. The CT is stopped, rolled back,
   * and restarted. Container-local — does not affect other CTs.
   */
  async rollbackCtSnapshot(vmid: number, name: string): Promise<void> {
    this.log(`Rolling VM ${vmid} back to pct snapshot @${name}...`);
    // Throw-away CTs zfs-cloned from this one (isolated sources, the
    // reconfigure targets cloned from them, leftovers of an aborted run)
    // keep a newer @oci-clone snapshot alive and block the rollback.
    try {
      await nestedSshAsync(
        this.pveHost, this.nestedSshPort,
        destroyCloneDescendantsCmd(vmid),
        180000,
      );
    } catch { /* best-effort — the rollback below reports a real blocker */ }
    try {
      await nestedSshAsync(
        this.pveHost, this.nestedSshPort,
        `pct stop ${vmid} 2>/dev/null; true`,
        30000,
      );
    } catch { /* best-effort */ }
    await nestedSshStrictAsync(
      this.pveHost, this.nestedSshPort,
      `pct rollback ${vmid} ${name}`,
      120000,
    );
    await nestedSshStrictAsync(
      this.pveHost, this.nestedSshPort,
      `pct start ${vmid}`,
      30000,
    );
    this.log(`pct rollback of VM ${vmid} to @${name} complete`);
  }

  /**
   * List pct snapshots of a single CT. Output of `pct listsnapshot <vmid>`:
   *
   *   `-> snapname               <date>            <description>
   *    `-> current                                  You are here!
   *
   * Returns parsed entries; the `current` entry is filtered out. Empty array
   * when the CT does not exist.
   */
  async listCtSnapshots(vmid: number): Promise<CtSnapshotInfo[]> {
    let out: string;
    try {
      out = await nestedSshAsync(
        this.pveHost, this.nestedSshPort,
        `pct listsnapshot ${vmid} 2>/dev/null`,
        15000,
      );
    } catch { return []; }
    if (!out) return [];
    const result: CtSnapshotInfo[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/[`|]\->\s+(\S+)\s+\S+\s+\S+(?:\s+(.+))?$/);
      if (!m) continue;
      const name = m[1]!;
      if (name === "current") continue;
      const description = (m[2] ?? "").trim();
      result.push({
        name,
        description,
        members: parseMembersFromSnapshotDescription(description),
        buildHash: parseBuildHashFromSnapshotDescription(description),
        timestamp: parseTimestampFromSnapshotDescription(description),
      });
    }
    return result;
  }

  /**
   * Scan the listed CTs and find a snapshot name that exists on EVERY vmid
   * with declared members ⊇ requiredMembers. The chosen name is returned
   * together with per-vmid `CtSnapshotInfo` (so the caller can warn on
   * build-hash mismatch). `null` when nothing covers the run.
   */
  async findCoveringSnapshot(
    vmids: ReadonlyArray<number>,
    requiredMembers: ReadonlyArray<string>,
    currentBuildHash?: string,
  ): Promise<{ name: string; perVmDesc: Map<number, CtSnapshotInfo> } | null> {
    if (vmids.length === 0 || requiredMembers.length === 0) return null;
    const perVm = await Promise.all(
      vmids.map(async (vmid) => ({
        vmid,
        snapshots: await this.listCtSnapshots(vmid),
      })),
    );
    const chosen = selectCoveringSnapshot(perVm, requiredMembers);
    if (chosen && currentBuildHash) {
      // Warn-log on build-hash mismatch (no reject — snapshots live until
      // explicit refresh).
      for (const [vmid, info] of chosen.perVmDesc.entries()) {
        if (info.buildHash && info.buildHash !== currentBuildHash) {
          this.log(
            `Note: snapshot @${chosen.name} on VM ${vmid} built at ${info.buildHash} (now ${currentBuildHash})` +
            `${info.timestamp ? `, taken ${info.timestamp}` : ""} — rebuild via 'livetest --snapshot ${chosen.name} …' when needed`,
          );
        }
      }
    }
    return chosen;
  }
}
