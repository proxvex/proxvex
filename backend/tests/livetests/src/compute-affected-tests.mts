#!/usr/bin/env tsx
/**
 * CLI wrapper around `affected-tests-resolver.mts`. Loads the persistence
 * layer, builds a `ResolverContext` from the running repository, and emits a
 * JSON document describing which livetest scenarios should run for the given
 * git diff. Optionally writes a Markdown summary fragment intended for
 * `$GITHUB_STEP_SUMMARY` in the workflow.
 *
 * Usage:
 *   tsx compute-affected-tests.mts --diff /tmp/changed.txt
 *                                  [--pr-body /tmp/body.md]
 *                                  [--summary-out /tmp/compute-summary.md]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { PersistenceManager } from "../../../src/persistence/persistence-manager.mjs";
import { TemplateAnalyzer } from "../../../src/templates/template-analyzer.mjs";
import { DocumentationPathResolver } from "../../../src/documentation-path-resolver.mjs";
import {
  computeAffectedTests,
  type ResolverContext,
  type AffectedTestsResult,
} from "./affected-tests-resolver.mjs";

interface CliArgs {
  diff: string;
  prBody?: string;
  summaryOut?: string;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--diff" && next) {
      args.diff = next;
      i++;
    } else if (a === "--pr-body" && next) {
      args.prBody = next;
      i++;
    } else if (a === "--summary-out" && next) {
      args.summaryOut = next;
      i++;
    } else if (a === "--out" && next) {
      args.out = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printUsage(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage(2);
    }
  }
  if (!args.diff) {
    console.error("Missing required --diff <file>");
    printUsage(2);
  }
  return args as CliArgs;
}

function printUsage(exitCode: number): never {
  console.error(
    "Usage: tsx compute-affected-tests.mts --diff <file> [--pr-body <file>] [--summary-out <file>] [--out <json-file>]",
  );
  console.error(
    "  --diff <file>          File with changed paths (one per line). '-' or /dev/stdin for stdin.",
  );
  console.error(
    "  --pr-body <file>       Optional PR body for 'Livetest:' directive parsing.",
  );
  console.error(
    "  --summary-out <file>   Optional Markdown fragment for $GITHUB_STEP_SUMMARY.",
  );
  console.error(
    "  --out <file>           Write JSON result here. If omitted, JSON is printed to stdout —",
  );
  console.error(
    "                          callers should set LOG_LEVEL=error to keep output clean.",
  );
  process.exit(exitCode);
}

function readFileOrStdin(p: string): string {
  if (p === "-" || p === "/dev/stdin") {
    return fs.readFileSync(0, "utf-8");
  }
  if (!fs.existsSync(p)) {
    throw new Error(`File not found: ${p}`);
  }
  return fs.readFileSync(p, "utf-8");
}

function readChangedFiles(p: string): string[] {
  const text = readFileOrStdin(p);
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findProjectRoot(): string {
  // backend/tests/livetests/src/compute-affected-tests.mts → up 4 levels
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..");
}

function initializePersistenceReadOnly(): PersistenceManager {
  const projectRoot = findProjectRoot();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compute-affected-"));
  const localPath = path.join(projectRoot, "local");
  if (!fs.existsSync(localPath)) {
    fs.mkdirSync(localPath, { recursive: true });
  }
  return PersistenceManager.initialize(
    localPath,
    path.join(tmpRoot, "storagecontext.json"),
    path.join(tmpRoot, "secret.bin"),
    true,
    path.join(projectRoot, "json"),
    path.join(projectRoot, "schemas"),
  );
}

/**
 * Builds the resolver context. Async because some reverse-lookups
 * (`findApplicationsUsingTemplate/Script`) load full applications via
 * TemplateProcessor. We precompute only the lookups actually needed for
 * the given diff to avoid scanning every template at startup.
 */
