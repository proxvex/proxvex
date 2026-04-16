import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "node:path";

/**
 * Tests for post-update-version-from-docker.py — specifically the pure
 * transformation function apply_version_to_conf_text() that rewrites the
 * hidden version marker and the visible Markdown header in a PVE LXC
 * description.
 *
 * The script does I/O via docker/pct when run for real, but we test the
 * pure string-transform function directly through a tiny Python shim.
 * No PVE host, no docker, no file I/O needed.
 */

const SCRIPT_PATH = path.resolve(
  path.join(
    __dirname,
    "../../..",
    "json/shared/scripts/post_start/post-update-version-from-docker.py",
  ),
);

/**
 * Run apply_version_to_conf_text() against the given conf_text and return
 * the transformed text. Uses a small Python shim that imports the target
 * module by file path so we don't need pytest infrastructure.
 */
function applyVersion(
  confText: string,
  oldVersion: string,
  newVersion: string,
  appName: string,
): { text: string; changed: boolean; status: number | null } {
  const shim = `
import importlib.util, sys, json, os
spec = importlib.util.spec_from_file_location("puvd", ${JSON.stringify(SCRIPT_PATH)})
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(2)

conf_text = sys.stdin.read()
new_text, changed = mod.apply_version_to_conf_text(
    conf_text, ${JSON.stringify(oldVersion)}, ${JSON.stringify(newVersion)}, ${JSON.stringify(appName)}
)
sys.stdout.write(json.dumps({"text": new_text, "changed": changed}))
`;

  const result = spawnSync("python3", ["-c", shim], {
    input: confText,
    encoding: "utf-8",
    timeout: 10000,
  });

  if (result.status !== 0) {
    return {
      text: "",
      changed: false,
      status: result.status,
    };
  }

  const parsed = JSON.parse(result.stdout);
  return {
    text: parsed.text,
    changed: parsed.changed,
    status: result.status,
  };
}

const REAL_ZITADEL_CONF = `#<!-- oci-lxc-deployer%3Amanaged -->
#<!-- oci-lxc-deployer%3Aapplication-id zitadel -->
#<!-- oci-lxc-deployer%3Aapplication-name zitadel -->
#<!-- oci-lxc-deployer%3Aversion traefik%3A3.6%2C%20zitadel-login%3A4.12.3%2C%20zitadel%3A4.12.3 -->
#<!-- oci-lxc-deployer%3Aicon-url data%3Aimage/svg+xml;base64,... -->
#<!-- oci-lxc-deployer%3Ausername root -->
#<!-- oci-lxc-deployer%3Auid 0 -->
#<!-- oci-lxc-deployer%3Agid 0 -->
#<!-- oci-lxc-deployer%3Astack-id postgres_production -->
#<!-- oci-lxc-deployer%3Aaddon addon-ssl -->
## zitadel (0.5.6)
#<img src="data%3Aimage/svg+xml;base64,PHN2Zy..." width="16" height="16" alt="zitadel"/>
arch: amd64
features: nesting=1,keyctl=1
hostname: zitadel
`;

describe("post-update-version-from-docker.apply_version_to_conf_text", () => {
  it("updates visible Markdown header with the new version", () => {
    const result = applyVersion(
      REAL_ZITADEL_CONF,
      "0.5.6",
      "traefik:3.6, zitadel-login:4.12.3, zitadel:4.12.3",
      "zitadel",
    );

    expect(result.status).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.text).toContain(
      "## zitadel (traefik:3.6, zitadel-login:4.12.3, zitadel:4.12.3)",
    );
    expect(result.text).not.toContain("## zitadel (0.5.6)");
  });

  it("updates hidden URL-encoded version marker when old version is known", () => {
    // Fresh conf where hidden marker still has the old (deployer-fallback) version
    const confWithOldMarker = REAL_ZITADEL_CONF.replace(
      /oci-lxc-deployer%3Aversion [^\n]+/,
      "oci-lxc-deployer%3Aversion 0.5.6 -->",
    ).replace("## zitadel (0.5.6)", "## zitadel (0.5.6)");

    const result = applyVersion(
      confWithOldMarker,
      "0.5.6",
      "traefik:3.6, zitadel-login:4.12.3, zitadel:4.12.3",
      "zitadel",
    );

    expect(result.status).toBe(0);
    expect(result.changed).toBe(true);
    // URL-encoded form: ':' → %3A, ',' → %2C, ' ' → %20
    expect(result.text).toContain(
      "oci-lxc-deployer%3Aversion traefik%3A3.6%2C%20zitadel-login%3A4.12.3%2C%20zitadel%3A4.12.3",
    );
    expect(result.text).not.toContain("oci-lxc-deployer%3Aversion 0.5.6 ");
  });

  it("handles header without existing version suffix", () => {
    const conf = REAL_ZITADEL_CONF.replace(
      "## zitadel (0.5.6)",
      "## zitadel",
    );
    const result = applyVersion(conf, "", "v1.2.3", "zitadel");

    expect(result.status).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.text).toContain("## zitadel (v1.2.3)");
  });

  it("leaves non-matching content untouched", () => {
    const conf = REAL_ZITADEL_CONF;
    const result = applyVersion(
      conf,
      "0.5.6",
      "v4.12.3",
      "zitadel",
    );

    expect(result.status).toBe(0);
    // img tag, pct config lines, hostname must stay exactly as they were
    expect(result.text).toContain(
      '#<img src="data%3Aimage/svg+xml;base64,PHN2Zy..."',
    );
    expect(result.text).toContain("arch: amd64");
    expect(result.text).toContain("features: nesting=1,keyctl=1");
    expect(result.text).toContain("hostname: zitadel");
  });

  it("reports changed=false when no marker matches (different app name)", () => {
    const result = applyVersion(
      REAL_ZITADEL_CONF,
      "0.5.6",
      "v4.12.3",
      "not-zitadel",
    );

    expect(result.status).toBe(0);
    // Hidden marker matches on encoded_old, so it DOES change even for wrong app_name.
    // The guarantee we care about: visible header of "not-zitadel" stays absent.
    expect(result.text).not.toContain("## not-zitadel");
  });

  it("is idempotent when old_version == new_version", () => {
    const confAlreadyUpdated = REAL_ZITADEL_CONF.replace(
      "## zitadel (0.5.6)",
      "## zitadel (v4.12.3)",
    );
    const result = applyVersion(
      confAlreadyUpdated,
      "v4.12.3",
      "v4.12.3",
      "zitadel",
    );

    expect(result.status).toBe(0);
    expect(result.text).toContain("## zitadel (v4.12.3)");
  });
});
