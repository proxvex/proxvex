import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pve_lxc_ip: the container IP determined from the HOST. The previous
// `pct exec <vmid> -- ip -4 addr show eth0` needed iproute2 inside the guest,
// which the pre-baked debian-docker base image does not ship — checks then
// reported "no IP" for a container that had one, and the failing check
// aborted the installation run.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const library = path.join(repoRoot, "json/shared/scripts/library/ve-global.sh");

describe("pve_lxc_ip", () => {
  let dir: string;
  let binDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxc-ip-"));
    binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Fake host tools; each is a shell script printing what the test wants. */
  function fakeBin(name: string, body: string) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  function run(vmid = "504", iface = "") {
    const call = iface ? `pve_lxc_ip "${vmid}" "${iface}"` : `pve_lxc_ip "${vmid}"`;
    const res = spawnSync("sh", ["-s"], {
      input: `. "${library}"\n${call}\n`,
      env: { PATH: `${binDir}:/usr/bin:/bin` },
      encoding: "utf-8",
    });
    return { code: res.status, out: res.stdout.trim() };
  }

  it("takes the static address from the container config", () => {
    fakeBin("pct", `[ "$1" = "config" ] && echo "net0: name=eth0,bridge=vmbr0,ip=192.168.1.60/24,type=veth"\nexit 0`);
    fakeBin("lxc-info", "exit 1");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("192.168.1.60");
  });

  it("ignores a dhcp config and asks the network namespace instead", () => {
    fakeBin("pct", `[ "$1" = "config" ] && echo "net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth"\nexit 0`);
    fakeBin("lxc-info", 'echo 12345');
    // nsenter runs the HOST ip binary in the container netns; `ip -o addr show
    // eth0` must be honoured so the docker bridges are not picked up.
    fakeBin("nsenter", `
case "$*" in
  *"addr show eth0"*) echo "2: eth0    inet 192.168.1.113/24 brd 192.168.1.255 scope global eth0" ;;
  *) echo "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0" ;;
esac
exit 0`);
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("192.168.1.113");
  });

  it("falls back to guest iproute2 when nsenter is unavailable", () => {
    fakeBin("pct", `
case "$1" in
  config) echo "net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth" ;;
  exec)   echo "    inet 10.0.0.5/24 scope global eth0" ;;
esac
exit 0`);
    fakeBin("lxc-info", "exit 1");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("10.0.0.5");
  });

  it("returns 1 and prints nothing when no address can be found", () => {
    // This is the debian-docker case: no iproute2 in the guest, dhcp config.
    fakeBin("pct", `
case "$1" in
  config) echo "net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth" ;;
  exec)   echo "lxc-attach: Failed to exec \\"ip\\"" >&2; exit 1 ;;
esac
exit 0`);
    fakeBin("lxc-info", "exit 1");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });

  it("honours a non-default interface name", () => {
    fakeBin("pct", `[ "$1" = "config" ] && printf '%s\\n%s\\n' "net0: name=eth0,bridge=vmbr0,ip=192.168.1.60/24" "net1: name=eth1,bridge=vmbr0,ip=192.168.4.60/24"\nexit 0`);
    fakeBin("lxc-info", "exit 1");
    expect(run("504", "eth1").out).toBe("192.168.4.60");
  });
});
