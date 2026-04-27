/**
 * Renders a Markdown table summarising the outcome of a livetest run for
 * `$GITHUB_STEP_SUMMARY`. Pure function — separates presentation from the
 * runner so it stays easy to test.
 */

import type { PlannedScenario, TestResult, StepResult } from "./livetest-types.mjs";

export interface RenderOptions {
  /** Maximum number of stderr/stdout lines to include per failing scenario. Default: 10. */
  maxTailLines?: number;
  /** Maximum length of each tail line before truncation. Default: 200. */
  maxLineLength?: number;
}

export function renderResultsMarkdown(
  results: TestResult[],
  plannedScenarios: PlannedScenario[],
  options: RenderOptions = {},
): string {
  const maxTailLines = options.maxTailLines ?? 10;
  const maxLineLength = options.maxLineLength ?? 200;

  // Index steps by scenario.id (use the first step that matches; the runner
  // adds at most one step per planned scenario in the normal flow).
  const stepByScenario = new Map<string, StepResult>();
  for (const r of results) {
    for (const step of r.steps) {
      if (step.scenarioId && !stepByScenario.has(step.scenarioId)) {
        stepByScenario.set(step.scenarioId, step);
      }
    }
  }
  const allErrors = results.flatMap((r) => r.errors);

  const lines: string[] = [];
  lines.push("## Livetest Results");
  lines.push("");
  lines.push("| Application | Scenario | SSL | OIDC | Task | Result | Last 10 lines (stderr) |");
  lines.push("|---|---|---|---|---|---|---|");

  for (const p of plannedScenarios) {
    const sc = p.scenario;
    const app = sc.application;
    const variant = p.stackName;
    const ssl = sc.selectedAddons?.includes("addon-ssl") ? "✅" : "❌";
    const oidc = sc.selectedAddons?.includes("addon-oidc") ? "✅" : "❌";
    const task = (sc as { task?: string }).task ?? "installation";

    const status = scenarioStatus(sc.id, p.skipExecution, stepByScenario, allErrors);
    const tail = renderTail(stepByScenario.get(sc.id), allErrors, sc.id, status, maxTailLines, maxLineLength);

    lines.push(
      `| ${escapeCell(app)} | ${escapeCell(variant)} | ${ssl} | ${oidc} | ${escapeCell(task)} | ${status.icon} ${status.label} | ${tail} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

interface Status {
  icon: string;
  label: string;
  kind: "pass" | "fail" | "skipped";
}

function scenarioStatus(
  scenarioId: string,
  skipExecution: boolean,
  stepByScenario: Map<string, StepResult>,
  allErrors: string[],
): Status {
  if (skipExecution) {
    return { icon: "⏭", label: "skipped", kind: "skipped" };
  }
  if (!stepByScenario.has(scenarioId)) {
    return { icon: "⏭", label: "not run", kind: "skipped" };
  }
  const failed = allErrors.some((e) => e.includes(scenarioId));
  if (failed) {
    return { icon: "❌", label: "fail", kind: "fail" };
  }
  return { icon: "✅", label: "pass", kind: "pass" };
}

function renderTail(
  step: StepResult | undefined,
  allErrors: string[],
  scenarioId: string,
  status: Status,
  maxLines: number,
  maxLineLen: number,
): string {
  if (status.kind === "skipped") {
    if (allErrors.some((e) => e.includes(scenarioId) && e.includes("blocked"))) {
      return "_(dependency failed)_";
    }
    return "_(skipped)_";
  }
  if (status.kind === "pass") {
    return "_(no stderr)_";
  }
  const text = step?.cliOutput ?? "";
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(-maxLines)
    .map((l) => (l.length > maxLineLen ? l.slice(0, maxLineLen) + "…" : l))
    .map(htmlEscape);
  if (lines.length === 0) {
    return "_(no output captured)_";
  }
  return `<pre>${lines.join("<br>")}</pre>`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|");
}
