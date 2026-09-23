import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// clone-as-temp-deployer.sh rebuilds the clone's net0 (new IP, new MAC) instead
// of inheriting it, so every option has to be carried over explicitly. The VLAN
// tag was missing: on a VLAN-aware bridge an untagged veth port gets the bridge
// default PVID (1), not the VLAN the deployer lives in — the clone then carried
// a correct-looking static address in the wrong VLAN and the self-upgrade
// orchestrator waited 300s for an API that could not answer.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = path.join(
  repoRoot,
  "json/applications/proxvex/scripts/create_ct/clone-as-temp-deployer.sh",
);
const libraryPath = path.join(repoRoot, "json/shared/scripts/upgrade-common.sh");

describe("self-upgrade clone keeps the VLAN tag", () => {
  let dir: string;
  let binDir: string;
  let confDir: string;
  let setLog: string;

  const DEPLOYER_CONF = [
    "arch: amd64",
    "hostname: proxvex",
    "memory: 2048",
    "rootfs: local-zfs:subvol-502-disk-0,size=8G",
    "description: proxvex%3Amanaged%0Adeployer-instance%0A",
    "",
  ].join("\n");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clone-tag-"));
    binDir = path.join(dir, "bin");
    confDir = path.join(dir, "lxc");
    setLog = path.join(dir, "pct-set.log");
    fs.mkdirSync(binDir);
    fs.mkdirSync(confDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Fake pct: `config` prints the prepared source config, `set` records its
   * arguments, everything else succeeds silently. A clone copies the source
   * config so the script finds the target conf afterwards.
   */
  function fakePct(net0: string) {
    fs.writeFileSync(path.join(confDir, "502.conf"), `${DEPLOYER_CONF}${net0}\n`);
    fs.writeFileSync(
      path.join(binDir, "pct"),
      `#!/bin/sh
case "$1" in
  list)   printf '%s\n%s\n' "VMID       Status     Lock         Name" "502        running                 proxvex" ;;
  config) cat "${confDir}/502.conf" ;;
  clone)  cp "${confDir}/502.conf" "${confDir}/$3.conf" ;;
  set)    shift; printf '%s\\n' "$*" >> "${setLog}" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    // pvesh get /cluster/nextid — the script asks for a free VMID.
    fs.writeFileSync(path.join(binDir, "pvesh"), "#!/bin/sh\necho 400\n", { mode: 0o755 });
    // ping: every address listed in occupied.txt answers, the rest does not.
    fs.writeFileSync(
      path.join(binDir, "ping"),
      `#!/bin/sh
for a in "$@"; do :; done
grep -qx "$a" "${path.join(dir, "occupied.txt")}" 2>/dev/null && exit 0
exit 1
`,
      { mode: 0o755 },
    );
    if (!fs.existsSync(path.join(dir, "occupied.txt"))) fs.writeFileSync(path.join(dir, "occupied.txt"), "");
  }

  function run() {
    let content = `. "${libraryPath}"\n` + fs.readFileSync(scriptPath, "utf-8");
    const vars: Record<string, string> = {
      previous_vm_id: "502",
      vm_id: "",
      vm_id_start: "400",
      searchdomain: "",
      deployer_base_url: "",
    };
    for (const [k, v] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v);
    }
    content = content.split('CONFIG_DIR="/etc/pve/lxc"').join(`CONFIG_DIR="${confDir}"`);
    const res = spawnSync("sh", ["-s"], {
      input: content,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    const sets = fs.existsSync(setLog) ? fs.readFileSync(setLog, "utf-8").trim().split("\n") : [];
    return { code: res.status, stderr: res.stderr, net0: sets.find((l) => l.includes("--net0")) ?? "" };
  }

  it("carries a static source's tag into the clone", () => {
    fakePct("net0: name=eth0,bridge=vmbr0,tag=4,gw=192.168.4.1,host-managed=1,hwaddr=BC:24:11:01:A9:48,ip=192.168.4.51/24,type=veth");
    const r = run();
    expect(r.net0).toContain("--net0");
    expect(r.net0).toContain(",tag=4");
    // Still a static clone in the same subnet, just a different host part.
    expect(r.net0).toMatch(/ip=192\.168\.4\.\d+\/24/);
    expect(r.net0).not.toContain("ip=192.168.4.51/24");
  });

  it("carries the tag for a dhcp source as well", () => {
    fakePct("net0: name=eth0,bridge=vmbr0,tag=7,host-managed=1,hwaddr=BC:24:11:01:A9:49,ip=dhcp,type=veth");
    const r = run();
    expect(r.net0).toContain("ip=dhcp");
    expect(r.net0).toContain(",tag=7");
  });

  it("skips an address that answers ping and takes the next free one", () => {
    // .52 is what the old heuristic could land on; a foreign Proxmox guest
    // owns it, which produced ECONNREFUSED after the full clone dance.
    fs.writeFileSync(path.join(dir, "occupied.txt"), "192.168.4.52\n192.168.4.53\n");
    fakePct("net0: name=eth0,bridge=vmbr0,tag=4,gw=192.168.4.1,host-managed=1,hwaddr=BC:24:11:01:A9:48,ip=192.168.4.51/24,type=veth");
    const r = run();
    expect(r.net0).toContain("--net0");
    expect(r.net0).not.toContain("192.168.4.52/24");
    expect(r.net0).not.toContain("192.168.4.53/24");
    expect(r.net0).toContain("ip=192.168.4.54/24");
    expect(r.net0).toContain(",tag=4");
  });

  it("fails with a clear message when the neighbourhood is full", () => {
    const full = Array.from({ length: 254 }, (_, i) => `192.168.4.${i + 1}`).join("\n");
    fs.writeFileSync(path.join(dir, "occupied.txt"), `${full}\n`);
    fakePct("net0: name=eth0,bridge=vmbr0,tag=4,gw=192.168.4.1,host-managed=1,hwaddr=BC:24:11:01:A9:48,ip=192.168.4.51/24,type=veth");
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("No free address");
  });

  it("stays untagged when the source is untagged", () => {
    fakePct("net0: name=eth0,bridge=vmbr0,gw=192.168.1.1,hwaddr=BC:24:11:01:A9:50,ip=192.168.1.51/24,type=veth");
    const r = run();
    expect(r.net0).toContain("--net0");
    expect(r.net0).not.toContain("tag=");
  });
});
