import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createTestEnvironment,
  TestEnvironment,
} from "@tests/helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

/**
 * Real PVE config format: description is stored as #-prefixed comment lines
 * at the top of the file, with URL-encoded content.
 */
const PVE_CONFIG_WITH_NOTES = `#<!-- proxvex%3Amanaged -->
#<!-- proxvex%3Aoci-image ghcr.io/proxvex/proxvex -->
#<!-- proxvex%3Aapplication-id proxvex -->
#<!-- proxvex%3Aapplication-name proxvex -->
#<!-- proxvex%3Aversion 0.3.4 -->
#<!-- proxvex%3Alog-url http%3A//myhost.cluster%3A3201/logs/ve_pve1.cluster/106 -->
#<!-- proxvex%3Ausername lxc -->
#<!-- proxvex%3Auid 1001 -->
#<!-- proxvex%3Agid 1001 -->
## proxvex (0.3.4)
#
#Log file%3A /var/log/lxc/proxvex-106.log
#
#**Links**
#- [Console Logs](http%3A//myhost.cluster%3A3201/logs/ve_pve1.cluster/106)
#Managed by [proxvex](http%3A//myhost.cluster%3A3201/).
arch: amd64
cmode: console
hostname: proxvex
memory: 512
net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:40:E1:19,ip=dhcp,type=veth
onboot: 1
ostype: alpine
rootfs: local-zfs:subvol-106-disk-0,size=4G
swap: 512
unprivileged: 1
`;

/**
 * Alternative PVE config format: single-line URL-encoded description.
 * This format may be used by older PVE versions or shorter descriptions.
 */
const PVE_CONFIG_SINGLE_LINE = `description: %3C%21--+proxvex%3Amanaged+--%3E%0A%3C%21--+proxvex%3Aapplication-id+test-app+--%3E%0A%23+test-app%0A%0A**Links**%0A-+%5BLogs%5D(http%3A%2F%2Fhost%3A3201%2Flogs%2F100)%0AManaged+by+proxvex.
arch: amd64
hostname: test-app
memory: 512
`;

/** Minimal config without any description */
const PVE_CONFIG_NO_NOTES = `arch: amd64
hostname: test-container
memory: 256
ostype: alpine
rootfs: local-zfs:subvol-200-disk-0,size=4G
`;

