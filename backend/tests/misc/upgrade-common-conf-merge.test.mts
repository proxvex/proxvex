import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for upgrade-common.sh library functions:
 * - apply_new_conf_to_backup: reverse-merge new conf into backup
 * - update_notes_version: update version/OCI image in notes
 * - update_notes_vmid: update VMID references in notes
 *
 * These functions operate purely on text files — no PVE host required.
 */

/** Backup conf: full PVE config with URL-encoded notes (as written by pct set --description) */
const BACKUP_CONF = `#<!-- oci-lxc-deployer%3Amanaged -->
#<!-- oci-lxc-deployer%3Aoci-image ghcr.io/modbus2mqtt/oci-lxc-deployer -->
#<!-- oci-lxc-deployer%3Aapplication-id oci-lxc-deployer -->
#<!-- oci-lxc-deployer%3Aapplication-name oci-lxc-deployer -->
#<!-- oci-lxc-deployer%3Aversion 0.3.4 -->
#<!-- oci-lxc-deployer%3Alog-url http%3A//myhost.cluster%3A3201/logs/ve_pve1.cluster/105 -->
#<!-- oci-lxc-deployer%3Aicon-url data%3Aimage/svg+xml;base64,... -->
#<!-- oci-lxc-deployer%3Ausername lxc -->
#<!-- oci-lxc-deployer%3Auid 1001 -->
#<!-- oci-lxc-deployer%3Agid 1001 -->
## oci-lxc-deployer
#
#Managed by [oci-lxc-deployer](http%3A//myhost.cluster%3A3201/).
#
#Version%3A 0.3.4
#
#OCI image%3A ghcr.io/modbus2mqtt/oci-lxc-deployer
#
#Log file%3A /var/log/lxc/oci-lxc-deployer-105.log
#
### Links
#- [Console Logs](http%3A//myhost.cluster%3A3201/logs/ve_pve1.cluster/105)
arch: amd64
cmode: console
cores: 2
entrypoint: /usr/local/bin/entrypoint-wrapper.sh oci-lxc-deployer --local /config
hostname: oci-lxc-deployer
memory: 1024
net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:1D:6F:77,ip=dhcp,type=veth
onboot: 1
ostype: alpine
rootfs: local-zfs:subvol-105-disk-0,size=4G
swap: 512
unprivileged: 1
lxc.environment.runtime: PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
lxc.environment.runtime: NODE_VERSION=20.0.0
lxc.environment.runtime: NODE_ENV=production
lxc.environment.runtime: CUSTOM_USER_VAR=my_value
lxc.init.uid: 1001
lxc.init.gid: 1001
lxc.init.cwd: /
lxc.signal.halt: SIGTERM
lxc.console.logfile: /var/log/lxc/oci-lxc-deployer-105.log
mp0: local-zfs:subvol-105-disk-1,mp=/config,size=1G
`;

/** New conf: simulated pct create output with minimal params + OCI-derived settings */
const NEW_CONF = `arch: amd64
cmode: console
entrypoint: /usr/local/bin/entrypoint-wrapper.sh oci-lxc-deployer --local /config --secretsFilePath /secure/secret.txt
hostname: CT105
ostype: newos
rootfs: local-zfs:subvol-105-disk-0,size=4G
unprivileged: 1
lxc.environment.runtime: PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
lxc.environment.runtime: NODE_VERSION=24.14.0
lxc.environment.runtime: NODE_ENV=production
lxc.environment.runtime: HOME=/home/lxc
lxc.init.uid: 1001
lxc.init.gid: 1001
lxc.init.cwd: /
lxc.signal.halt: SIGTERM
lxc.xxx.new: New Value
`;

