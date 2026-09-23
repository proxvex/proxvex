import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// unprivileged_port_start: an oci-image app is PID 1 and usually runs as a
// non-root uid, so it cannot bind 443. host-install-init-wrapper.sh puts
// /usr/local/sbin/proxvex-init into the rootfs and conf-oci-lxc-configuration.py
// points lxc.init.cmd at it, keeping the original command as arguments.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "json/shared/scripts/pre_start");

describe("unprivileged port start", () => {
  let dir: string;
  let binDir: string;
  let rootfs: string;
  let configFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "unpriv-ports-"));
    binDir = path.join(dir, "bin");
    rootfs = path.join(dir, "rootfs");
    configFile = path.join(dir, "pct-config.txt");
    fs.mkdirSync(binDir);
    fs.mkdirSync(rootfs);
    fs.writeFileSync(configFile, "rootfs: local-zfs:subvol-513-disk-0,size=8G\n");
    // Mock pct: only `config` is used by the script.
    fs.writeFileSync(
      path.join(binDir, "pct"),
      `#!/bin/sh\n[ "$1" = "config" ] && cat "${configFile}"\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The script sources pve-common.sh/vol-common.sh at runtime; the harness
  // replaces the two volume helpers with stubs that point at our temp rootfs.
  function runInstaller(vars: Record<string, string>) {
    let content = fs.readFileSync(path.join(scriptsDir, "host-install-init-wrapper.sh"), "utf-8");
    for (const [k, v] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v);
    }
    const stubs = `vol_get_storage_type() { echo zfspool; }\nvol_mount() { echo "${rootfs}"; }\n`;
    const res = spawnSync("sh", ["-s"], {
      input: stubs + content,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
    return { code: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
  }

  const wrapper = () => path.join(rootfs, "usr/local/sbin/proxvex-init");

  it("writes an executable wrapper that sets the sysctl and execs the app", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    expect(r.code).toBe(0);
    expect(fs.existsSync(wrapper())).toBe(true);
    const body = fs.readFileSync(wrapper(), "utf-8");
    expect(body).toContain("echo 443 > /proc/sys/net/ipv4/ip_unprivileged_port_start");
    expect(body).toContain('exec "$@"');
    expect(fs.statSync(wrapper()).mode & 0o777).toBe(0o755);
  });

  it("really hands the arguments through when executed", () => {
    runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    // The sysctl write fails outside a container; the wrapper must not care.
    const res = spawnSync("sh", [wrapper(), "/bin/echo", "gitea", "web"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("gitea web");
  });

  it("does nothing when the parameter is unset", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "NOT_DEFINED" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("[]");
    expect(fs.existsSync(wrapper())).toBe(false);
  });

  it("rejects a non-numeric port", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443abc" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("must be a number");
  });

  describe("conf-oci-lxc-configuration.py", () => {
    function runConfig(vars: Record<string, string>, existing: string) {
      const conf = path.join(dir, "lxc-conf");
      fs.mkdirSync(path.join(conf, "etc/pve/lxc"), { recursive: true });
      const target = path.join(conf, "etc/pve/lxc/513.conf");
      fs.writeFileSync(target, existing);
      let content = fs.readFileSync(path.join(scriptsDir, "conf-oci-lxc-configuration.py"), "utf-8");
      for (const [k, v] of Object.entries(vars)) {
        content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v);
      }
      // Redirect the two absolute host paths into the temp tree.
      content = content
        .split('config_file = f"/etc/pve/lxc/{vm_id}.conf"')
        .join(`config_file = f"${conf}/etc/pve/lxc/{vm_id}.conf"`)
        .split('log_dir = "/var/log/lxc"')
        .join(`log_dir = "${path.join(dir, "log")}"`);
      const res = spawnSync("python3", ["-"], { input: content, encoding: "utf-8" });
      return { code: res.status, stderr: res.stderr, conf: fs.readFileSync(target, "utf-8") };
    }

    const base = {
      vm_id: "513",
      hostname: "gitea",
      initial_command: "/usr/bin/s6-svscan /etc/s6",
      envs: "",
      extra_envs: "",
      wait_for_network: "true",
    };

    it("prepends the wrapper to lxc.init.cmd", () => {
      const r = runConfig({ ...base, unprivileged_port_start: "443" }, "hostname: gitea\n");
      expect(r.code).toBe(0);
      expect(r.conf).toContain("lxc.init.cmd: /usr/local/sbin/proxvex-init /usr/bin/s6-svscan /etc/s6");
    });

    it("leaves the command alone without the parameter", () => {
      const r = runConfig({ ...base, unprivileged_port_start: "NOT_DEFINED" }, "hostname: gitea\n");
      expect(r.code).toBe(0);
      expect(r.conf).toContain("lxc.init.cmd: /usr/bin/s6-svscan /etc/s6");
      expect(r.conf).not.toContain("proxvex-init");
    });

    it("replaces an existing init command instead of duplicating it", () => {
      const r = runConfig(
        { ...base, unprivileged_port_start: "443" },
        "hostname: gitea\nlxc.init.cmd: /usr/bin/s6-svscan /etc/s6\n",
      );
      expect(r.code).toBe(0);
      expect(r.conf.match(/^lxc\.init\.cmd:/gm)?.length).toBe(1);
      expect(r.conf).toContain("lxc.init.cmd: /usr/local/sbin/proxvex-init /usr/bin/s6-svscan /etc/s6");
    });
  });
});
