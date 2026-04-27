/**
 * Pure-function module that classifies a list of changed file paths into a
 * set of livetest scenarios that should run on a PR. The runtime context
 * (apps using a template, addons using a script, etc.) is injected via
 * `ResolverContext` so the module is testable without filesystem access.
 *
 * Strategy is explicitly minimalist: a PR runs only the scenarios that are
 * eindeutig betroffen. There is no automatic fallback to `--all`. Backend,
 * framework and infra changes default to `directive-required` — the PR
 * author opts in via a `Livetest:` directive in the PR body.
 */

export interface ResolverContext {
  /** Apps that reference the given template (transitive via inheritance). */
  appsUsingTemplate: (templateName: string) => string[];
  /** Apps whose templates reference the given script (script or library). */
  appsUsingScript: (scriptName: string) => string[];
  /** Apps that extend the given parent app (including the parent itself). */
  appsInheritingFrom: (parentAppId: string) => string[];
  /** Addon IDs whose templates reference the given template. */
  addonsUsingTemplate: (templateName: string) => string[];
  /** Addon IDs whose templates reference the given script. */
  addonsUsingScript: (scriptName: string) => string[];
  /** Scenario IDs (e.g. "gitea/ssl") whose `selectedAddons` includes the addon. */
  scenariosUsingAddon: (addonId: string) => string[];
}

/**
 * Outcome of classifying a single file. Either:
 *  - skip (with reason),
 *  - select (apps and/or scenarios to run),
 *  - directive-required (cannot decide; PR-Direktive needed).
 */
export type ChangeClassification =
  | { kind: "skip"; reason: string; warning?: boolean }
  | { kind: "select"; apps: string[]; scenarios: string[]; reason: string }
  | { kind: "directive-required"; reason: string };

export interface PerFileClassification {
  file: string;
  classification: ChangeClassification;
}

export interface AffectedTestsResult {
  /** True when the livetest job should be skipped entirely. */
  skip: boolean;
  /** Filter passed to live-test-runner.mts. Empty when `skip=true`. */
  filter: string;
  /** Final list of explicitly selected scenario IDs (informational). */
  scenarios: string[];
  /** Final list of selected app names (informational). */
  apps: string[];
  /** Per-file decisions. */
  perFile: PerFileClassification[];
  /** ::notice:: messages. */
  reasons: string[];
  /** ::warning:: messages. */
  warnings: string[];
  /** True when a `Livetest:` directive in the PR body was applied. */
  directiveUsed: boolean;
  /** Echoed directive value, for the summary. */
  directiveValue: string | null;
}

/**
 * Parses a PR body for a `Livetest:` directive. Case-insensitive, first
 * match wins. Returns the trimmed value or null when no directive is
 * present.
 */
export function parseDirective(prBody: string | null | undefined): string | null {
  if (!prBody) return null;
  const lines = prBody.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*livetest\s*:\s*(.+?)\s*$/i);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Top-level path classifier. Pure function, no I/O. */
