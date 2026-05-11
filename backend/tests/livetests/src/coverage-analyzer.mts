/**
 * Static coverage analyzer for live integration tests.
 *
 * Reads application metadata (`json/applications/<app>/application.json`) and
 * test scenarios (`json/applications/<app>/tests/<variant>.json`) directly from
 * disk — no network, no deployer roundtrip — and computes:
 *
 *   - The ideal coverage matrix (combinations supported by app metadata).
 *   - Which cells are covered by existing scenarios.
 *   - Gaps: supported cells without a scenario.
 *   - Orphans: scenarios in cells the metadata doesn't support.
 *   - A deterministic representative per covered cell.
 *   - Computed tags per scenario for use by `--tag` / `--set` selectors.
 *
 * Matrix axes:
 *   - base:     `oci-image` | `docker-compose` | `null` (from `app.extends`).
 *   - addonCombo: sorted, plus-joined effective addons (`none` | `ssl` | `oidc`
 *                | `ssl+oidc` | ...). Derived from each scenario's
 *                selectedAddons; for ideal cells, derived from each app's
 *                effective supported_addons power-set.
 *   - task:     `installation` | `upgrade` | `reconfigure`
 *                (default: `installation`).
 *
 * "Effective supported_addons" follow the simple `extends` union used elsewhere
 * in this codebase.
 */

import fs from "node:fs";
import path from "node:path";

// ── Constants ──

export const TASKS = ["installation", "upgrade", "reconfigure"] as const;
export type Task = (typeof TASKS)[number];

const ADDON_SHORT_NAMES: Record<string, string> = {
  "addon-ssl": "ssl",
  "addon-acme": "acme",
  "addon-oidc": "oidc",
  "samba-shares": "samba",
};

// ── Coverage config ──

/**
 * Optional `e2e/coverage-config.json` shapes the ideal matrix. Without it,
 * the analyzer emits the naive power-set of every supported addon — typically
 * an over-estimate that hides which gaps actually matter.
 *
 * Semantics:
 *   addonRules.<addon>.excluded:    addon removed from ALL apps' effective set.
 *   addonRules.<addon>.isolated:    addon only ever appears solo (size-1
 *                                   subsets), never in combinations.
 *   addonRules.<addon>.onlyForApps: addon kept only for these app ids;
 *                                   stripped from all other apps' effective
 *                                   set.
 *   appOverrides.<id>.tasks:        whitelist of tasks (replaces inferred
 *                                   hasInstallation/Upgrade/Reconfigure).
 *   appOverrides.<id>.addonCombos:  whitelist of addon-combos (canonical
 *                                   form, e.g. "none", "ssl", "oidc+ssl");
 *                                   bypasses power-set enumeration.
 *
 * An override entry forces the app to be included in the matrix even if
 * `hidden: true` — useful for host-only apps like proxmox where we still
 * want regression coverage visibility.
 */
export interface AddonRule {
  description?: string;
  excluded?: boolean;
  isolated?: boolean;
  onlyForApps?: string[];
}

export interface AppOverride {
  description?: string;
  /** If true, the app is dropped from the matrix entirely (no covered cells,
   *  no gaps). Use for deprecated apps still present in `json/applications/`
   *  but not part of the test contract. */
  excluded?: boolean;
  tasks?: Task[];
  addonCombos?: string[];
}

/**
 * A specific matrix cell to remove from the ideal matrix, regardless of which
 * app would otherwise emit it. Use for "these combinations aren't worth
 * tracking" rules that cross app boundaries — e.g. docker-compose/none/
 * reconfigure (a docker-compose app reconfiguring to no addons isn't a
 * realistic deployment pattern). Scenarios that map to a skipped cell are
 * neither covered nor orphan: they simply don't contribute to the matrix.
 */
export interface SkipCell {
  description?: string;
  base: string;
  addonCombo: string;
  task: Task;
}

export interface CoverageConfig {
  addonRules?: Record<string, AddonRule>;
  appOverrides?: Record<string, AppOverride>;
  skipCells?: SkipCell[];
}

// ── Types ──

export interface AppRecord {
  id: string;
  extends?: string;
  ownSupportedAddons: string[];
  effectiveSupportedAddons: string[];
  requiredAddons: string[];
  hidden: boolean;
  hasInstallation: boolean;
  hasUpgrade: boolean;
  hasReconfigure: boolean;
}

