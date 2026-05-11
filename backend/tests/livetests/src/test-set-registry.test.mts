import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAdHocFilter,
  buildFilter,
  loadTestSets,
  matchTag,
  resolvePreset,
} from "./test-set-registry.mjs";

describe("matchTag", () => {
  it("exact match", () => {
    expect(matchTag("cost:quick", ["cost:quick"])).toBe(true);
    expect(matchTag("cost:quick", ["cost:slow"])).toBe(false);
  });
  it("trailing-* glob matches by prefix", () => {
    expect(matchTag("needs:*", ["needs:internet"])).toBe(true);
    expect(matchTag("needs:*", ["other"])).toBe(false);
  });
  it("trailing-* requires the prefix", () => {
    expect(matchTag("addon:*", ["addon:ssl", "task:installation"])).toBe(true);
    expect(matchTag("addon:*", ["task:installation"])).toBe(false);
  });
});

describe("buildFilter", () => {
  it("all=true matches everything", () => {
    const f = buildFilter({ all: true });
    expect(f.matches("any/id", [])).toBe(true);
  });

  it("include-tags require at least one match", () => {
    const f = buildFilter({ tags: ["cost:quick"] });
    expect(f.matches("a/b", ["cost:quick"])).toBe(true);
    expect(f.matches("a/b", ["cost:slow"])).toBe(false);
  });

  it("exclude-tags subtract matches", () => {
    const f = buildFilter({ all: true, excludeTags: ["needs:*"] });
    expect(f.matches("a/b", ["needs:internet"])).toBe(false);
    expect(f.matches("a/b", ["cost:quick"])).toBe(true);
  });

  it("include via regex on scenario id", () => {
    const f = buildFilter({ regex: ["^postgres/"] });
    expect(f.matches("postgres/ssl", [])).toBe(true);
    expect(f.matches("nginx/default", [])).toBe(false);
  });

  it("exclude via regex on scenario id", () => {
    const f = buildFilter({ all: true, excludeRegex: ["production"] });
    expect(f.matches("postgres/default", [])).toBe(true);
    expect(f.matches("postgres/production-failover", [])).toBe(false);
  });

  it("ci-pr style preset: critical tag + cost:quick, excluding needs:*", () => {
    const f = buildFilter({
      tags: ["coverage:critical", "cost:quick"],
      excludeTags: ["needs:*"],
      excludeRegex: ["production"],
    });
    expect(f.matches("postgres/oidc", ["coverage:critical"])).toBe(true);
    expect(f.matches("postgres/quick", ["cost:quick"])).toBe(true);
    expect(f.matches("postgres/quick-net", ["cost:quick", "needs:internet"])).toBe(false);
    expect(f.matches("postgres/production-foo", ["coverage:critical"])).toBe(false);
    expect(f.matches("postgres/slow", ["cost:slow"])).toBe(false);
  });
});

describe("buildAdHocFilter", () => {
  it("layers include-tags and exclude-tags", () => {
    const f = buildAdHocFilter({ includeTags: ["base:oci-image"], excludeTags: ["addon:*"] });
    expect(f.matches("a/b", ["base:oci-image"])).toBe(true);
    expect(f.matches("a/b", ["base:oci-image", "addon:ssl"])).toBe(false);
    expect(f.matches("a/b", ["base:docker-compose"])).toBe(false);
  });
});

describe("loadTestSets / resolvePreset", () => {
  it("loads JSON file and resolves named preset", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-sets-"));
    const file = path.join(tmpDir, "test-sets.json");
    fs.writeFileSync(file, JSON.stringify({
      presets: {
        smoke: { tags: ["cost:quick"] },
      },
    }));
    try {
      const data = loadTestSets(file);
      expect(resolvePreset("smoke", data).tags).toEqual(["cost:quick"]);
      expect(() => resolvePreset("missing", data)).toThrow(/Unknown preset/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws on missing file", () => {
    expect(() => loadTestSets("/no/such/file.json")).toThrow(/not found/);
  });
});
