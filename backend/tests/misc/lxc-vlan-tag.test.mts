import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// VLAN tag on net0 (vlan_tag parameter): static-IP reconfiguration keeps or
// sets the tag, and a replace/upgrade keeps the tag of a DHCP container.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "json/shared/scripts/pre_start");

describe("net0 VLAN tag", () => {
  let dir: string;
  let binDir: string;
  let setLog: string;
  let configFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlan-tag-"));
    binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    setLog = path.join(dir, "pct-set.log");
    configFile = path.join(dir, "pct-config.txt");
    fs.writeFileSync(configFile, "");
    // Mock pct: `config` prints the prepared config, `set` records its args.
    fs.writeFileSync(
      path.join(binDir, "pct"),
      `#!/bin/sh
case "$1" in
  config) cat "${configFile}" ;;
  set) shift; printf '%s\\n' "$*" >> "${setLog}" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(script: string, vars: Record<string, string>, replace: [string, string][] = []) {
    let content = fs.readFileSync(path.join(scriptsDir, script), "utf-8");
    for (const [k, v] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v);
    }
    for (const [from, to] of replace) content = content.split(from).join(to);
    const res = spawnSync("sh", ["-s"], {
      input: content,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    const sets = fs.existsSync(setLog) ? fs.readFileSync(setLog, "utf-8").trim().split("\n") : [];
    return { code: res.status, stderr: res.stderr, sets: sets.filter((l) => l) };
  }

  describe("conf-lxc-static-ip.sh", () => {
    const base = {
      vm_id: "601",
      hostname: "app",
      bridge: "vmbr0",
      static_ip: "192.168.1.50/24",
      static_gw: "192.168.1.1",
      static_ip6: "",
      static_gw6: "",
      nameserver4: "",
      nameserver6: "",
    };
    const net0Set = (sets: string[]) => sets.find((l) => l.startsWith("601 --net0 "));

    it("sets the tag from the vlan_tag parameter", () => {
      const r = run("conf-lxc-static-ip.sh", { ...base, vlan_tag: "4" });
      expect(r.code).toBe(0);
      expect(net0Set(r.sets)).toContain(",tag=4");
    });

    it("keeps the tag the container already has when vlan_tag is not set", () => {
      fs.writeFileSync(configFile, "hostname: app\nnet0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth,tag=7\n");
      const r = run("conf-lxc-static-ip.sh", { ...base, vlan_tag: "NOT_DEFINED" });
      expect(r.code).toBe(0);
      expect(net0Set(r.sets)).toContain(",tag=7");
    });

    it("stays untagged without parameter and without existing tag", () => {
      fs.writeFileSync(configFile, "net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth\n");
      const r = run("conf-lxc-static-ip.sh", { ...base, vlan_tag: "" });
      expect(r.code).toBe(0);
      expect(net0Set(r.sets)).not.toContain("tag=");
    });

    it("rejects a non-numeric vlan_tag", () => {
      const r = run("conf-lxc-static-ip.sh", { ...base, vlan_tag: "four" });
      expect(r.code).toBe(2);
      expect(net0Set(r.sets)).toBeUndefined();
    });
  });

  describe("conf-restore-settings.sh", () => {
    function restore(oldNet0: string, newNet0: string) {
      const lxcDir = path.join(dir, "lxc");
      fs.mkdirSync(lxcDir, { recursive: true });
      fs.writeFileSync(path.join(lxcDir, "600.conf"), `hostname: app\nnet0: ${oldNet0}\n`);
      fs.writeFileSync(path.join(lxcDir, "601.conf"), `hostname: app\nnet0: ${newNet0}\n`);
      return run(
        "conf-restore-settings.sh",
        { previous_vm_id: "600", vm_id: "601" },
        [["/etc/pve/lxc", lxcDir]],
      );
    }
    const net0Set = (sets: string[]) => sets.find((l) => l.startsWith("601 --net0 "));

    it("keeps the VLAN tag of a DHCP container the new one lacks", () => {
      const r = restore(
        "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth,tag=4",
        "name=eth0,bridge=vmbr0,host-managed=1,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth",
      );
      expect(r.code).toBe(0);
      expect(net0Set(r.sets)).toBe(
        "601 --net0 name=eth0,bridge=vmbr0,host-managed=1,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth,tag=4",
      );
    });

    it("leaves a tag set by the new install alone", () => {
      const r = restore(
        "name=eth0,bridge=vmbr0,ip=dhcp,type=veth,tag=4",
        "name=eth0,bridge=vmbr0,ip=dhcp,type=veth,tag=9",
      );
      expect(r.code).toBe(0);
      expect(net0Set(r.sets)).toBeUndefined();
    });

    it("does nothing for an untagged DHCP container", () => {
      const r = restore("name=eth0,bridge=vmbr0,ip=dhcp,type=veth", "name=eth0,bridge=vmbr0,ip=dhcp,type=veth");
      expect(r.code).toBe(0);
      expect(net0Set(r.sets)).toBeUndefined();
    });
  });
});