export interface ScenarioRecord {
  id: string;
  application: string;
  variant: string;
  task: Task;
  selectedAddons: string[];
  tags: string[];
  untestable?: string;
  filePath: string;
}

export interface CellKey {
  base: string;
  addonCombo: string;
  task: Task;
}

export interface CellState {
  cell: CellKey;
  scenarios: ScenarioRecord[];
  representative?: ScenarioRecord;
}

export interface CoverageReport {
  apps: AppRecord[];
  scenarios: ScenarioRecord[];
  idealCells: CellKey[];
  covered: CellState[];
  gaps: CellKey[];
  orphans: ScenarioRecord[];
  /** Per-scenario computed tags (keyed by scenario id). */
  computedTags: Map<string, string[]>;
}

// ── Public API ──

/**
 * Run a full coverage analysis against the repository at `rootDir`.
 * `rootDir` is typically the project root (the directory containing
 * `json/applications/`).
 *
 * If `e2e/coverage-config.json` exists, its rules are applied to shape the
 * ideal matrix. Pass `config` explicitly to override the default discovery
 * (useful for tests).
 */
export function analyzeCoverage(rootDir: string, configOverride?: CoverageConfig): CoverageReport {
  const config = configOverride ?? loadCoverageConfig(rootDir);
  const apps = applyAddonRules(loadAppMetadata(rootDir), config);
  const scenarios = loadScenarios(rootDir, apps);
  const idealCells = computeIdealMatrix(apps, config);
  const { covered, gaps, orphans } = mapScenariosToCells(scenarios, idealCells, apps);
  const computedTags = deriveComputedTags(scenarios, apps, covered);
  return { apps, scenarios, idealCells, covered, gaps, orphans, computedTags };
}

/**
 * Load `e2e/coverage-config.json` if it exists, otherwise return an empty
 * config. Missing files are not an error — naive power-set is the safe
 * fallback.
 */
