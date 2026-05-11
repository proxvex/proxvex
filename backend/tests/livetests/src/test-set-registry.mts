/**
 * Loads and resolves named presets from `e2e/test-sets.json`. Each preset
 * describes a filter that the runner applies to the full scenario list.
 *
 * A filter is the conjunction of:
 *   - INCLUDE: union of (tag-match, regex-match, or `all=true` → everything).
 *   - EXCLUDE: any scenario matching an excludeTag (glob) or excludeRegex
 *              is removed from the include set.
 *
 * Tag matching supports trailing-`*` glob (e.g. `needs:*`, `addon:*`). Other
 * wildcards are not supported on purpose — the user explicitly opted for a
 * simple tag-list model rather than a boolean DSL.
 */

import fs from "node:fs";

export interface PresetSpec {
  description?: string;
  /** Include scenarios that have ANY of these tags (exact or glob). */
  tags?: string[];
  /** Include scenarios whose id matches ANY of these regex patterns. */
  regex?: string[];
  /** If true, include every scenario. Overrides `tags`/`regex`. */
  all?: boolean;
  /** Exclude scenarios that have ANY of these tags (exact or glob). */
  excludeTags?: string[];
  /** Exclude scenarios whose id matches ANY of these regex patterns. */
  excludeRegex?: string[];
}

export interface ResolvedFilter {
  /** Predicate: returns true if the scenario passes the filter. */
  matches: (scenarioId: string, allTags: string[]) => boolean;
}

interface TestSetsFile {
  presets: Record<string, PresetSpec>;
}

// ── Public API ──

export function loadTestSets(path: string): TestSetsFile {
  if (!fs.existsSync(path)) {
    throw new Error(`test-sets file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  const data = parsed as { presets?: unknown };
  if (!data.presets || typeof data.presets !== "object") {
    throw new Error(`${path} is missing a 'presets' object`);
  }
  return { presets: data.presets as Record<string, PresetSpec> };
}

export function resolvePreset(name: string, file: TestSetsFile): PresetSpec {
  const preset = file.presets[name];
  if (!preset) {
    const available = Object.keys(file.presets).sort().join(", ");
    throw new Error(`Unknown preset '${name}'. Available: ${available}`);
  }
  return preset;
}

/**
 * Build a filter predicate from a preset spec.
 * `untestable` is handled by the caller (always excluded unless explicitly
 * overridden), not in the preset itself.
 */
export function buildFilter(spec: PresetSpec): ResolvedFilter {
  const includeRegex = (spec.regex ?? []).map((r) => new RegExp(r));
  const excludeRegex = (spec.excludeRegex ?? []).map((r) => new RegExp(r));
  const includeTags = spec.tags ?? [];
  const excludeTags = spec.excludeTags ?? [];

  return {
    matches: (scenarioId, allTags) => {
      // INCLUDE
      let included = false;
      if (spec.all) included = true;
      if (!included) {
        for (const tag of includeTags) {
          if (matchTag(tag, allTags)) {
            included = true;
            break;
          }
        }
      }
      if (!included) {
        for (const r of includeRegex) {
          if (r.test(scenarioId)) {
            included = true;
            break;
          }
        }
      }
      if (!included) return false;

      // EXCLUDE
      for (const tag of excludeTags) {
        if (matchTag(tag, allTags)) return false;
      }
      for (const r of excludeRegex) {
        if (r.test(scenarioId)) return false;
      }
      return true;
    },
  };
}

/**
 * Match a tag pattern against a scenario's tags.
 * Supports trailing-* glob only: `needs:*` matches `needs:internet`,
 * `needs:cf-token`, etc. Exact match otherwise.
 */
export function matchTag(pattern: string, tags: string[]): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return tags.some((t) => t.startsWith(prefix));
  }
  return tags.includes(pattern);
}

/**
 * Build a filter from ad-hoc CLI tag flags. The semantics mirror
 * `buildFilter`: include-tags are unioned, exclude-tags are subtracted.
 */
export function buildAdHocFilter(opts: {
  includeTags: string[];
  excludeTags: string[];
}): ResolvedFilter {
  return buildFilter({
    tags: opts.includeTags,
    excludeTags: opts.excludeTags,
  });
}
