/**
 * Scenario planning and selection for the live integration test runner.
 *
 * Pure functions for selecting test scenarios, resolving dependencies,
 * building CLI parameters, and assigning VM IDs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  VM_ID_START,
  type ResolvedScenario,
  type PlannedScenario,
  type ParamEntry,
} from "./livetest-types.mjs";

/** Result of building params from a scenario params file */
export interface BuildParamsResult {
  params: { name: string; value: string }[];
  selectedAddons?: string[];
  stackId?: string;
}

/**
 * Collect selected scenarios and all their transitive dependencies.
 * Returns topologically sorted (dependencies first).
 * Detects circular dependencies.
 */
export function collectWithDeps(
  selected: string[],
  all: Map<string, ResolvedScenario>,
): ResolvedScenario[] {
  const visited = new Set<string>();
  const visiting = new Set<string>(); // for cycle detection
  const ordered: ResolvedScenario[] = [];

  function visit(id: string, chain: string[]) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular dependency detected: ${[...chain, id].join(" → ")}`);
    }

    visiting.add(id);
    const s = all.get(id);
    if (!s) throw new Error(`Unknown test scenario: ${id}`);

    for (const dep of s.depends_on ?? []) {
      visit(dep, [...chain, id]);
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(s);
  }

  for (const id of selected) {
    visit(id, []);
  }

  return ordered;
}

/**
 * After a dependency fails, partition remaining scenarios into:
 * - unaffected: scenarios that do NOT transitively depend on the failed dep
 * - blocked: scenarios that DO transitively depend on the failed dep
 *
 * This allows running unaffected tests first, maximizing coverage.
 */
export function partitionAfterFailure(
  failedDepId: string,
  remaining: PlannedScenario[],
  all: Map<string, ResolvedScenario>,
): { unaffected: PlannedScenario[]; blocked: PlannedScenario[] } {
  // Build transitive dependency set for each scenario
  function getTransitiveDeps(id: string, visited = new Set<string>()): Set<string> {
    if (visited.has(id)) return visited;
    visited.add(id);
    const scenario = all.get(id);
    if (scenario) {
      for (const dep of scenario.depends_on ?? []) {
        getTransitiveDeps(dep, visited);
      }
    }
    return visited;
  }

  const unaffected: PlannedScenario[] = [];
  const blocked: PlannedScenario[] = [];

  for (const step of remaining) {
    const deps = getTransitiveDeps(step.scenario.id);
    if (deps.has(failedDepId)) {
      blocked.push(step);
    } else {
      unaffected.push(step);
    }
  }

  return { unaffected, blocked };
}

/**
 * Select scenarios based on CLI argument.
 * - "app" → all scenarios under app/*
 * - "app/scenario" → exact match
 * - "--all" → everything
 * Returns selected scenario IDs (without deps — call collectWithDeps after).
 */
export function selectScenarios(
  testArg: string,
  all: Map<string, ResolvedScenario>,
): string[] {
  if (testArg === "--all") {
    return [...all.keys()];
  }

  // Exact match: "app/scenario"
  if (testArg.includes("/")) {
    if (!all.has(testArg)) {
      throw new Error(`Unknown test scenario: '${testArg}'`);
    }
    return [testArg];
  }

  // App-level match: "app" → all scenarios under app/*
  const matches = [...all.keys()].filter((id) => id.startsWith(`${testArg}/`));
  if (matches.length === 0) {
    throw new Error(
      `No test scenarios found for '${testArg}'. ` +
      `Expected json/applications/${testArg}/tests/test.json`,
    );
  }
  return matches;
}

/**
 * Build CLI params for a scenario.
 * Merges base params with scenario params from the API response.
 * Also extracts selectedAddons and stackId.
 * Supports set mode and append mode (for multiline vars like envs).
 * Resolves file: references using upload data from the API (written to tmpDir).
 */
export function buildParams(
  scenario: ResolvedScenario,
  baseParams: { name: string; value: string }[],
  templateVars: Record<string, string>,
  tmpDir?: string,
): BuildParamsResult {
  const params = baseParams.map((p) => ({ ...p }));

  if (!scenario.params || scenario.params.length === 0) {
    return {
      params,
      ...(scenario.selectedAddons ? { selectedAddons: scenario.selectedAddons } : {}),
      ...(scenario.stackId ? { stackId: scenario.stackId } : {}),
    };
  }

  // Write upload files to tmpDir so file: references can be resolved
  const uploadMap = new Map<string, string>();
  if (tmpDir && scenario.uploads) {
    const uploadsDir = path.join(tmpDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    for (const upload of scenario.uploads) {
      const filePath = path.join(uploadsDir, upload.name);
      writeFileSync(filePath, Buffer.from(upload.content, "base64"));
      uploadMap.set(upload.name, filePath);
    }
  }

  // These params are controlled by the test runner (VM allocation) and must not be overridden
  const runnerControlled = new Set(["vm_id", "hostname"]);

  for (const p of scenario.params) {
    // Skip runner-controlled params — they're set via baseParams
    if (runnerControlled.has(p.name) && !p.append) continue;

    // Substitute template variables in values
    let value = String(p.value ?? "");
    for (const [key, val] of Object.entries(templateVars)) {
      value = value.replace(
        new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
        val,
      );
    }
    // Resolve environment variable references: ${VAR_NAME}
    value = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, envName: string) => {
      return process.env[envName] ?? "";
    });

    if (p.append) {
      let appendVal = p.append;
      for (const [key, val] of Object.entries(templateVars)) {
        appendVal = appendVal.replace(
          new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
          val,
        );
      }
      // Append mode: extend multiline variable (e.g. envs)
      const existing = params.find((b) => b.name === p.name);
      const line = `${appendVal}=${value}`;
      if (existing) {
        existing.value = existing.value
          ? `${existing.value}\n${line}`
          : line;
      } else {
        params.push({ name: p.name, value: line });
      }
    } else {
      // Set mode: override or add
      // Resolve file: references using uploads from API
      if (value.startsWith("file:")) {
        const fileName = value.slice(5);
        const localPath = uploadMap.get(fileName);
        if (localPath) {
          value = `file:${localPath}`;
        }
      }
      const existing = params.find((b) => b.name === p.name);
      if (existing) {
        existing.value = value;
      } else {
        params.push({ name: p.name, value });
      }
    }
  }

  return {
    params,
    ...(scenario.selectedAddons ? { selectedAddons: scenario.selectedAddons } : {}),
    ...(scenario.stackId ? { stackId: scenario.stackId } : {}),
  };
}

/**
 * Plan scenarios: assign VM IDs, hostnames, and stack names.
 */
/**
 * Plan VM IDs for scenarios. Uses a global ID map based on ALL known scenarios
 * so that VM IDs are stable regardless of which subset of tests is selected.
 * This prevents ID collisions when running tests sequentially (e.g. zitadel/default
 * then zitadel/ssl — both need their own postgres VM with different IDs).
 */
export function planScenarios(
  scenarios: ResolvedScenario[],
  appStacktypes: Map<string, string | string[]>,
  allScenarios?: Map<string, ResolvedScenario>,
): PlannedScenario[] {
  // Build stable VM ID map from ALL known scenarios (sorted for determinism)
  const globalIdMap = new Map<string, number>();
  if (allScenarios) {
    // Collect all scenario IDs including their transitive dependencies
    const allIds = new Set<string>();
    const addWithDeps = (id: string) => {
      if (allIds.has(id)) return;
      allIds.add(id);
      const s = allScenarios.get(id);
      if (s?.depends_on) {
        for (const dep of s.depends_on) addWithDeps(dep);
      }
    };
    for (const id of allScenarios.keys()) addWithDeps(id);

    // Sort and assign stable IDs
    let nextId = VM_ID_START;
    for (const id of [...allIds].sort()) {
      const s = allScenarios.get(id);
      globalIdMap.set(id, s?.vm_id ?? nextId++);
    }
  }

  let fallbackId = VM_ID_START;
  return scenarios.map((scenario) => {
    const vmId = scenario.vm_id ?? globalIdMap.get(scenario.id) ?? fallbackId++;
    const rawStacktype = appStacktypes.get(scenario.application);
    const stacktypes = rawStacktype ? (Array.isArray(rawStacktype) ? rawStacktype : [rawStacktype]) : [];
    const hasStacktype = stacktypes.length > 0;

    // Stack name = scenario variant (e.g. "default", "ssl")
    const stackName = scenario.id.split("/")[1] ?? "default";

    return {
      vmId,
      hostname: `${scenario.application}-${stackName}`,
      stackName,
      scenario,
      hasStacktype,
      isDependency: false,
      skipExecution: false,
    };
  });
}