export function loadCoverageConfig(rootDir: string): CoverageConfig {
  const configPath = path.join(rootDir, "e2e", "coverage-config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as CoverageConfig;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }
}

/**
 * Apply `excluded` and `onlyForApps` addon rules to each app's effective
 * addon list. `isolated` is handled later in matrix construction since it
 * affects subset enumeration, not the addon set itself.
 */
export function applyAddonRules(apps: AppRecord[], config: CoverageConfig): AppRecord[] {
  const rules = config.addonRules ?? {};
  if (Object.keys(rules).length === 0) return apps;
  return apps.map((app) => ({
    ...app,
    effectiveSupportedAddons: app.effectiveSupportedAddons.filter((addonId) => {
      const rule = rules[addonId];
      if (!rule) return true;
      if (rule.excluded) return false;
      if (rule.onlyForApps && !rule.onlyForApps.includes(app.id)) return false;
      return true;
    }),
  }));
}

/**
 * Load all application metadata under `<rootDir>/json/applications/`.
 * Resolves `extends` for `supported_addons` (union with parent).
 */
export function loadAppMetadata(rootDir: string): AppRecord[] {
  const appsDir = path.join(rootDir, "json", "applications");
  if (!fs.existsSync(appsDir)) return [];

  const rawApps = new Map<string, { extends?: string; supported_addons?: string[]; required_addons?: string[]; hidden?: boolean; installation?: unknown; upgrade?: unknown; reconfigure?: unknown }>();
  for (const entry of fs.readdirSync(appsDir)) {
    const appJsonPath = path.join(appsDir, entry, "application.json");
    if (!fs.existsSync(appJsonPath)) continue;
    try {
      const content = JSON.parse(fs.readFileSync(appJsonPath, "utf-8")) as Record<string, unknown>;
      const ext = typeof content.extends === "string" ? content.extends : undefined;
      rawApps.set(entry, {
        ...(ext ? { extends: ext } : {}),
        supported_addons: Array.isArray(content.supported_addons) ? content.supported_addons as string[] : [],
        required_addons: Array.isArray(content.required_addons) ? content.required_addons as string[] : [],
        hidden: content.hidden === true,
        installation: content.installation,
        upgrade: content.upgrade,
        reconfigure: content.reconfigure,
      });
    } catch {
      // skip unparseable
    }
  }

  const records: AppRecord[] = [];
  for (const [id, raw] of rawApps) {
    const ext = raw.extends?.replace(/^json:/, "");
    const parent = ext ? rawApps.get(ext) : undefined;
    const ownSupported = raw.supported_addons ?? [];
    const parentSupported = parent?.supported_addons ?? [];
    const effective = Array.from(new Set([...parentSupported, ...ownSupported]));

    records.push({
      id,
      ...(ext ? { extends: ext } : {}),
      ownSupportedAddons: ownSupported,
      effectiveSupportedAddons: effective,
      requiredAddons: raw.required_addons ?? [],
      hidden: raw.hidden === true,
      // Effective task availability: own definition OR inherited from parent.
      hasInstallation: hasTask(raw.installation) || hasTask(parent?.installation),
      hasUpgrade: hasTask(raw.upgrade) || hasTask(parent?.upgrade),
      hasReconfigure: hasTask(raw.reconfigure) || hasTask(parent?.reconfigure),
    });
  }

  return records.sort((a, b) => a.id.localeCompare(b.id));
}

function hasTask(taskDef: unknown): boolean {
  return typeof taskDef === "object" && taskDef !== null;
}

/**
 * Load test scenarios from all `json/applications/*\/tests/*.json` files.
 * Mirrors the persistence-manager loader: skips files starting with
 * `production` (those are excluded from the deployer API by design).
 */
export function loadScenarios(rootDir: string, apps: AppRecord[]): ScenarioRecord[] {
  const appsDir = path.join(rootDir, "json", "applications");
  if (!fs.existsSync(appsDir)) return [];

  const appIds = new Set(apps.map((a) => a.id));
  const scenarios: ScenarioRecord[] = [];

  for (const appId of fs.readdirSync(appsDir)) {
    if (!appIds.has(appId)) continue;
    const testsDir = path.join(appsDir, appId, "tests");
    if (!fs.existsSync(testsDir)) continue;

    for (const fileName of fs.readdirSync(testsDir)) {
      if (!fileName.endsWith(".json")) continue;
      if (fileName.startsWith("production")) continue;
      const filePath = path.join(testsDir, fileName);
      if (!fs.statSync(filePath).isFile()) continue;
      const variant = fileName.replace(/\.json$/, "");

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }

      const taskRaw = typeof data.task === "string" ? data.task : "installation";
      const task: Task = (TASKS as readonly string[]).includes(taskRaw) ? (taskRaw as Task) : "installation";

      const selectedAddons = Array.isArray(data.selectedAddons)
        ? (data.selectedAddons as string[])
        : Array.isArray(data.addons)
          ? (data.addons as string[])
          : [];

      const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];
      const untestable = typeof data.untestable === "string" ? data.untestable : undefined;

      scenarios.push({
        id: `${appId}/${variant}`,
        application: appId,
        variant,
        task,
        selectedAddons,
        tags,
        ...(untestable ? { untestable } : {}),
        filePath,
      });
    }
  }

  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Compute the set of ideal coverage cells from app metadata.
 *
 * Per app:
 *   - base = app.extends (or `none` if missing)
 *   - tasks: from appOverrides if set, otherwise inferred from app.hasXxx
 *     fields (installation/upgrade/reconfigure).
 *   - addon combos: from appOverrides.addonCombos if set, otherwise the
 *     power-set of `effectiveSupportedAddons`, filtered by `required_addons`
 *     and the `isolated` addon rule.
 *
 * Hidden apps are skipped UNLESS they have an entry in `appOverrides` — the
 * override signals an explicit decision to track them.
 */
