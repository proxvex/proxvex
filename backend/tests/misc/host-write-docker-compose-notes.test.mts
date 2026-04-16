import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for host-write-docker-compose-notes.py in isolation.
 *
 * The script receives {{ var }} placeholders from the backend's variable
 * resolver. To test the pure transformation (without spinning up a real
 * backend + PVE host), we:
 *
 *   1. Read the library (lxc-notes-common.py) and prepend it to the script,
 *      exactly as the template `library: "lxc-notes-common.py"` feature does
 *      at deploy time.
 *   2. Substitute the {{ var }} placeholders with fixed test values.
 *   3. Import the result via importlib and call build_notes(True) — a pure
 *      string-transform function. No pct, no I/O.
 *   4. Assert the returned notes string contains (or doesn't contain) the
 *      expected markers and sections.
 *
 * This isolates "does the script turn good inputs into good notes?" from
 * "does the backend deliver the inputs correctly?". A green test here means
 * any log-url / Links-section regression is in the backend delivery layer,
 * not in the script itself.
 */

const SCRIPT_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/pre_start/host-write-docker-compose-notes.py",
  ),
);
const LIB_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/library/lxc-notes-common.py",
  ),
);

type TemplateVars = Record<string, string>;

function renderScript(vars: TemplateVars): string {
  const lib = fs.readFileSync(LIB_PATH, "utf-8");
  const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
  // Prepend library (same as the template "library" feature does at runtime).
  let combined = lib + "\n" + script;
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = new RegExp(
      `\\{\\{\\s*${key.replace(/\./g, "\\.")}\\s*\\}\\}`,
      "g",
    );
    combined = combined.replace(placeholder, value);
  }
  return combined;
}

function callBuildNotes(vars: TemplateVars): {
  notes: string;
  status: number | null;
  stderr: string;
} {
  const rendered = renderScript(vars);

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "notes-test-"),
  );
  const scriptFile = path.join(tmpDir, "script.py");
  const shimFile = path.join(tmpDir, "shim.py");
  fs.writeFileSync(scriptFile, rendered);

  // Shim that imports the rendered module and calls build_notes(True).
  const shim = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("target", ${JSON.stringify(scriptFile)})
mod = importlib.util.module_from_spec(spec)
# Swallow the main() auto-run: our script calls main() under __main__, but
# importlib imports under a synthetic module name, so __main__ guard is false.
spec.loader.exec_module(mod)
sys.stdout.write(mod.build_notes(True))
`;
  fs.writeFileSync(shimFile, shim);

  const result = spawnSync("python3", [shimFile], {
    encoding: "utf-8",
    timeout: 10000,
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    notes: result.stdout || "",
    status: result.status,
    stderr: result.stderr || "",
  };
}

describe("host-write-docker-compose-notes.py / build_notes", () => {
  const baseVars: TemplateVars = {
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

  it("includes the hidden log-url marker when deployer_base_url + ve_context_key are set", () => {
    const result = callBuildNotes(baseVars);
    expect(result.status).toBe(0);
    expect(result.notes).toContain(
      "<!-- oci-lxc-deployer:log-url http://old-prod-hub:3080/logs/ve_pve1.cluster/504 -->",
    );
  });

  it("includes the visible Links section with a clickable log viewer link", () => {
    const result = callBuildNotes(baseVars);
    expect(result.status).toBe(0);
    expect(result.notes).toContain("**Links**");
    expect(result.notes).toContain(
      "[Logs](http://old-prod-hub:3080/logs/ve_pve1.cluster/504)",
    );
  });

  it("omits log-url marker and Links section when deployer_base_url is empty", () => {
    // Same test as above but with empty deployer_base_url — reproduces what
    // the user observed in the 504.conf where neither marker nor links appeared.
    const result = callBuildNotes({
      ...baseVars,
      deployer_base_url: "",
    });
    expect(result.status).toBe(0);
    expect(result.notes).not.toContain("log-url");
    expect(result.notes).not.toContain("**Links**");
  });

  it("omits Links section when ve_context_key is empty even if deployer_base_url is set", () => {
    const result = callBuildNotes({
      ...baseVars,
      ve_context_key: "",
    });
    expect(result.status).toBe(0);
    expect(result.notes).not.toContain("log-url");
    expect(result.notes).not.toContain("**Links**");
  });

  it("writes visible header without version suffix when oci_image_tag is empty", () => {
    // With Fix B in webapp-ve-route-handlers.mts, docker-compose apps no
    // longer fall back to deployer version — oci_image_tag is empty and the
    // header stays as "# zitadel" until post-update-version fills in the
    // real multi-service version.
    const result = callBuildNotes(baseVars);
    expect(result.status).toBe(0);
    expect(result.notes).toContain("# zitadel");
    // Must NOT contain "(0.5.6)" or any other deployer-version-looking suffix
    expect(result.notes).not.toMatch(/# zitadel \(\d+\.\d+\.\d+\)/);
  });

  it("writes visible header with version when oci_image_tag is set", () => {
    const result = callBuildNotes({
      ...baseVars,
      oci_image_tag: "v4.12.3",
    });
    expect(result.status).toBe(0);
    expect(result.notes).toContain("# zitadel (v4.12.3)");
  });
});
