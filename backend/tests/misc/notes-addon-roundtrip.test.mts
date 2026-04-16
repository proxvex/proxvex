import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests whether the addon-update roundtrip preserves log-url and Links.
 *
 * The hypothesis: host-write-docker-compose-notes.py writes notes WITH
 * log-url + Links. Then host-update-lxc-notes-addon.py reads the PVE
 * config, decodes the description, inserts an addon marker, and re-writes
 * via pct set. If the decode→modify→re-encode cycle loses data, the
 * log-url and Links disappear.
 *
 * This test simulates the full cycle without PVE:
 * 1. Generate notes via host-write-docker-compose-notes.py (with log-url + Links)
 * 2. Encode as PVE config format (# prefix + URL-encoding of certain chars)
 * 3. Run host-update-lxc-notes-addon.py's extract + insert logic
 * 4. Assert log-url and Links survive
 */

const ADDON_SCRIPT_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/post_start/host-update-lxc-notes-addon.py",
  ),
);

const LXC_CONFIG_PARSER_LIB = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/library/lxc_config_parser_lib.py",
  ),
);

const NOTES_SCRIPT_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/pre_start/host-write-docker-compose-notes.py",
  ),
);

const NOTES_LIB_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/library/lxc-notes-common.py",
  ),
);

function generateNotes(): string {
  const lib = fs.readFileSync(NOTES_LIB_PATH, "utf-8");
  const script = fs.readFileSync(NOTES_SCRIPT_PATH, "utf-8");
  let combined = lib + "\n" + script;

  const vars: Record<string, string> = {
    vm_id: "504",
    application_id: "zitadel",
    application_name: "zitadel",
    oci_image_tag: "",
    deployer_base_url: "http://old-prod-hub:3080",
    ve_context_key: "ve_pve1.cluster",
    hostname: "zitadel",
    icon_base64: "",
    icon_mime_type: "",
    username: "root",
    uid: "0",
    gid: "0",
    stack_id: "postgres_production",
  };

  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{\\s*${key.replace(/\./g, "\\.")}\\s*\\}\\}`, "g");
    combined = combined.replace(re, value);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-rt-"));
  const scriptFile = path.join(tmpDir, "gen.py");
  const shimFile = path.join(tmpDir, "shim.py");
  fs.writeFileSync(scriptFile, combined);
  fs.writeFileSync(shimFile, `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("t", ${JSON.stringify(scriptFile)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sys.stdout.write(mod.build_notes(False))
`);
  const result = spawnSync("python3", [shimFile], { encoding: "utf-8", timeout: 10000 });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result.stdout || "";
}

/**
 * Simulate PVE config format: each description line gets a "#" prefix,
 * and certain characters get URL-encoded (: → %3A, etc.)
 */
function toPveConfig(notes: string): string {
  const descLines = notes.split("\n").map((line) => {
    // PVE URL-encodes colons in description lines
    const encoded = line.replace(/:/g, "%3A");
    return "#" + encoded;
  });

  return descLines.join("\n") + "\narch: amd64\nhostname: zitadel\n";
}

/**
 * Run the addon-update script's extract + insert logic against a PVE config.
 * Returns the modified description (decoded).
 */
function runAddonUpdate(pveConfig: string, addonId: string): {
  description: string;
  status: number | null;
  stderr: string;
} {
  const lib = fs.readFileSync(LXC_CONFIG_PARSER_LIB, "utf-8");
  const script = fs.readFileSync(ADDON_SCRIPT_PATH, "utf-8");
  let combined = lib + "\n" + script;

  combined = combined.replace(/\{\{\s*vm_id\s*\}\}/g, "504");
  combined = combined.replace(/\{\{\s*addon_id\s*\}\}/g, addonId);
  combined = combined.replace(/\{\{\s*addon_action\s*\}\}/g, "add");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "addon-rt-"));
  const scriptFile = path.join(tmpDir, "addon.py");
  const confFile = path.join(tmpDir, "504.conf");
  const shimFile = path.join(tmpDir, "shim.py");

  fs.writeFileSync(confFile, pveConfig);
  fs.writeFileSync(scriptFile, combined);

  // Shim: import and call extract + insert, capture the result
  fs.writeFileSync(shimFile, `
import importlib.util, sys, os, json
os.environ["LXC_MANAGER_PVE_LXC_DIR"] = ${JSON.stringify(tmpDir)}
spec = importlib.util.spec_from_file_location("t", ${JSON.stringify(scriptFile)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

conf_text = open(${JSON.stringify(confFile)}).read()
desc = mod.extract_description_from_config(conf_text)
new_desc = mod.insert_addon_marker(desc, ${JSON.stringify(addonId)})
# Write the result back (simulates pct set) and re-read
sys.stdout.write(json.dumps({"description": new_desc}))
`);

  const result = spawnSync("python3", [shimFile], { encoding: "utf-8", timeout: 10000 });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  let description = "";
  try {
    description = JSON.parse(result.stdout || "{}").description || "";
  } catch { /* */ }

  return {
    description,
    status: result.status,
    stderr: result.stderr || "",
  };
}

describe("Notes addon-update roundtrip", () => {
  let originalNotes: string;
  let pveConfig: string;

  it("generates notes with log-url and Links", () => {
    originalNotes = generateNotes();
    expect(originalNotes).toContain("oci-lxc-deployer:log-url");
    expect(originalNotes).toContain("**Links**");
    expect(originalNotes).toContain("[Logs](http://old-prod-hub:3080/logs/ve_pve1.cluster/504)");
  });

  it("converts to PVE config format", () => {
    pveConfig = toPveConfig(originalNotes);
    expect(pveConfig).toContain("#<!-- oci-lxc-deployer%3Amanaged -->");
    expect(pveConfig).toContain("arch: amd64");
  });

  it("preserves log-url after addon-update roundtrip", () => {
    const result = runAddonUpdate(pveConfig, "addon-ssl");
    expect(result.status).toBe(0);

    // The extracted + modified description must still contain log-url and Links
    expect(result.description).toContain("oci-lxc-deployer:log-url");
    expect(result.description).toContain("**Links**");
    expect(result.description).toContain("[Logs](http://old-prod-hub:3080/logs/ve_pve1.cluster/504)");
  });

  it("adds addon marker without removing other content", () => {
    const result = runAddonUpdate(pveConfig, "addon-ssl");
    expect(result.status).toBe(0);

    // Addon marker present
    expect(result.description).toContain("oci-lxc-deployer:addon addon-ssl");

    // Original markers still present
    expect(result.description).toContain("oci-lxc-deployer:managed");
    expect(result.description).toContain("oci-lxc-deployer:application-id zitadel");
    expect(result.description).toContain("# zitadel");
  });
});
