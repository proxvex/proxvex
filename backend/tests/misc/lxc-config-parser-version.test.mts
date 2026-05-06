import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Real /etc/pve/lxc/<id>.conf content captured from a running zitadel/default
 * container (multi-service docker-compose deployment). Two key facts to
 * preserve in any future refactor:
 *
 *   - Multi-service `proxvex:version` markers are URL-encoded by PVE storage.
 *     The colon between service and version becomes %3A, the comma+space
 *     between entries becomes %2C%20.
 *   - The visible `## <appname> (...)` Markdown header carries the SAME info
 *     in plain (un-URL-encoded) form. It's the human-readable mirror.
 *
 * If either format changes, post-update-version-from-docker.py and
 * upgrade-common.sh::update_notes_version both need updates — they must
 * keep both forms in sync after an upgrade.
 */
const ZITADEL_REAL_NOTE = `#<!-- proxvex%3Amanaged -->
#<!-- proxvex%3Aapplication-id zitadel -->
#<!-- proxvex%3Aapplication-name zitadel -->
#<!-- proxvex%3Aversion traefik%3A3.6%2C%20zitadel-login%3A4.12.3%2C%20zitadel%3A4.12.3 -->
#<!-- proxvex%3Alog-url http%3A//ubuntupve%3A1280/logs/ve_ubuntupve/227 -->
#<!-- proxvex%3Ausername root -->
#<!-- proxvex%3Auid 0 -->
#<!-- proxvex%3Agid 0 -->
#<!-- proxvex%3Astack-id postgres_default -->
#<!-- proxvex%3Astack-id oidc_default -->
#<!-- proxvex%3Astack-id cloudflare_default -->
## zitadel (traefik:3.6, zitadel-login:4.12.3, zitadel:4.12.3)
arch: amd64
features: nesting=1,keyctl=1
hostname: zitadel-default
memory: 512
mp0: local-zfs:subvol-227-zitadel-default-bootstrap,mp=/bootstrap,size=4M
nameserver: 10.0.0.1
net0: name=eth0,bridge=vmbr1,hwaddr=BC:24:11:CA:AB:C7,ip=dhcp,type=veth
onboot: 1
ostype: alpine
rootfs: local-zfs:subvol-227-disk-0,size=4G
swap: 512
unprivileged: 1
`;

/**
 * Single-service deployment (e.g. proxvex itself): the version marker is a
 * bare string, not service-prefixed.
 */
const PROXVEX_REAL_NOTE = `#<!-- proxvex%3Amanaged -->
#<!-- proxvex%3Aoci-image ghcr.io/proxvex/proxvex -->
#<!-- proxvex%3Aapplication-id proxvex -->
#<!-- proxvex%3Aapplication-name proxvex -->
#<!-- proxvex%3Aversion 0.5.48 -->
#<!-- proxvex%3Ausername lxc -->
## proxvex (0.5.48)
arch: amd64
hostname: proxvex-default
memory: 1024
ostype: alpine
rootfs: local-zfs:subvol-223-disk-0,size=4G
unprivileged: 1
`;

/**
 * Helper: shell out to Python to invoke the parser and round-trip its
 * output via JSON. Avoids reimplementing the regex in TypeScript (we want
 * to test the actual production code, not a copy of it).
 */
function parseLxcConfig(confText: string): Record<string, unknown> {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const libPath = path.join(
    repoRoot,
    "json/shared/scripts/library/lxc_config_parser_lib.py",
  );

  // Confirm the library exists where we think it does. Fail loudly if not —
  // a silent skip here would let regressions in path layout sneak through.
  if (!fs.existsSync(libPath)) {
    throw new Error(`lxc_config_parser_lib.py not found at ${libPath}`);
  }

  const runner = `
import sys
sys.path.insert(0, "${path.dirname(libPath)}")
from lxc_config_parser_lib import parse_lxc_config
import json
text = sys.stdin.read()
config = parse_lxc_config(text)
print(json.dumps(config.to_dict()))
`;
  const result = spawnSync("python3", ["-c", runner], {
    input: confText,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`python3 failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Helper for the new function under test: parses the multi-service version
 * string into a {service: version} dict. The notes write
 * "service:version, service:version, ..." — but other consumers (e.g.
 * `target_versions` test parameters) use "service=version,service=version".
 * The helper accepts both separators so callers never have to care.
 */
function parseVersionString(versionStr: string): Record<string, string> {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const libPath = path.join(
    repoRoot,
    "json/shared/scripts/library/lxc_config_parser_lib.py",
  );
  const runner = `
import sys
sys.path.insert(0, "${path.dirname(libPath)}")
from lxc_config_parser_lib import parse_version_string
import json
print(json.dumps(parse_version_string(sys.stdin.read())))
`;
  const result = spawnSync("python3", ["-c", runner], {
    input: versionStr,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`python3 failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

describe("lxc_config_parser_lib — version parsing", () => {
  it("extracts the URL-encoded multi-service version from a real zitadel note", () => {
    const config = parseLxcConfig(ZITADEL_REAL_NOTE);
    expect(config.is_managed).toBe(true);
    expect(config.application_id).toBe("zitadel");
    expect(config.application_name).toBe("zitadel");
    // version is stored verbatim — already URL-decoded by the parser.
    expect(config.version).toBe(
      "traefik:3.6, zitadel-login:4.12.3, zitadel:4.12.3",
    );
  });

  it("extracts the single-string version from a real proxvex note", () => {
    const config = parseLxcConfig(PROXVEX_REAL_NOTE);
    expect(config.is_managed).toBe(true);
    expect(config.application_id).toBe("proxvex");
    expect(config.version).toBe("0.5.48");
  });

  it("parse_version_string handles the notes format (colon + comma-space)", () => {
    const parsed = parseVersionString(
      "traefik:3.6, zitadel-login:4.12.3, zitadel:4.12.3",
    );
    expect(parsed).toEqual({
      "traefik": "3.6",
      "zitadel-login": "4.12.3",
      "zitadel": "4.12.3",
    });
  });

  it("parse_version_string handles the test-parameter format (equals + comma)", () => {
    const parsed = parseVersionString(
      "zitadel=v4.13.1,zitadel-login=v4.13.1,traefik=v3.6.13",
    );
    expect(parsed).toEqual({
      "zitadel": "v4.13.1",
      "zitadel-login": "v4.13.1",
      "traefik": "v3.6.13",
    });
  });

  it("parse_version_string handles a single bare version (single-service apps)", () => {
    const parsed = parseVersionString("0.5.48");
    expect(parsed).toEqual({ "": "0.5.48" });
  });

  it("parse_version_string returns empty dict for empty / sentinel input", () => {
    expect(parseVersionString("")).toEqual({});
    expect(parseVersionString("NOT_DEFINED")).toEqual({});
  });

  it("parse_version_string is whitespace-tolerant", () => {
    const parsed = parseVersionString(
      "  traefik : 3.6 , zitadel-login : 4.12.3 ",
    );
    expect(parsed).toEqual({
      "traefik": "3.6",
      "zitadel-login": "4.12.3",
    });
  });
});