describe("host-update-lxc-notes-addon.py", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let lxcDir: string;
  let mockBinDir: string;
  let pctOutputFile: string;

  beforeEach(async () => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^shared/scripts/post_start/host-update-lxc-notes-addon\\.py$",
        "^shared/scripts/library/lxc_config_parser_lib\\.py$",
      ],
    });
    env.initPersistence({ enableCache: false });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    // Create LXC config directory
    lxcDir = persistenceHelper.resolve(Volume.LocalRoot, "lxc");
    persistenceHelper.ensureDirSync(Volume.LocalRoot, "lxc");

    // Create mock bin directory with fake pct script
    mockBinDir = path.join(env.localDir, "mock-bin");
    fs.mkdirSync(mockBinDir, { recursive: true });

    pctOutputFile = path.join(env.localDir, "pct-output.txt");

    // Create mock pct that captures the --description argument
    const mockPct = `#!/bin/sh
# Mock pct - captures description for testing
if [ "$1" = "set" ] && [ "$3" = "--description" ]; then
  printf '%s' "$4" > "${pctOutputFile}"
  exit 0
fi
exit 1
`;
    const mockPctPath = path.join(mockBinDir, "pct");
    fs.writeFileSync(mockPctPath, mockPct, { mode: 0o755 });
  });

  afterEach(async () => {
    env.cleanup();
  });

  function runAddonNotesScript(
    vmId: string,
    addonId: string,
    addonAction: string = "add",
  ): { stdout: string; stderr: string; exitCode: number } {
    // Read and combine library + script
    let scriptContent = persistenceHelper.readTextSync(
      Volume.JsonSharedScripts,
      "post_start/host-update-lxc-notes-addon.py",
    );
    scriptContent = scriptContent
      .replace(/\{\{\s*vm_id\s*\}\}/g, vmId)
      .replace(/\{\{\s*addon_id\s*\}\}/g, addonId)
      .replace(/\{\{\s*addon_action\s*\}\}/g, addonAction);

    const library = persistenceHelper.readTextSync(
      Volume.JsonSharedScripts,
      "library/lxc_config_parser_lib.py",
    );
    const combined = `${library}\n\n# --- Script starts here ---\n${scriptContent}`;

    const result = spawnSync("python3", [], {
      input: combined,
      env: {
        ...process.env,
        LXC_MANAGER_PVE_LXC_DIR: lxcDir,
        PATH: `${mockBinDir}:${process.env.PATH}`,
      },
      encoding: "utf-8",
      timeout: 10000,
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status ?? 1,
    };
  }

  function readPctOutput(): string {
    if (fs.existsSync(pctOutputFile)) {
      return fs.readFileSync(pctOutputFile, "utf-8");
    }
    return "";
  }

  describe("with #-prefixed comment format (real PVE format)", () => {
    beforeEach(() => {
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "lxc/106.conf",
        PVE_CONFIG_WITH_NOTES,
      );
    });

    it("should extract description and add addon marker", () => {
      const result = runAddonNotesScript("106", "addon-ssl");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"success"');
      expect(result.stdout).toContain('"true"');

      // Check what was passed to pct set --description
      const description = readPctOutput();
      expect(description).not.toBe("");

      // Must contain the addon marker
      expect(description).toContain(
        "<!-- proxvex:addon addon-ssl -->",
      );

      // Must preserve existing notes content
      expect(description).toContain("<!-- proxvex:managed -->");
      expect(description).toContain("proxvex:application-id");
      expect(description).toContain("# proxvex");
      expect(description).toContain("Managed by");
      expect(description).toContain("**Links**");
      expect(description).toContain("Console Logs");
    });

    it("should place addon marker before **Links** section", () => {
      const result = runAddonNotesScript("106", "addon-ssl");
      expect(result.exitCode).toBe(0);

      const description = readPctOutput();
      const markerPos = description.indexOf(
        "<!-- proxvex:addon addon-ssl -->",
      );
      const linksPos = description.indexOf("**Links**");

      expect(markerPos).toBeGreaterThan(-1);
      expect(linksPos).toBeGreaterThan(-1);
      expect(markerPos).toBeLessThan(linksPos);
    });

    it("should not duplicate marker if already present", () => {
      // First add
      runAddonNotesScript("106", "addon-ssl");
      const firstDescription = readPctOutput();

      // Write the result back as the new config (simulate pct set)
      // Re-encode as #-prefixed lines
      const reEncodedLines = firstDescription
        .split("\n")
        .map((line: string) => "#" + line)
        .join("\n");
      const updatedConfig =
        reEncodedLines +
        "\n" +
        PVE_CONFIG_WITH_NOTES.split("\n")
          .filter((l) => !l.startsWith("#"))
          .join("\n");
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "lxc/106.conf",
        updatedConfig,
      );

      // Second add - should skip
      const result = runAddonNotesScript("106", "addon-ssl");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("already exists");
    });

    it("should handle multiple addons", () => {
      // Add first addon
      runAddonNotesScript("106", "addon-ssl");
      const firstDescription = readPctOutput();

      // Simulate config after first addon
      const reEncodedLines = firstDescription
        .split("\n")
        .map((line: string) => "#" + line)
        .join("\n");
      const updatedConfig =
        reEncodedLines +
        "\n" +
        PVE_CONFIG_WITH_NOTES.split("\n")
          .filter((l) => !l.startsWith("#"))
          .join("\n");
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "lxc/106.conf",
        updatedConfig,
      );

      // Add second addon
      const result = runAddonNotesScript("106", "samba-shares");
      expect(result.exitCode).toBe(0);

      const secondDescription = readPctOutput();
      expect(secondDescription).toContain(
        "<!-- proxvex:addon addon-ssl -->",
      );
      expect(secondDescription).toContain(
        "<!-- proxvex:addon samba-shares -->",
      );
      // Must still contain original content
      expect(secondDescription).toContain("<!-- proxvex:managed -->");
    });

    it("should remove addon marker", () => {
      // First add it
      runAddonNotesScript("106", "addon-ssl");
      const addedDescription = readPctOutput();

      // Write back
      const reEncodedLines = addedDescription
        .split("\n")
        .map((line: string) => "#" + line)
        .join("\n");
      const updatedConfig =
        reEncodedLines +
        "\n" +
        PVE_CONFIG_WITH_NOTES.split("\n")
          .filter((l) => !l.startsWith("#"))
          .join("\n");
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "lxc/106.conf",
        updatedConfig,
      );

      // Remove it
      const result = runAddonNotesScript("106", "addon-ssl", "remove");
      expect(result.exitCode).toBe(0);

      const removedDescription = readPctOutput();
      expect(removedDescription).not.toContain(
        "proxvex:addon addon-ssl",
      );
      // Other content must remain
      expect(removedDescription).toContain("<!-- proxvex:managed -->");
    });
  });

  describe("with single-line description format", () => {
    beforeEach(() => {
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "lxc/100.conf",
        PVE_CONFIG_SINGLE_LINE,
      );
    });

    it("should extract description and add addon marker", () => {
      const result = runAddonNotesScript("100", "addon-ssl");

      expect(result.exitCode).toBe(0);

      const description = readPctOutput();
      expect(description).toContain(
        "<!-- proxvex:addon addon-ssl -->",
      );
      expect(description).toContain("<!-- proxvex:managed -->");
      expect(description).toContain("test-app");
      expect(description).toContain("**Links**");
    });
  });

  describe("with no existing notes", () => {
    beforeEach(() => {
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "lxc/200.conf",
        PVE_CONFIG_NO_NOTES,
      );
    });

    it("should add addon marker to empty description", () => {
      const result = runAddonNotesScript("200", "addon-ssl");

      expect(result.exitCode).toBe(0);

      const description = readPctOutput();
      expect(description).toContain(
        "<!-- proxvex:addon addon-ssl -->",
      );
    });
  });

  describe("edge cases", () => {
    it("should fail gracefully when config file does not exist", () => {
      const result = runAddonNotesScript("999", "addon-ssl");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not found");
    });
  });
});