export function computeIdealMatrix(apps: AppRecord[], config: CoverageConfig = {}): CellKey[] {
  const seen = new Set<string>();
  const cells: CellKey[] = [];
  const overrides = config.appOverrides ?? {};
  const isolatedAddons = new Set(
    Object.entries(config.addonRules ?? {})
      .filter(([, r]) => r?.isolated)
      .map(([id]) => id),
  );

  for (const app of apps) {
    const override = overrides[app.id];
    if (override?.excluded) continue;
    if (app.hidden && !override) continue;
    const base = app.extends ?? "none";

    // ── Tasks ──
    let tasks: Task[];
    if (override?.tasks && override.tasks.length > 0) {
      tasks = override.tasks;
    } else {
      tasks = [];
      if (app.hasInstallation) tasks.push("installation");
      if (app.hasUpgrade) tasks.push("upgrade");
      if (app.hasReconfigure) tasks.push("reconfigure");
      if (tasks.length === 0) tasks.push("installation");
    }

    // ── Addon combos ──
    let combos: string[];
    if (override?.addonCombos && override.addonCombos.length > 0) {
      // Whitelist — taken verbatim. Caller is responsible for canonical form.
      combos = override.addonCombos;
    } else {
      const subsets = powerSet(app.effectiveSupportedAddons).filter((subset) => {
        // Every required addon must be present in the subset.
        if (!app.requiredAddons.every((req) => subset.includes(req))) return false;
        // Isolated addons may only appear solo.
        const isolatedHere = subset.filter((a) => isolatedAddons.has(a));
        if (isolatedHere.length > 0 && subset.length > 1) return false;
        return true;
      });
      combos = subsets.map(normalizeAddonCombo);
    }

    for (const addonCombo of combos) {
      for (const task of tasks) {
        const key = `${base}|${addonCombo}|${task}`;
        if (!seen.has(key)) {
          seen.add(key);
          cells.push({ base, addonCombo, task });
        }
      }
    }
  }

  // Apply global skipCells filter — same-shape entries are removed from the
  // ideal matrix regardless of which app emitted them.
  const skipSet = new Set((config.skipCells ?? []).map((s) => `${s.base}|${s.addonCombo}|${s.task}`));
  const filtered = skipSet.size > 0 ? cells.filter((c) => !skipSet.has(cellKey(c))) : cells;

  return filtered.sort(cellComparator);
}

function powerSet<T>(items: T[]): T[][] {
  const result: T[][] = [[]];
  for (const item of items) {
    const len = result.length;
    for (let i = 0; i < len; i++) {
      const existing = result[i];
      if (existing) result.push([...existing, item]);
    }
  }
  return result;
}

function cellComparator(a: CellKey, b: CellKey): number {
  if (a.base !== b.base) return a.base.localeCompare(b.base);
  if (a.addonCombo !== b.addonCombo) return a.addonCombo.localeCompare(b.addonCombo);
  return a.task.localeCompare(b.task);
}

/** Canonical addon-combo string. Empty list → "none". */
export function normalizeAddonCombo(addons: string[]): string {
  if (addons.length === 0) return "none";
  const short = addons.map((a) => ADDON_SHORT_NAMES[a] ?? a).sort();
  return short.join("+");
}

/**
 * Map each scenario to its cell. Returns:
 *   - covered: cells with ≥1 scenario, with a chosen representative.
 *   - gaps: ideal cells with no scenario.
 *   - orphans: scenarios whose cell isn't in the ideal matrix.
 */
export function mapScenariosToCells(
  scenarios: ScenarioRecord[],
  ideal: CellKey[],
  apps: AppRecord[],
): { covered: CellState[]; gaps: CellKey[]; orphans: ScenarioRecord[] } {
  const appById = new Map(apps.map((a) => [a.id, a]));
  const idealKeys = new Set(ideal.map(cellKey));
  const byKey = new Map<string, ScenarioRecord[]>();
  const orphans: ScenarioRecord[] = [];

  for (const scenario of scenarios) {
    const app = appById.get(scenario.application);
    if (!app) {
      orphans.push(scenario);
      continue;
    }
    const base = app.extends ?? "none";
    const combo = normalizeAddonCombo(scenario.selectedAddons);
    const key = `${base}|${combo}|${scenario.task}`;
    if (!idealKeys.has(key)) {
      orphans.push(scenario);
      continue;
    }
    const list = byKey.get(key) ?? [];
    list.push(scenario);
    byKey.set(key, list);
  }

  const covered: CellState[] = [];
  for (const cell of ideal) {
    const list = byKey.get(cellKey(cell));
    if (!list || list.length === 0) continue;
    covered.push({
      cell,
      scenarios: list,
      representative: chooseRepresentative(list),
    });
  }

  const gaps: CellKey[] = [];
  for (const cell of ideal) {
    if (!byKey.has(cellKey(cell))) gaps.push(cell);
  }

  return { covered, gaps, orphans };
}

function cellKey(c: CellKey): string {
  return `${c.base}|${c.addonCombo}|${c.task}`;
}

