import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * host-list-unfinished-rebuilds.py against a fake /etc/pve: containers left
 * between clone and replace by a failed reconfigure/upgrade, found by the
 * proxvex-rebuild-of-<source> tag or (clones made before the tag existed)
 * by the rootfs ZFS origin. `pct` and `zfs` are stubbed on PATH.
 */
const repoRoot = path.resolve(__dirname, "../../..");
const libPath = path.join(
  repoRoot,
  "json/shared/scripts/library/lxc_config_parser_lib.py",
);
const scriptPath = path.join(
  repoRoot,
  "json/shared/scripts/list/host-list-unfinished-rebuilds.py",
);

const STORAGE_CFG = `dir: local
\tpath /var/lib/vz

zfspool: local-zfs
\tpool rpool/data
\tcontent images,rootdir
`;

interface Ct {
  vmid: number;
  hostname: string;
  extraNotes?: string;
  extraConfig?: string;
}

function conf(ct: Ct): string {
  return (
    `#<!-- proxvex%3Amanaged -->\n` +
    (ct.extraNotes ?? "") +
    `hostname: ${ct.hostname}\n` +
    `rootfs: local-zfs:subvol-${ct.vmid}-disk-0,size=4G\n` +
    (ct.extraConfig ?? "")
  );
}

describe("host-list-unfinished-rebuilds.py", () => {
  let dir: string;
  let lxcDir: string;
  let binDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "unfinished-rebuilds-"));
    lxcDir = path.join(dir, "lxc");
    binDir = path.join(dir, "bin");
    fs.mkdirSync(lxcDir);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(dir, "storage.cfg"), STORAGE_CFG);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(cts: Ct[]): void {
    for (const ct of cts) {
      fs.writeFileSync(path.join(lxcDir, `${ct.vmid}.conf`), conf(ct));
    }
  }

  /** statuses: vmid -> pct status; origins: dataset -> zfs origin */
  function stubHost(
    statuses: Record<number, string>,
    origins: Record<string, string>,
  ): void {
    const pctCases = Object.entries(statuses)
      .map(([id, s]) => `  ${id}) echo "status: ${s}" ;;`)
      .join("\n");
    fs.writeFileSync(
      path.join(binDir, "pct"),
      `#!/bin/sh\n[ "$1" = status ] || exit 1\ncase "$2" in\n${pctCases}\n  *) exit 2 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const zfsCases = Object.entries(origins)
      .map(([ds, o]) => `  ${ds}) echo "${o}" ;;`)
      .join("\n");
    fs.writeFileSync(
      path.join(binDir, "zfs"),
      `#!/bin/sh\neval "ds=\\$$#"\ncase "$ds" in\n${zfsCases}\n  *) echo "-" ;;\nesac\n`,
      { mode: 0o755 },
    );
  }

  function run(): any[] {
    const combined = path.join(dir, "run.py");
    fs.writeFileSync(
      combined,
      fs.readFileSync(libPath, "utf-8") + "\n" + fs.readFileSync(scriptPath, "utf-8"),
    );
    const result = spawnSync("python3", ["-I", combined], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        LXC_MANAGER_PVE_LXC_DIR: lxcDir,
        LXC_MANAGER_PVE_STORAGE_CFG: path.join(dir, "storage.cfg"),
      },
    });
    if (result.status !== 0) {
      throw new Error(`python3 failed: ${result.stderr || result.stdout}`);
    }
    const out = JSON.parse(result.stdout);
    expect(out[0].id).toBe("unfinished_rebuilds");
    return JSON.parse(out[0].value);
  }

  it("lists a tagged clone next to its unreplaced source", () => {
    write([
      { vmid: 600, hostname: "app" },
      { vmid: 601, hostname: "app", extraConfig: "tags: keep;proxvex-rebuild-of-600\n" },
    ]);
    stubHost({ 600: "running", 601: "stopped" }, {});

    expect(run()).toEqual([
      {
        vm_id: 601,
        hostname: "app",
        status: "stopped",
        source_vm_id: 600,
        source_hostname: "app",
        source_exists: true,
        source_status: "running",
        detected_by: "tag",
        replaced: false,
      },
    ]);
  });

  it("finds untagged clones by ZFS origin and links a rebuild chain", () => {
    // 615 -> 616 -> 617, as left behind by two failed reconfigures
    write([
      { vmid: 615, hostname: "yellow" },
      { vmid: 616, hostname: "yellow" },
      { vmid: 617, hostname: "yellow" },
    ]);
    stubHost(
      { 615: "stopped", 616: "stopped", 617: "running" },
      {
        "rpool/data/subvol-616-disk-0": "rpool/data/subvol-615-disk-0@oci-clone-1792836644",
        "rpool/data/subvol-617-disk-0": "rpool/data/subvol-616-disk-0@oci-clone-1792852073",
      },
    );

    const list = run();
    expect(list.map((e) => [e.vm_id, e.source_vm_id, e.detected_by])).toEqual([
      [616, 615, "zfs-origin"],
      [617, 616, "zfs-origin"],
    ]);
    expect(list[0].superseded_by).toBe(617);
    expect(list[0].cloned_at).toBe("2026-10-24T10:10:44Z");
    expect(list[1].superseded_by).toBeUndefined();
  });

  it("skips finished rebuilds and locked sources", () => {
    write([
      // finished: source marked replaced
      {
        vmid: 630,
        hostname: "e2e",
        extraNotes: "#<!-- proxvex%3Areplaced-at 2026-10-24T10%3A56%3A07Z -->\n",
        extraConfig: "lock: migrate\n",
      },
      { vmid: 631, hostname: "e2e", extraConfig: "tags: proxvex-rebuild-of-630\n" },
      // self-upgrade in flight: source locked, no replaced marker
      { vmid: 640, hostname: "proxvex", extraConfig: "lock: migrate\n" },
      { vmid: 641, hostname: "proxvex" },
    ]);
    stubHost(
      {},
      { "rpool/data/subvol-641-disk-0": "rpool/data/subvol-640-disk-0@oci-clone-1792847278" },
    );

    expect(run()).toEqual([]);
  });

  it("links containers by hostname when nothing else does", () => {
    write([
      // two running with one hostname: the higher vmid counts as new
      { vmid: 700, hostname: "dup" },
      { vmid: 701, hostname: "dup" },
      // several, one running: the running one counts as new
      { vmid: 710, hostname: "multi" },
      { vmid: 712, hostname: "multi" },
      { vmid: 711, hostname: "multi" },
      // replaced and locked siblings do not count
      {
        vmid: 720,
        hostname: "done",
        extraNotes: "#<!-- proxvex%3Areplaced-at 2026-10-24T10%3A56%3A07Z -->\n",
        extraConfig: "lock: migrate\n",
      },
      { vmid: 721, hostname: "done" },
    ]);
    stubHost(
      { 700: "running", 701: "running", 710: "stopped", 711: "running", 712: "stopped", 720: "stopped", 721: "running" },
      {},
    );

    const list = run();
    expect(list.map((e) => [e.source_vm_id, e.vm_id, e.detected_by, e.source_status])).toEqual([
      [700, 701, "hostname", "running"],
      [710, 711, "hostname", "stopped"],
      [712, 711, "hostname", "stopped"],
    ]);
  });

  it("does not repeat a tag-linked pair as a hostname match", () => {
    write([
      { vmid: 800, hostname: "app" },
      { vmid: 801, hostname: "app", extraConfig: "tags: proxvex-rebuild-of-800\n" },
      { vmid: 802, hostname: "app" },
    ]);
    stubHost({ 800: "running", 801: "running", 802: "stopped" }, {});

    expect(run().map((e) => [e.source_vm_id, e.vm_id, e.detected_by])).toEqual([
      [800, 801, "tag"],
      [802, 801, "hostname"],
    ]);
  });

  it("keeps a tag whose source is gone, ignores tags in snapshot sections", () => {
    write([
      { vmid: 650, hostname: "orphan", extraConfig: "tags: proxvex-rebuild-of-777\n" },
      {
        vmid: 660,
        hostname: "snap",
        extraConfig: "[before-upgrade]\ntags: proxvex-rebuild-of-650\n",
      },
    ]);
    stubHost({ 650: "running" }, {});

    const list = run();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      vm_id: 650,
      source_vm_id: 777,
      source_exists: false,
      source_status: "missing",
    });
  });
});
