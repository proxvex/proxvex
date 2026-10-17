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
    // Default fixture: a non-root app (lxc.init.uid) whose image has a shell
    // and su — the case where the port setting needs the wrapper.
    fs.writeFileSync(configFile, "rootfs: local-zfs:subvol-513-disk-0,size=8G\nlxc.init.uid: 1000\n");
    fs.mkdirSync(path.join(rootfs, "bin"), { recursive: true });
    fs.writeFileSync(path.join(rootfs, "bin/sh"), "");
    fs.writeFileSync(path.join(rootfs, "bin/su"), "");
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
    // Like the backend: variables the caller did not pass become NOT_DEFINED.
    content = content.replace(/\{\{\s*[\w.]+\s*\}\}/g, "NOT_DEFINED");
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
    expect(body).toContain("echo '443' > /proc/sys/net/ipv4/ip_unprivileged_port_start");
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

  const installed = (r: { stdout: string }) =>
    JSON.parse(r.stdout).find((o: { id: string }) => o.id === "init_wrapper_installed")?.value;

  it("does nothing when the parameter is unset", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "NOT_DEFINED" });
    expect(r.code).toBe(0);
    expect(installed(r)).toBe("false");
    expect(fs.existsSync(wrapper())).toBe(false);
  });

  it("reports the wrapper as installed", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    expect(installed(r)).toBe("true");
  });

  // unprivileged_port_start defaults to 443 for every OCI app, so the
  // installer must skip the cases where the wrapper is useless or harmful.
  // A root init is not a root app (gitea: s6 as root, gitea as uid 1000),
  // so root-init images get the wrapper too — no drop tool needed for them.
  it("installs for a root-init image even without a drop tool", () => {
    fs.writeFileSync(configFile, "rootfs: local-zfs:subvol-513-disk-0,size=8G\n");
    fs.rmSync(path.join(rootfs, "bin/su"));
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    expect(r.code).toBe(0);
    expect(installed(r)).toBe("true");
  });

  it("skips a distroless image (no /bin/sh)", () => {
    fs.rmSync(path.join(rootfs, "bin/sh"));
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    expect(installed(r)).toBe("false");
    expect(r.stderr).toContain("no /bin/sh");
    expect(fs.existsSync(wrapper())).toBe(false);
  });

  it("skips a non-root app without a privilege-drop tool", () => {
    fs.rmSync(path.join(rootfs, "bin/su"));
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
    expect(installed(r)).toBe("false");
    expect(r.stderr).toContain("setpriv/su-exec/su");
  });

  it("still installs for a root app when sysctls are requested", () => {
    fs.writeFileSync(configFile, "rootfs: local-zfs:subvol-513-disk-0,size=8G\n");
    const r = runInstaller({ vm_id: "513", container_sysctls: "net.ipv4.ip_forward=1" });
    expect(installed(r)).toBe("true");
    expect(fs.readFileSync(wrapper(), "utf-8")).toContain("ip_forward");
  });

  it("rejects a non-numeric port", () => {
    const r = runInstaller({ vm_id: "513", unprivileged_port_start: "443abc" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("must be a number");
  });

  it("writes container_sysctls and the IPv6 token, token after the sysctls", () => {
    const r = runInstaller({
      vm_id: "513",
      container_sysctls: "net.ipv6.conf.eth0.accept_ra=2\nnet.ipv4.ip_forward = 1\n# comment",
      ipv6_token: "::53",
    });
    expect(r.code).toBe(0);
    const body = fs.readFileSync(wrapper(), "utf-8");
    expect(body).toContain("echo '2' > /proc/sys/net/ipv6/conf/eth0/accept_ra");
    expect(body).toContain("echo '1' > /proc/sys/net/ipv4/ip_forward");
    expect(body).toContain("ip token set '::53' dev eth0");
    // the kernel refuses a token while eth0 ignores RAs → accept_ra first
    expect(body.indexOf("accept_ra")).toBeLessThan(body.indexOf("ip token set"));
  });

  it("rejects non-net sysctls and unsafe values", () => {
    expect(runInstaller({ vm_id: "513", container_sysctls: "kernel.panic=1" }).code).not.toBe(0);
    expect(runInstaller({ vm_id: "513", container_sysctls: "net.x=1;rm" }).code).not.toBe(0);
  });

  it("rejects a token that is not an interface ID", () => {
    const r = runInstaller({ vm_id: "513", ipv6_token: "2a02::53" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("must start with '::'");
  });

  describe("privilege drop (--as)", () => {
    // Executes the generated wrapper with a fake setpriv that records its argv.
    function runWrapperAs(asArg: string, fakeTools: Record<string, string>) {
      runInstaller({ vm_id: "513", unprivileged_port_start: "443" });
      for (const [name, body] of Object.entries(fakeTools)) {
        fs.writeFileSync(path.join(binDir, name), body, { mode: 0o755 });
      }
      return spawnSync("sh", [wrapper(), "--as", asArg, "/bin/echo", "nginx", "-g", "daemon off;"], {
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
        encoding: "utf-8",
      });
    }

    it("drops via setpriv and keeps the app argv intact", () => {
      const res = runWrapperAs("101:101:101", {
        setpriv: `#!/bin/sh\necho "setpriv $*"\n`,
      });
      expect(res.status).toBe(0);
      // the no-op probe (--reuid=0) runs first and prints too; the exec is last
      expect(res.stdout.trim().split("\n").pop()).toBe(
        "setpriv --reuid=101 --regid=101 --clear-groups -- /bin/echo nginx -g daemon off;",
      );
    });

    it("refuses to run the app as root when no drop tool works", () => {
      const res = runWrapperAs("101:101:101", {
        setpriv: "#!/bin/sh\nexit 1\n",
        "su-exec": "#!/bin/sh\nexit 1\n",
        su: "#!/bin/sh\nexit 1\n",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("refusing to run the app as root");
      expect(res.stdout).not.toContain("nginx");
    });
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
      content = content.replace(/\{\{\s*[\w.]+\s*\}\}/g, "NOT_DEFINED");
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
      const r = runConfig({ ...base, init_wrapper_installed: "true" }, "hostname: gitea\n");
      expect(r.code).toBe(0);
      expect(r.conf).toContain("lxc.init.cmd: /usr/local/sbin/proxvex-init /usr/bin/s6-svscan /etc/s6");
    });

    it("leaves the command alone without the parameter", () => {
      const r = runConfig({ ...base, init_wrapper_installed: "false" }, "hostname: gitea\n");
      expect(r.code).toBe(0);
      expect(r.conf).toContain("lxc.init.cmd: /usr/bin/s6-svscan /etc/s6");
      expect(r.conf).not.toContain("proxvex-init");
    });

    it("replaces an existing init command instead of duplicating it", () => {
      const r = runConfig(
        { ...base, init_wrapper_installed: "true" },
        "hostname: gitea\nlxc.init.cmd: /usr/bin/s6-svscan /etc/s6\n",
      );
      expect(r.code).toBe(0);
      expect(r.conf.match(/^lxc\.init\.cmd:/gm)?.length).toBe(1);
      expect(r.conf).toContain("lxc.init.cmd: /usr/local/sbin/proxvex-init /usr/bin/s6-svscan /etc/s6");
    });

    // Most apps have no initial_command: Proxmox starts the image's own
    // command from `entrypoint:` — the wrapper must go there.
    const noCmd = { ...base, initial_command: "NOT_DEFINED", wait_for_network: "" };

    it("wraps the Proxmox entrypoint when there is no initial_command", () => {
      const r = runConfig(
        { ...noCmd, init_wrapper_installed: "true" },
        "hostname: wg\nentrypoint: docker-entrypoint.sh node server.mjs\n",
      );
      expect(r.code).toBe(0);
      expect(r.conf).toContain("entrypoint: /usr/local/sbin/proxvex-init docker-entrypoint.sh node server.mjs");
      // idempotent: a second run must not stack the wrapper
      const again = runConfig(
        { ...noCmd, init_wrapper_installed: "true" },
        r.conf,
      );
      expect(again.conf.match(/proxvex-init/g)?.length).toBe(1);
    });

    it("moves a non-root init user onto the wrapper (--as) and drops lxc.init.uid/gid/groups", () => {
      const r = runConfig(
        { ...noCmd, init_wrapper_installed: "true" },
        "hostname: nginx\nentrypoint: /docker-entrypoint.sh nginx\nlxc.init.uid: 101\nlxc.init.gid: 101\nlxc.init.groups: 101\n",
      );
      expect(r.code).toBe(0);
      expect(r.conf).toContain("entrypoint: /usr/local/sbin/proxvex-init --as 101:101:101 /docker-entrypoint.sh nginx");
      expect(r.conf).not.toMatch(/^lxc\.init\.(uid|gid|groups):/m);
    });

    it("leaves entrypoint and init user alone when 109 skipped the wrapper", () => {
      const conf = "hostname: nginx\nentrypoint: /docker-entrypoint.sh nginx\nlxc.init.uid: 101\n";
      const r = runConfig({ ...noCmd, init_wrapper_installed: "false" }, conf);
      expect(r.conf).toContain("entrypoint: /docker-entrypoint.sh nginx");
      expect(r.conf).toContain("lxc.init.uid: 101");
      expect(r.conf).not.toContain("proxvex-init");
    });

    it("keeps a root init user as is", () => {
      const r = runConfig(
        { ...noCmd, init_wrapper_installed: "true" },
        "hostname: gitea\nentrypoint: /usr/bin/entrypoint\n",
      );
      expect(r.conf).toContain("entrypoint: /usr/local/sbin/proxvex-init /usr/bin/entrypoint");
      expect(r.conf).not.toContain("--as");
    });
  });
});