describe("upgrade-common.sh library functions", () => {
  let testDir: string;
  let libraryPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-common-test-"));

    // Resolve the library path
    libraryPath = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "json",
      "shared",
      "scripts",
      "upgrade-common.sh",
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Run a shell script that sources upgrade-common.sh and executes the given commands.
   */
  function runLibraryFunction(scriptBody: string): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const script = `#!/bin/sh
set -eu
log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }
. "${libraryPath}"
${scriptBody}
`;
    const scriptPath = path.join(testDir, "test-script.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const result = spawnSync("sh", [scriptPath], {
      encoding: "utf-8",
      timeout: 10000,
      cwd: testDir,
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status ?? 1,
    };
  }

  describe("apply_new_conf_to_backup", () => {
    let backupPath: string;
    let newPath: string;

    beforeEach(() => {
      backupPath = path.join(testDir, "backup.conf");
      newPath = path.join(testDir, "new.conf");
      fs.writeFileSync(backupPath, BACKUP_CONF);
      fs.writeFileSync(newPath, NEW_CONF);
    });

    function runMerge(): string {
      const result = runLibraryFunction(
        `apply_new_conf_to_backup "${backupPath}" "${newPath}"`,
      );
      expect(result.exitCode).toBe(0);
      return fs.readFileSync(newPath, "utf-8");
    }

    it("should preserve all comment lines (notes) from backup", () => {
      const merged = runMerge();

      expect(merged).toContain("<!-- oci-lxc-deployer%3Amanaged -->");
      expect(merged).toContain("oci-lxc-deployer%3Aversion 0.3.4");
      expect(merged).toContain(
        "oci-lxc-deployer%3Alog-url http%3A//myhost.cluster%3A3201/logs/ve_pve1.cluster/105",
      );
      expect(merged).toContain("oci-lxc-deployer%3Aicon-url");
      expect(merged).toContain("## oci-lxc-deployer");
      expect(merged).toContain("Managed by");
      expect(merged).toContain("Version%3A 0.3.4");
      expect(merged).toContain("## Links");
      expect(merged).toContain("Console Logs");
    });

    it("should update changed keys from new conf (ostype)", () => {
      const merged = runMerge();

      // ostype should be from new conf, not backup
      expect(merged).toContain("ostype: newos");
      expect(merged).not.toContain("ostype: alpine");
    });

    it("should add new keys not present in backup", () => {
      const merged = runMerge();

      expect(merged).toContain("lxc.xxx.new: New Value");
    });

    it("should update matching env vars and preserve user-added ones", () => {
      const merged = runMerge();

      // NODE_VERSION should be updated to new value
      expect(merged).toContain(
        "lxc.environment.runtime: NODE_VERSION=24.14.0",
      );
      expect(merged).not.toContain(
        "lxc.environment.runtime: NODE_VERSION=20.0.0",
      );

      // NODE_ENV should remain (same in both)
      expect(merged).toContain("lxc.environment.runtime: NODE_ENV=production");

      // CUSTOM_USER_VAR should be preserved (not in new conf)
      expect(merged).toContain(
        "lxc.environment.runtime: CUSTOM_USER_VAR=my_value",
      );

      // HOME should be added (new, not in backup)
      expect(merged).toContain("lxc.environment.runtime: HOME=/home/lxc");
    });

    it("should update rootfs with new volume", () => {
      const merged = runMerge();

      // rootfs from new conf should be present
      expect(merged).toContain(
        "rootfs: local-zfs:subvol-105-disk-0,size=4G",
      );
    });

    it("should preserve backup-only keys (net0, memory, swap, cores, mountpoints)", () => {
      const merged = runMerge();

      expect(merged).toContain("memory: 1024");
      expect(merged).toContain("cores: 2");
      expect(merged).toContain("swap: 512");
      expect(merged).toContain(
        "net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:1D:6F:77,ip=dhcp,type=veth",
      );
      expect(merged).toContain("onboot: 1");
      expect(merged).toContain(
        "mp0: local-zfs:subvol-105-disk-1,mp=/config,size=1G",
      );
      expect(merged).toContain(
        "lxc.console.logfile: /var/log/lxc/oci-lxc-deployer-105.log",
      );
    });

    it("should update entrypoint from new conf", () => {
      const merged = runMerge();

      // entrypoint should be from new conf (with --secretsFilePath)
      expect(merged).toContain("--secretsFilePath /secure/secret.txt");
    });
  });

  describe("update_notes_version", () => {
    let confPath: string;

    beforeEach(() => {
      confPath = path.join(testDir, "test.conf");
    });

    it("should update version hidden marker (URL-encoded)", () => {
      fs.writeFileSync(confPath, BACKUP_CONF);

      const result = runLibraryFunction(
        `update_notes_version "${confPath}" "0.4.0" ""`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("oci-lxc-deployer%3Aversion 0.4.0");
      expect(content).not.toContain("oci-lxc-deployer%3Aversion 0.3.4");
    });

    it("should update visible version text (URL-encoded)", () => {
      fs.writeFileSync(confPath, BACKUP_CONF);

      const result = runLibraryFunction(
        `update_notes_version "${confPath}" "0.4.0" ""`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("#Version%3A 0.4.0");
      expect(content).not.toContain("#Version%3A 0.3.4");
    });

    it("should update OCI image marker when new image provided", () => {
      fs.writeFileSync(confPath, BACKUP_CONF);

      const result = runLibraryFunction(
        `update_notes_version "${confPath}" "0.4.0" "docker://ghcr.io/newowner/new-image"`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain(
        "oci-lxc-deployer%3Aoci-image ghcr.io/newowner/new-image",
      );
      expect(content).toContain("#OCI image%3A ghcr.io/newowner/new-image");
    });

    it("should preserve non-version notes content", () => {
      fs.writeFileSync(confPath, BACKUP_CONF);

      const result = runLibraryFunction(
        `update_notes_version "${confPath}" "0.4.0" ""`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("<!-- oci-lxc-deployer%3Amanaged -->");
      expect(content).toContain("## Links");
      expect(content).toContain("hostname: oci-lxc-deployer");
    });
  });

  describe("update_notes_vmid", () => {
    let confPath: string;

    beforeEach(() => {
      confPath = path.join(testDir, "test.conf");
      fs.writeFileSync(confPath, BACKUP_CONF);
    });

    it("should update log-url VMID in hidden marker", () => {
      const result = runLibraryFunction(
        `update_notes_vmid "${confPath}" "105" "110"`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("/logs/ve_pve1.cluster/110");
      expect(content).not.toContain("/logs/ve_pve1.cluster/105");
    });

    it("should update console logfile VMID", () => {
      const result = runLibraryFunction(
        `update_notes_vmid "${confPath}" "105" "110"`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("oci-lxc-deployer-110.log");
      expect(content).not.toContain("oci-lxc-deployer-105.log");
    });

    it("should update visible log file path VMID", () => {
      const result = runLibraryFunction(
        `update_notes_vmid "${confPath}" "105" "110"`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("oci-lxc-deployer-110.log");
      expect(content).not.toContain("oci-lxc-deployer-105.log");
    });

    it("should preserve all other content", () => {
      const result = runLibraryFunction(
        `update_notes_vmid "${confPath}" "105" "110"`,
      );
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(confPath, "utf-8");
      expect(content).toContain("<!-- oci-lxc-deployer%3Amanaged -->");
      expect(content).toContain("Version%3A 0.3.4");
      expect(content).toContain("hostname: oci-lxc-deployer");
      expect(content).toContain("memory: 1024");
    });
  });
});