async function buildResolverContext(
  pm: PersistenceManager,
  changedFiles: string[],
): Promise<ResolverContext> {
  const pathes = pm.getPathes();
  const analyzer = new TemplateAnalyzer(
    new DocumentationPathResolver(pathes.jsonPath),
    pathes,
  );

  // Inheritance index: parentApp → [parentApp + all transitive descendants].
  const apps = pm.getApplicationService().listApplicationsForFrontend();
  const directChildren = new Map<string, string[]>();
  for (const app of apps) {
    const parent = app.extends;
    if (!parent) continue;
    if (!directChildren.has(parent)) directChildren.set(parent, []);
    directChildren.get(parent)!.push(app.id);
  }
  const inheritanceCache = new Map<string, string[]>();
  function descendants(parentId: string): string[] {
    const cached = inheritanceCache.get(parentId);
    if (cached) return cached;
    const out = new Set<string>([parentId]);
    const queue = [parentId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of directChildren.get(cur) ?? []) {
        if (!out.has(child)) {
          out.add(child);
          queue.push(child);
        }
      }
    }
    const result = [...out].sort();
    inheritanceCache.set(parentId, result);
    return result;
  }

  // Scenario index: addonId → [scenarioId].
  const scenarios = pm.getTestScenarios();
  const scenariosByAddon = new Map<string, string[]>();
  for (const sc of scenarios) {
    if (!sc.selectedAddons) continue;
    for (const addonId of sc.selectedAddons) {
      if (!scenariosByAddon.has(addonId)) scenariosByAddon.set(addonId, []);
      scenariosByAddon.get(addonId)!.push(sc.id);
    }
  }
  for (const list of scenariosByAddon.values()) list.sort();

  // Precompute the async lookups for the templates/scripts in the diff.
  const sharedTemplateNames = new Set<string>();
  const sharedScriptNames = new Set<string>();
  for (const f of changedFiles) {
    const norm = f.replace(/\\/g, "/");
    let m = norm.match(/^json\/shared\/templates\/(.+\.json)$/);
    if (m) {
      const base = m[1]!.split("/").pop()!.replace(/\.json$/, "");
      sharedTemplateNames.add(base);
      continue;
    }
    m = norm.match(/^json\/shared\/scripts\/(.+)$/);
    if (m && !m[1]!.endsWith(".md")) {
      const base = m[1]!.split("/").pop()!;
      sharedScriptNames.add(base);
    }
  }

  const appsTplCache = new Map<string, string[]>();
  for (const name of sharedTemplateNames) {
    appsTplCache.set(
      name,
      await analyzer.findApplicationsUsingTemplate(name, { includeSkipped: true }),
    );
  }
  const appsScriptCache = new Map<string, string[]>();
  for (const name of sharedScriptNames) {
    appsScriptCache.set(name, await analyzer.findApplicationsUsingScript(name));
  }

  // Sync analyzer methods are wrapped in memo caches.
  const addonsTplCache = new Map<string, string[]>();
  const addonsScriptCache = new Map<string, string[]>();

  return {
    appsUsingTemplate: (name) => appsTplCache.get(name) ?? [],
    appsUsingScript: (name) => appsScriptCache.get(name) ?? [],
    appsInheritingFrom: descendants,
    addonsUsingTemplate: (name) => {
      let cached = addonsTplCache.get(name);
      if (!cached) {
        cached = analyzer.findAddonsUsingTemplate(name);
        addonsTplCache.set(name, cached);
      }
      return cached;
    },
    addonsUsingScript: (name) => {
      let cached = addonsScriptCache.get(name);
      if (!cached) {
        cached = analyzer.findAddonsUsingScript(name);
        addonsScriptCache.set(name, cached);
      }
      return cached;
    },
    scenariosUsingAddon: (id) => scenariosByAddon.get(id) ?? [],
  };
}

function renderSummaryMarkdown(result: AffectedTestsResult): string {
  const lines: string[] = [];
  lines.push("## Affected-Tests Compute (Shadow-Mode)");
  lines.push("");
  // When no scenarios are derivable from the diff, suggest the ci-pr preset
  // as the fallback. Preset is defined in e2e/test-sets.json — keeps the PR
  // run within a minimum-coverage budget rather than degenerating to --all.
  const suggestedFilter = result.filter || "--set ci-pr (suggested fallback)";
  lines.push(`**Filter would be:** \`${suggestedFilter}\`  `);
  lines.push(`**Skip would be:** ${result.skip ? "true" : "false"}  `);
  lines.push(
    `**PR-Directive used:** ${result.directiveUsed ? `yes (\`${result.directiveValue ?? ""}\`)` : "no"}`,
  );
  lines.push("");
  lines.push("### Per-File Classification");
  lines.push("");
  lines.push("| File | Classification | Apps / Scenarios | Reason |");
  lines.push("|---|---|---|---|");
  if (result.perFile.length === 0) {
    lines.push("| _(no files)_ | — | — | — |");
  } else {
    for (const { file, classification } of result.perFile) {
      const escFile = escapeMd(file);
      let targets = "—";
      let reason = escapeMd(classification.reason);
      if (classification.kind === "select") {
        const parts: string[] = [];
        if (classification.apps.length > 0) parts.push(`apps: ${classification.apps.join(", ")}`);
        if (classification.scenarios.length > 0)
          parts.push(`scenarios: ${classification.scenarios.join(", ")}`);
        targets = escapeMd(parts.join(" • ")) || "—";
      }
      lines.push(`| ${escFile} | ${classification.kind} | ${targets} | ${reason} |`);
    }
  }
  lines.push("");
  lines.push("### Resulting Test Set");
  lines.push("");
  lines.push("| Application | Scenario | Reason |");
  lines.push("|---|---|---|");
  if (result.apps.length === 0 && result.scenarios.length === 0) {
    lines.push("| _(none)_ | — | — |");
  } else {
    for (const a of result.apps) {
      lines.push(`| ${escapeMd(a)} | _(whole app)_ | app selected |`);
    }
    for (const s of result.scenarios) {
      const [appName, variant] = s.split("/");
      lines.push(`| ${escapeMd(appName ?? s)} | ${escapeMd(variant ?? "")} | scenario selected |`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("### Warnings");
    lines.push("");
    for (const w of result.warnings) lines.push(`- ${escapeMd(w)}`);
  }
  if (result.reasons.length > 0) {
    lines.push("");
    lines.push("### Notes");
    lines.push("");
    for (const r of result.reasons) lines.push(`- ${escapeMd(r)}`);
  }
  return lines.join("\n") + "\n";
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const changedFiles = readChangedFiles(args.diff);
  const prBody = args.prBody ? readFileOrStdin(args.prBody) : null;

  const pm = initializePersistenceReadOnly();
  try {
    const ctx = await buildResolverContext(pm, changedFiles);
    const result = computeAffectedTests({ changedFiles, prBody, context: ctx });

    if (args.summaryOut) {
      fs.writeFileSync(args.summaryOut, renderSummaryMarkdown(result), "utf-8");
    }

    const json = JSON.stringify(result) + "\n";
    if (args.out) {
      fs.writeFileSync(args.out, json, "utf-8");
    } else {
      process.stdout.write(json);
    }
  } finally {
    pm.close();
  }
}

main().catch((err) => {
  console.error(`compute-affected-tests failed: ${err.message || err}`);
  process.exit(1);
});