export function classifyFile(filePath: string, ctx: ResolverContext): ChangeClassification {
  const f = filePath.replace(/\\/g, "/");

  // Skips: frontend, docs, top-level markdown
  if (f.startsWith("frontend/")) return skip("frontend-only");
  if (f.startsWith("docs/")) return skip("documentation");
  if (f === "CHANGELOG.md") return skip("changelog");
  if (f === "release-please-config.json") return skip("release tooling");
  if (f.endsWith(".md") && !f.startsWith("backend/") && !f.startsWith("json/")) {
    return skip("top-level markdown");
  }

  // Backend / schemas / e2e / cli / install — directive required
  if (f === "install-proxvex.sh") return directive("install-proxvex.sh");
  if (f.startsWith("backend/")) {
    if (f.endsWith(".md")) return skip("backend doc");
    return directive("backend code change");
  }
  if (f.startsWith("schemas/")) return directive("schema change");
  if (f.startsWith("e2e/")) return directive("e2e infra change");
  if (f.startsWith("cli/")) return directive("cli change");

  // Workflows
  if (f.startsWith(".github/workflows/")) {
    const name = f.slice(".github/workflows/".length);
    if (name.startsWith("livetest-") || name === "affected-tests.yml") {
      return directive("livetest workflow change");
    }
    return skip("non-livetest workflow");
  }

  // json/frameworks
  if (f.startsWith("json/frameworks/")) return directive("framework change");

  // json/applications
  const appMatch = f.match(/^json\/applications\/([^/]+)\/(.*)$/);
  if (appMatch) {
    const [, appName, rest] = appMatch as [string, string, string];

    const testMatch = rest.match(/^tests\/([^/]+)\.json$/);
    if (testMatch) {
      const variant = testMatch[1]!;
      if (variant.startsWith("production")) {
        return skip(`production test ignored (${appName}/${variant})`);
      }
      return select([], [`${appName}/${variant}`], `test definition change: ${appName}/${variant}`);
    }
    if (rest.startsWith("tests/uploads/")) {
      return select([appName], [], `test upload change in ${appName}`);
    }
    if (rest === "application.json") {
      const apps = ctx.appsInheritingFrom(appName);
      return select(apps, [], `application.json change for ${appName} (incl. extending apps)`);
    }
    if (rest.startsWith("templates/")) {
      const apps = ctx.appsInheritingFrom(appName);
      return select(apps, [], `template change in ${appName} (incl. extending apps)`);
    }
    if (rest.startsWith("scripts/")) {
      return select([appName], [], `script change in ${appName}`);
    }

    return skip(`unrecognized path under ${appName}/`);
  }

  // json/shared/templates
  const sharedTemplateMatch = f.match(/^json\/shared\/templates\/(.+)$/);
  if (sharedTemplateMatch) {
    const rest = sharedTemplateMatch[1]!;
    if (!rest.endsWith(".json")) return skip(`non-template file under shared/templates: ${rest}`);
    const baseName = stripJsonExt(basename(rest));
    const apps = ctx.appsUsingTemplate(baseName);
    const addons = ctx.addonsUsingTemplate(baseName);
    const scenarios = unique(addons.flatMap((id) => ctx.scenariosUsingAddon(id)));
    if (apps.length === 0 && scenarios.length === 0) {
      return {
        kind: "skip",
        reason: `shared template ${baseName}: no users found`,
        warning: true,
      };
    }
    return select(apps, scenarios, `shared template ${baseName}`);
  }

  // json/shared/scripts
  const sharedScriptMatch = f.match(/^json\/shared\/scripts\/(.+)$/);
  if (sharedScriptMatch) {
    const rest = sharedScriptMatch[1]!;
    if (rest.endsWith(".md")) return skip(`script doc: ${rest}`);
    const baseName = basename(rest);
    const apps = ctx.appsUsingScript(baseName);
    const addons = ctx.addonsUsingScript(baseName);
    const scenarios = unique(addons.flatMap((id) => ctx.scenariosUsingAddon(id)));
    if (apps.length === 0 && scenarios.length === 0) {
      return {
        kind: "skip",
        reason: `shared script ${baseName}: no users found`,
        warning: true,
      };
    }
    return select(apps, scenarios, `shared script ${baseName}`);
  }

  // json/addons
  const addonMatch = f.match(/^json\/addons\/([^/]+)$/);
  if (addonMatch) {
    const file = addonMatch[1]!;
    if (file.endsWith(".md")) return skip(`addon doc: ${file}`);
    if (file.endsWith(".json")) {
      const id = file.slice(0, -5);
      const scenarios = ctx.scenariosUsingAddon(id);
      if (scenarios.length === 0) {
        return { kind: "skip", reason: `addon ${id}: no scenarios use it`, warning: true };
      }
      return select([], scenarios, `addon ${id} change`);
    }
    return skip(`unrecognized addon file: ${file}`);
  }

  // Other json/
  if (f.startsWith("json/")) return directive(`unrecognized json/ path: ${f}`);

  // Default: skip
  return skip("not test-relevant");
}

export interface ComputeInput {
  changedFiles: string[];
  prBody?: string | null;
  context: ResolverContext;
}

