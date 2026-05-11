import { describe, it, expect } from "vitest";
import { applyTagFilter } from "./scenario-planner.mjs";
import { buildAdHocFilter, buildFilter } from "./test-set-registry.mjs";
import type { ResolvedScenario } from "./livetest-types.mjs";

function makeScenarios(
  defs: Record<string, { tags?: string[]; computedTags?: string[]; untestable?: string }>,
): Map<string, ResolvedScenario> {
  const all = new Map<string, ResolvedScenario>();
  for (const [id, def] of Object.entries(defs)) {
    const [app] = id.split("/");
    all.set(id, {
      id,
      application: app!,
      description: `Test ${id}`,
      ...(def.tags ? { tags: def.tags } : {}),
      ...(def.computedTags ? { computedTags: def.computedTags } : {}),
      ...(def.untestable ? { untestable: def.untestable } : {}),
    });
  }
  return all;
}

describe("applyTagFilter", () => {
  it("returns all ids when no filter is provided", () => {
    const all = makeScenarios({
      "a/b": {},
      "c/d": {},
    });
    expect(applyTagFilter(["a/b", "c/d"], all, null)).toEqual(["a/b", "c/d"]);
  });

  it("by default excludes scenarios with `untestable`", () => {
    const all = makeScenarios({
      "a/b": {},
      "c/d": { untestable: "needs audio passthrough" },
    });
    expect(applyTagFilter(["a/b", "c/d"], all, null)).toEqual(["a/b"]);
  });

  it("--include-untestable overrides exclusion", () => {
    const all = makeScenarios({
      "a/b": {},
      "c/d": { untestable: "needs audio passthrough" },
    });
    expect(
      applyTagFilter(["a/b", "c/d"], all, null, { includeUntestable: true }),
    ).toEqual(["a/b", "c/d"]);
  });

  it("matches against the union of declared and computed tags", () => {
    const all = makeScenarios({
      "a/b": { tags: ["cost:quick"], computedTags: ["coverage:critical", "app:a"] },
      "c/d": { computedTags: ["app:c"] },
    });
    const filter = buildAdHocFilter({ includeTags: ["coverage:critical"], excludeTags: [] });
    expect(applyTagFilter(["a/b", "c/d"], all, filter)).toEqual(["a/b"]);
  });

  it("preset-style filter: ci-pr-like behaviour", () => {
    const all = makeScenarios({
      "fast/default": { tags: ["cost:quick"], computedTags: ["coverage:critical"] },
      "slow/default": { tags: ["cost:slow"] },
      "net/quick": { tags: ["cost:quick", "needs:internet"] },
      "prod/default": { computedTags: ["coverage:critical"] },
    });
    const filter = buildFilter({
      tags: ["coverage:critical", "cost:quick"],
      excludeTags: ["needs:*"],
      excludeRegex: ["production"],
    });
    const result = applyTagFilter(
      ["fast/default", "slow/default", "net/quick", "prod/default"],
      all,
      filter,
    );
    expect(result.sort()).toEqual(["fast/default", "prod/default"]);
  });

  it("untestable is enforced even when filter would otherwise include it", () => {
    const all = makeScenarios({
      "a/b": { tags: ["cost:quick"], untestable: "audio" },
      "c/d": { tags: ["cost:quick"] },
    });
    const filter = buildAdHocFilter({ includeTags: ["cost:quick"], excludeTags: [] });
    expect(applyTagFilter(["a/b", "c/d"], all, filter)).toEqual(["c/d"]);
  });
});
