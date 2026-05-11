#!/usr/bin/env tsx
/**
 * CLI wrapper around `coverage-analyzer.mts`. Prints a Markdown coverage matrix
 * (one section per base) or a JSON dump for downstream tooling.
 *
 * Usage:
 *   tsx coverage-report.mts [--format markdown|json] [--gaps-only] [--root <dir>]
 *
 * Defaults:
 *   --format markdown
 *   --root   <repo root> (auto-detected as four levels up from this file)
 *
 * The Markdown output is suitable for `$GITHUB_STEP_SUMMARY` or a PR
 * sticky-comment. Each cell shows the representative scenario id with markers:
 *   ★ critical, ☆ essentials, GAP for missing combinations.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeCoverage,
  groupCellsByBase,
  type CellKey,
  type CellState,
  type CoverageReport,
  type Task,
} from "./coverage-analyzer.mjs";

interface CliArgs {
  format: "markdown" | "json";
  gapsOnly: boolean;
  rootDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    format: "markdown",
    gapsOnly: false,
    rootDir: defaultRootDir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--format" && next) {
      if (next !== "markdown" && next !== "json") {
        console.error(`Invalid --format: ${next}`);
        process.exit(2);
      }
      args.format = next;
      i++;
    } else if (a === "--gaps-only") {
      args.gapsOnly = true;
    } else if (a === "--root" && next) {
      args.rootDir = path.resolve(next);
      i++;
    } else if (a === "--help" || a === "-h") {
      printUsage(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage(2);
    }
  }
  return args;
}

function printUsage(exitCode: number): never {
  console.error("Usage: tsx coverage-report.mts [--format markdown|json] [--gaps-only] [--root <dir>]");
  process.exit(exitCode);
}

function defaultRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}

// ── Rendering ──

const TASK_ORDER: Task[] = ["installation", "upgrade", "reconfigure"];

function renderMarkdown(report: CoverageReport, gapsOnly: boolean): string {
  const lines: string[] = [];
  lines.push("# Live-Test Coverage Matrix");
  lines.push("");

  if (gapsOnly) {
    renderGapsOnly(report, lines);
    return lines.join("\n");
  }

  const allCells: CellKey[] = [
    ...report.idealCells,
    ...report.orphans.map((s) => orphanCell(s, report)),
  ];
  const grouped = groupCellsByBase(allCells);
  const coveredByKey = new Map<string, CellState>();
  for (const c of report.covered) coveredByKey.set(cellKey(c.cell), c);
  const gapKeys = new Set(report.gaps.map(cellKey));

  for (const [base, addonMap] of [...grouped.entries()].sort()) {
    lines.push(`## base: ${base}`);
    lines.push("");
    const tasks: Task[] = TASK_ORDER.filter((t) => {
      for (const [, taskMap] of addonMap) if (taskMap.has(t)) return true;
      return false;
    });
    lines.push(`| Addon-Kombi | ${tasks.join(" | ")} |`);
    lines.push(`|${"---|".repeat(tasks.length + 1)}`);

    const addonCombos = [...addonMap.keys()].sort(addonComboCompare);
    for (const combo of addonCombos) {
      const row = [combo];
      for (const task of tasks) {
        const key = `${base}|${combo}|${task}`;
        const cellHasTask = addonMap.get(combo)?.has(task) ?? false;
        if (!cellHasTask) {
          row.push("—");
          continue;
        }
        const covered = coveredByKey.get(key);
        if (covered) {
          row.push(formatCell(covered, report));
        } else if (gapKeys.has(key)) {
          row.push(formatGap({ base, addonCombo: combo, task }));
        } else {
          row.push("—");
        }
      }
      lines.push(`| ${row.join(" | ")} |`);
    }
    lines.push("");
  }

  renderSummary(report, lines);
  return lines.join("\n");
}

function renderGapsOnly(report: CoverageReport, lines: string[]): void {
  if (report.gaps.length === 0) {
    lines.push("_No gaps — every supported (base, addon, task) cell has a scenario._");
    return;
  }
  lines.push(`## Gaps (${report.gaps.length})`);
  lines.push("");
  lines.push("| base | addon-combo | task | priority |");
  lines.push("|---|---|---|---|");
  for (const gap of report.gaps) {
    const priority = gapPriority(gap);
    lines.push(`| ${gap.base} | ${gap.addonCombo} | ${gap.task} | ${priority} |`);
  }
  lines.push("");
}

function renderSummary(report: CoverageReport, lines: string[]): void {
  const criticalGaps = report.gaps.filter((g) => gapPriority(g) === "critical").length;
  const essentialsGaps = report.gaps.length - criticalGaps;

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Scenarios:  ${report.scenarios.length}`);
  lines.push(`- Ideal cells: ${report.idealCells.length}`);
  lines.push(`- Covered cells: ${report.covered.length}`);
  lines.push(`- Critical gaps: ${criticalGaps}`);
  lines.push(`- Essentials gaps: ${essentialsGaps}`);
  lines.push(`- Orphan scenarios: ${report.orphans.length}`);
  lines.push("");
  lines.push("Legend: ★ critical, ☆ essentials, GAP missing, — combination not supported by any app.");
}

function formatCell(state: CellState, report: CoverageReport): string {
  const rep = state.representative;
  if (!rep) return "—";
  const tags = report.computedTags.get(rep.id) ?? [];
  const marker = tags.includes("coverage:critical")
    ? " ★"
    : tags.includes("coverage:essentials")
      ? " ☆"
      : "";
  const extra = state.scenarios.length > 1 ? ` (+${state.scenarios.length - 1})` : "";
  return `\`${rep.id}\`${marker}${extra}`;
}

function formatGap(cell: CellKey): string {
  return gapPriority(cell) === "critical" ? "GAP ★" : "GAP";
}

function gapPriority(cell: CellKey): "critical" | "essentials" {
  const parts = cell.addonCombo.split("+");
  if (cell.addonCombo === "none") return "critical";
  if (parts.includes("oidc")) return "critical";
  return "essentials";
}

function orphanCell(s: import("./coverage-analyzer.mjs").ScenarioRecord, report: CoverageReport): CellKey {
  const app = report.apps.find((a) => a.id === s.application);
  return {
    base: app?.extends ?? "none",
    addonCombo: normalizeForOrphan(s.selectedAddons),
    task: s.task,
  };
}

function normalizeForOrphan(addons: string[]): string {
  if (addons.length === 0) return "none";
  const short = addons.map((a) => a.replace(/^addon-/, "")).sort();
  return short.join("+");
}

function cellKey(c: CellKey): string {
  return `${c.base}|${c.addonCombo}|${c.task}`;
}

function addonComboCompare(a: string, b: string): number {
  if (a === "none") return -1;
  if (b === "none") return 1;
  return a.localeCompare(b);
}

// ── JSON output ──

function renderJson(report: CoverageReport): string {
  return JSON.stringify({
    apps: report.apps.map((a) => ({ id: a.id, extends: a.extends, supported_addons: a.effectiveSupportedAddons })),
    scenarios: report.scenarios.map((s) => ({
      id: s.id,
      task: s.task,
      addons: s.selectedAddons,
      tags: s.tags,
      computedTags: report.computedTags.get(s.id) ?? [],
      untestable: s.untestable,
    })),
    covered: report.covered.map((c) => ({
      base: c.cell.base,
      addonCombo: c.cell.addonCombo,
      task: c.cell.task,
      representative: c.representative?.id ?? null,
      scenarios: c.scenarios.map((s) => s.id),
    })),
    gaps: report.gaps,
    orphans: report.orphans.map((s) => s.id),
  }, null, 2);
}

// ── Main ──

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(args.rootDir, "json", "applications"))) {
    console.error(`No json/applications under ${args.rootDir}`);
    process.exit(1);
  }
  const report = analyzeCoverage(args.rootDir);
  const output = args.format === "json" ? renderJson(report) : renderMarkdown(report, args.gapsOnly);
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { renderMarkdown, renderJson, parseArgs };