export function computeAffectedTests({
  changedFiles,
  prBody,
  context,
}: ComputeInput): AffectedTestsResult {
  const directiveValue = parseDirective(prBody);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const perFile: PerFileClassification[] = [];

  const apps = new Set<string>();
  const scenarios = new Set<string>();
  let directiveRequired = false;
  const directiveReasons: string[] = [];

  for (const file of changedFiles.filter((f) => f && f.trim())) {
    const cls = classifyFile(file, context);
    perFile.push({ file, classification: cls });
    switch (cls.kind) {
      case "skip":
        if (cls.warning) warnings.push(cls.reason);
        break;
      case "select":
        for (const a of cls.apps) apps.add(a);
        for (const s of cls.scenarios) scenarios.add(s);
        reasons.push(cls.reason);
        break;
      case "directive-required":
        directiveRequired = true;
        directiveReasons.push(cls.reason);
        break;
    }
  }

  // Drop production scenarios — never run automatically.
  for (const s of [...scenarios]) {
    if (/\/production(?:[-_].*)?$/.test(s)) scenarios.delete(s);
  }
  // If an entire app is selected, drop its individual scenarios — they're subsumed.
  for (const s of [...scenarios]) {
    const [appName] = s.split("/");
    if (appName && apps.has(appName)) scenarios.delete(s);
  }

  // Directive overrides everything if present.
  if (directiveValue !== null) {
    return resolveDirective(
      directiveValue,
      perFile,
      reasons,
      warnings,
      [...apps].sort(),
      [...scenarios].sort(),
    );
  }

  if (directiveRequired) {
    const msg = `Livetest directive required: PR touches backend/framework/infra paths — add 'Livetest: <filter>' to the PR body to opt into targeted tests (${directiveReasons.join("; ")})`;
    warnings.push(msg);
    return {
      skip: true,
      filter: "",
      scenarios: [...scenarios].sort(),
      apps: [...apps].sort(),
      perFile,
      reasons,
      warnings,
      directiveUsed: false,
      directiveValue: null,
    };
  }

  if (apps.size === 0 && scenarios.size === 0) {
    return {
      skip: true,
      filter: "",
      scenarios: [],
      apps: [],
      perFile,
      reasons,
      warnings,
      directiveUsed: false,
      directiveValue: null,
    };
  }

  const filter = buildFilter([...apps], [...scenarios]);
  return {
    skip: false,
    filter,
    scenarios: [...scenarios].sort(),
    apps: [...apps].sort(),
    perFile,
    reasons,
    warnings,
    directiveUsed: false,
    directiveValue: null,
  };
}

function resolveDirective(
  rawValue: string,
  perFile: PerFileClassification[],
  reasons: string[],
  warnings: string[],
  computedApps: string[],
  computedScenarios: string[],
): AffectedTestsResult {
  const value = rawValue.trim();
  reasons.push(`PR-Directive applied: '${value}' (overrides auto-compute)`);
  if (value.toLowerCase() === "skip") {
    return {
      skip: true,
      filter: "",
      scenarios: computedScenarios,
      apps: computedApps,
      perFile,
      reasons,
      warnings,
      directiveUsed: true,
      directiveValue: value,
    };
  }
  return {
    skip: false,
    filter: value,
    scenarios: computedScenarios,
    apps: computedApps,
    perFile,
    reasons,
    warnings,
    directiveUsed: true,
    directiveValue: value,
  };
}

/**
 * Builds the regex filter passed to live-test-runner.mts.
 *  - Apps match `^app\/.*` (whole app)
 *  - Scenarios match `^app/variant$`
 *
 * Special-cases for nicer output:
 *  - exactly one app, no scenarios: `/^app\//`
 *  - exactly one scenario, no apps: `/^app\/variant$/`
 */
export function buildFilter(apps: string[], scenarios: string[]): string {
  const sortedApps = [...apps].sort();
  const sortedScenarios = [...scenarios].sort();

  if (sortedApps.length === 0 && sortedScenarios.length === 0) return "";

  if (sortedApps.length === 1 && sortedScenarios.length === 0) {
    return `/^${escapeRegex(sortedApps[0]!)}\\//`;
  }
  if (sortedApps.length === 0 && sortedScenarios.length === 1) {
    return `/^${escapeRegex(sortedScenarios[0]!)}$/`;
  }

  const parts: string[] = [];
  for (const a of sortedApps) parts.push(`${escapeRegex(a)}\\/.*`);
  for (const s of sortedScenarios) parts.push(escapeRegex(s));
  return `/^(${parts.join("|")})$/`;
}

function escapeRegex(s: string): string {
  // Escape regex metacharacters AND `/` so the output reads like a JS regex
  // literal (the runtime parses it via `regexArg.slice(1, -1) + new RegExp(...)`,
  // which works either way — escaping `/` is purely cosmetic for the summary).
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function stripJsonExt(name: string): string {
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

function skip(reason: string): ChangeClassification {
  return { kind: "skip", reason };
}

function directive(reason: string): ChangeClassification {
  return { kind: "directive-required", reason };
}

function select(apps: string[], scenarios: string[], reason: string): ChangeClassification {
  return {
    kind: "select",
    apps: [...new Set(apps)],
    scenarios: [...new Set(scenarios)],
    reason,
  };
}
