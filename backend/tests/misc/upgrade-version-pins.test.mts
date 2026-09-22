import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Guard: livetest upgrade scenarios must stay in sync with versions.sh.
 *
 * History: versions.sh gets bumped (e.g. zitadel v4.13.1 → v4.16.x in #330)
 * while the upgrade tests kept their hardcoded `target_versions`. The
 * dependency install then runs the NEW version (compose resolves
 * ${DOCKER_*_TAG} from versions.sh) and the "upgrade" silently becomes a
 * DOWNGRADE — zitadel v4.16 → v4.13.1 ran old migration code against the
 * new schema and died with SQLSTATE 42601, which cost a full debugging
 * session to trace back to the stale pin.
 *
 * Rules enforced here, so a versions.sh bump without a matching test update
 * fails `pnpm test` immediately instead of failing a livetest run later:
 *
 * 1. Every service in `target_versions`/`expected_versions` that has a
 *    versions.sh pin must target EXACTLY that pin (no stale pins, no
 *    accidental downgrades).
 * 2. `target_versions` and `expected_versions` in the same scenario must
 *    agree on shared services.
 * 3. Every `compose_tag_overrides` entry (the "-prev" old-version install
 *    used as an upgrade source) must reference an existing versions.sh
 *    variable and must DIFFER from its pin — if it equals the pin, the
 *    old→new upgrade test has degenerated into a no-op recreate.
 */

const REPO_ROOT = path.resolve(path.join(__dirname, "../../.."));
const VERSIONS_SH = path.join(
  REPO_ROOT,
  "json/shared/scripts/library/versions.sh",
);
const APPS_DIR = path.join(REPO_ROOT, "json/applications");

/** Parse `VAR="${VAR:-default}"` pins out of versions.sh. */
function parseVersionPins(): Map<string, string> {
  const pins = new Map<string, string>();
  const content = fs.readFileSync(VERSIONS_SH, "utf8");
  const re = /^([A-Z]+_[A-Za-z0-9_]+_TAG)="\$\{\1:-([^}]+)\}"/gm;
  for (const m of content.matchAll(re)) {
    pins.set(m[1]!, m[2]!);
  }
  return pins;
}

/** "zitadel-login" → "DOCKER_zitadel_login_TAG" */
function dockerVarForService(service: string): string {
  return `DOCKER_${service.replace(/-/g, "_")}_TAG`;
}

/** Parse "svc=tag,svc=tag" / "VAR=tag,VAR=tag" into entries. */
function parsePairs(value: string): Array<{ key: string; tag: string }> {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      expect(eq, `malformed pair '${pair}'`).toBeGreaterThan(0);
      return { key: pair.slice(0, eq), tag: pair.slice(eq + 1) };
    });
}

interface ScenarioRef {
  file: string;
  params: Map<string, string>;
}

function loadScenarios(): ScenarioRef[] {
  const out: ScenarioRef[] = [];
  for (const app of fs.readdirSync(APPS_DIR)) {
    const testsDir = path.join(APPS_DIR, app, "tests");
    if (!fs.existsSync(testsDir)) continue;
    for (const f of fs.readdirSync(testsDir)) {
      if (!f.endsWith(".json")) continue;
      const file = path.join(testsDir, f);
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
        params?: Array<{ name: string; value: unknown }>;
      };
      const params = new Map<string, string>();
      for (const p of data.params ?? []) {
        if (typeof p.value === "string") params.set(p.name, p.value);
      }
      out.push({ file: path.relative(REPO_ROOT, file), params });
    }
  }
  return out;
}

const pins = parseVersionPins();
const scenarios = loadScenarios();

describe("upgrade version pins stay in sync with versions.sh", () => {
  it("parses versions.sh pins", () => {
    expect(pins.size).toBeGreaterThan(10);
    expect(pins.get("DOCKER_zitadel_TAG")).toBeTruthy();
  });

  const withTargets = scenarios.filter(
    (s) => s.params.has("target_versions") || s.params.has("expected_versions"),
  );

  it("finds at least the zitadel and postgrest upgrade scenarios", () => {
    expect(withTargets.length).toBeGreaterThanOrEqual(2);
  });

  for (const s of withTargets) {
    describe(s.file, () => {
      for (const paramName of ["target_versions", "expected_versions"]) {
        const raw = s.params.get(paramName);
        if (!raw) continue;
        it(`${paramName} matches versions.sh pins`, () => {
          for (const { key: service, tag } of parsePairs(raw)) {
            const varName = dockerVarForService(service);
            const pin = pins.get(varName);
            // Services without a versions.sh pin are out of scope here.
            if (pin === undefined) continue;
            expect(
              tag,
              `${s.file}: ${paramName} pins ${service}=${tag} but versions.sh has ` +
                `${varName}=${pin}. A stale test pin turns the upgrade into a ` +
                `downgrade at runtime — update the scenario together with versions.sh.`,
            ).toBe(pin);
          }
        });
      }

      it("target_versions and expected_versions agree", () => {
        const t = s.params.get("target_versions");
        const e = s.params.get("expected_versions");
        if (!t || !e) return;
        const tm = new Map(parsePairs(t).map((p) => [p.key, p.tag]));
        for (const { key, tag } of parsePairs(e)) {
          if (!tm.has(key)) continue;
          expect(
            tm.get(key),
            `${s.file}: target_versions and expected_versions disagree on '${key}'`,
          ).toBe(tag);
        }
      });
    });
  }

  const withOverrides = scenarios.filter((s) =>
    s.params.has("compose_tag_overrides"),
  );

  it("finds at least the -prev upgrade-source scenarios", () => {
    expect(withOverrides.length).toBeGreaterThanOrEqual(2);
  });

  for (const s of withOverrides) {
    it(`${s.file}: compose_tag_overrides reference real, older pins`, () => {
      for (const { key: varName, tag } of parsePairs(
        s.params.get("compose_tag_overrides")!,
      )) {
        const pin = pins.get(varName);
        expect(
          pin,
          `${s.file}: compose_tag_overrides references ${varName}, which does ` +
            `not exist in versions.sh — a typo here silently installs the ` +
            `current version and the upgrade test degenerates to a recreate.`,
        ).toBeDefined();
        expect(
          tag,
          `${s.file}: compose_tag_overrides pins ${varName}=${tag}, which EQUALS ` +
            `the versions.sh pin — the old→new upgrade test has degenerated ` +
            `into a no-op recreate. Pin the -prev source one release behind.`,
        ).not.toBe(pin);
      }
    });
  }
});