/**
 * Pick a deterministic representative for a covered cell:
 *   1. Scenario with `coverage:representative` tag wins.
 *   2. Variant named `default` wins.
 *   3. Shortest variant name wins.
 *   4. Tiebreaker: alphabetical scenario id.
 */
export function chooseRepresentative(candidates: ScenarioRecord[]): ScenarioRecord {
  if (candidates.length === 0) {
    throw new Error("chooseRepresentative called with empty candidates");
  }
  const sorted = [...candidates].sort((a, b) => {
    const aOverride = a.tags.includes("coverage:representative") ? 0 : 1;
    const bOverride = b.tags.includes("coverage:representative") ? 0 : 1;
    if (aOverride !== bOverride) return aOverride - bOverride;
    const aDefault = a.variant === "default" ? 0 : 1;
    const bDefault = b.variant === "default" ? 0 : 1;
    if (aDefault !== bDefault) return aDefault - bDefault;
    if (a.variant.length !== b.variant.length) return a.variant.length - b.variant.length;
    return a.id.localeCompare(b.id);
  });
  return sorted[0]!;
}

/**
 * Derive computed tags for every scenario:
 *   - app:<id>, base:<extends>, task:<task>, addon:<each>
 *   - coverage:representative — set on the chosen representative of each cell.
 *   - coverage:essentials     — set on every representative (= minimum
 *                              execution set).
 *   - coverage:critical       — set on representatives whose addon combo
 *                              includes `oidc`, OR whose addon combo is `none`
 *                              (base-default Smoke). Auth misconfiguration is
 *                              high-impact, and base defaults are the
 *                              cheapest sanity signal.
 *
 * Manual `coverage:critical` or `coverage:demote` tags in test.json override
 * the heuristic: critical adds the tag if not already added; demote strips
 * critical and essentials.
 */
export function deriveComputedTags(
  scenarios: ScenarioRecord[],
  apps: AppRecord[],
  covered: CellState[],
): Map<string, string[]> {
  const appById = new Map(apps.map((a) => [a.id, a]));
  const representativeIds = new Set(covered.map((c) => c.representative?.id).filter((x): x is string => Boolean(x)));
  const result = new Map<string, string[]>();

  for (const scenario of scenarios) {
    const app = appById.get(scenario.application);
    const base = app?.extends ?? "none";
    const tagSet = new Set<string>([
      `app:${scenario.application}`,
      `base:${base}`,
      `task:${scenario.task}`,
    ]);
    for (const addon of scenario.selectedAddons) {
      tagSet.add(`addon:${ADDON_SHORT_NAMES[addon] ?? addon}`);
    }
    if (scenario.selectedAddons.length === 0) {
      tagSet.add("addon:none");
    }

    if (representativeIds.has(scenario.id)) {
      tagSet.add("coverage:representative");
      tagSet.add("coverage:essentials");

      const combo = normalizeAddonCombo(scenario.selectedAddons);
      const isCritical = combo === "none" || combo.split("+").includes("oidc");
      if (isCritical) tagSet.add("coverage:critical");
    }

    // Manual overrides via declared tags.
    if (scenario.tags.includes("coverage:critical")) {
      tagSet.add("coverage:critical");
      tagSet.add("coverage:essentials");
    }
    if (scenario.tags.includes("coverage:demote")) {
      tagSet.delete("coverage:critical");
      tagSet.delete("coverage:essentials");
    }

    result.set(scenario.id, [...tagSet].sort());
  }

  return result;
}

/**
 * Group cells by base for rendering. Returns a deterministic order:
 * bases sorted; within each base, addon-combos sorted with `none` first;
 * tasks ordered as `installation` < `upgrade` < `reconfigure`.
 */
export function groupCellsByBase(
  cells: Iterable<CellKey>,
): Map<string, Map<string, Map<Task, true>>> {
  const grouped = new Map<string, Map<string, Map<Task, true>>>();
  for (const cell of cells) {
    if (!grouped.has(cell.base)) grouped.set(cell.base, new Map());
    const base = grouped.get(cell.base)!;
    if (!base.has(cell.addonCombo)) base.set(cell.addonCombo, new Map());
    base.get(cell.addonCombo)!.set(cell.task, true);
  }
  return grouped;
}
