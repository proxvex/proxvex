#!/usr/bin/env node
/**
 * Parameter classification: proposes `internal` / `advanced` / `visible` per ID.
 *
 * Reads parameter-inventory.json (produced by 01-list-parameters.mjs), walks the
 * same json/ tree to collect command outputs, then applies heuristics to each ID.
 *
 * Heuristics (in priority order):
 *   1. ID is the `outputs:` of some command anywhere   → internal (high)
 *   2. Description matches "Auto-injected" / "backend" → internal (high)
 *   3. Every occurrence already has internal: true     → internal (high)
 *   4. Every occurrence already has advanced: true     → advanced (high)
 *   5. Defined only in a single application.json file  → visible (medium)
 *   6. Has any occurrence with required: true (no default override) → visible (medium)
 *   7. Has a default and not required anywhere         → advanced (medium)
 *   8. Default                                         → visible (low)
 *
 * Outputs:
 *   - parameter-classification.json (machine-readable, full data)
 *   - parameter-classification.md   (human review, grouped by recommendation)
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const JSON_ROOT = join(REPO_ROOT, "json");
const EXAMPLES_ROOT = join(REPO_ROOT, "examples");
const WALK_ROOTS = [JSON_ROOT, EXAMPLES_ROOT];
const SKIP_DIRS = new Set(["applications-backup"]);
// Keep this in sync with 01-list-parameters.mjs.
const SKIP_FILES = new Set([]);
const INVENTORY_PATH = join(SCRIPT_DIR, "parameter-inventory.json");
const OVERRIDES_PATH = join(SCRIPT_DIR, "parameter-classification-overrides.json");

async function* walkJson(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkJson(full);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const rel = relative(REPO_ROOT, full);
      if (SKIP_FILES.has(rel)) continue;
      yield full;
    }
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Collect every (id, source) pair where id appears as a command output. */
async function collectOutputs() {
  const outputs = new Map(); // id -> [{file, command}]
  for (const root of WALK_ROOTS) {
    let exists = true;
    try {
      await readdir(root);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for await (const file of walkJson(root)) {
      const parsed = await readJson(file);
      if (!parsed) continue;
      const rel = relative(REPO_ROOT, file);
      const commands = parsed.commands;
      if (!Array.isArray(commands)) continue;
      for (const cmd of commands) {
        if (!cmd || !Array.isArray(cmd.outputs)) continue;
        for (const out of cmd.outputs) {
          if (typeof out !== "string") continue;
          if (!outputs.has(out)) outputs.set(out, []);
          outputs.get(out).push({ file: rel, command: cmd.name ?? cmd.script ?? "" });
        }
      }
    }
  }
  return outputs;
}

// Tight pattern: only match explicit "auto-injected" or "injected by" markers.
// Plain mentions of "backend" in descriptions are too noisy.
const AUTO_INJECTED_RE = /auto[- ]?injected|injected by/i;

function getField(entry, occ, field) {
  // Either hoisted on entry or per-occurrence on occ.
  if (entry[field] !== undefined) return entry[field];
  return occ[field];
}

function descriptions(entry) {
  const collected = new Set();
  if (typeof entry.description === "string") collected.add(entry.description);
  for (const o of entry.occurrences) {
    if (typeof o.description === "string") collected.add(o.description);
  }
  return [...collected];
}

/**
 * Voting-based classifier.
 *
 * Each occurrence contributes one vote. We also factor in `is_output` and
 * the description hint as additional internal votes. The highest score wins;
 * ties resolve toward `visible` (default to user-input).
 *
 * Effective per-occurrence vote:
 *   - internal: true        → internal
 *   - advanced: true        → advanced
 *   - required: true (no advanced/internal) → visible
 *   - has explicit default + not required   → advanced
 *   - none of the above (just used as input) → ignored (no vote)
 */
function classify(id, entry, outputs) {
  const occ = entry.occurrences;
  const reasoning = [];

  // Existing flag fields can be hoisted to entry. Treat the hoisted values as
  // applying to every occurrence.
  const eff = (o, field) => (entry[field] !== undefined ? entry[field] : o[field]);

  const votes = { internal: 0, advanced: 0, visible: 0 };
  for (const o of occ) {
    if (eff(o, "internal") === true) {
      votes.internal++;
    } else if (eff(o, "advanced") === true) {
      votes.advanced++;
    } else if (eff(o, "required") === true) {
      votes.visible++;
    } else if (eff(o, "default") !== undefined && eff(o, "default") !== "") {
      votes.advanced++;
    }
    // else: occurrence has no opinion (just consumes the value).
  }

  // Bonus internal votes for backend-resolved parameters.
  const isOutput = outputs.has(id);
  // "Auto-assignable" producer signal: an occurrence that is BOTH advanced AND
  // has an explicit default (often empty "") — the maintainer is saying
  // "user can leave this blank, backend fills it in".
  const hasAutoAssignableProducer = occ.some(
    (o) => eff(o, "advanced") === true && eff(o, "default") !== undefined,
  );
  if (isOutput) {
    if (hasAutoAssignableProducer) {
      // Output AND a producer that's flagged as auto-assignable → user really
      // doesn't enter it. Dominant over consumer "required" votes.
      votes.internal += occ.length;
    } else {
      // Output exists, but no auto-assignable producer → may still be user
      // input (e.g. hostname is output in the Clone-CT/reconfigure path but
      // required input everywhere else). Small nudge only.
      votes.internal += 1;
    }
  }
  // Explicit "Auto-injected" annotation always wins.
  let autoInjectedSeen = false;
  for (const d of descriptions(entry)) {
    if (AUTO_INJECTED_RE.test(d)) {
      autoInjectedSeen = true;
      reasoning.push(`auto_injected_hint: "${d.slice(0, 80)}"`);
      break;
    }
  }

  // Single-app-defined → visible bonus.
  if (occ.length === 1) {
    const f = occ[0].file;
    if (
      /^json\/applications\/[^/]+\/application\.json$/.test(f) ||
      /^json\/addons\/[^/]+\.json$/.test(f)
    ) {
      votes.visible += 2;
      reasoning.push(`defined_only_in: ${f}`);
    }
  }

  if (isOutput) {
    const sources = outputs.get(id).map((o) => `${o.file}#${o.command}`).slice(0, 2);
    reasoning.push(`is_output_of: ${sources.join(", ")}`);
  }

  reasoning.push(
    `votes: internal=${votes.internal}, advanced=${votes.advanced}, visible=${votes.visible}`,
  );

  // Auto-injected annotation overrides everything.
  if (autoInjectedSeen) {
    return { recommended: "internal", confidence: "high", reasoning };
  }

  // Pick winner. Tie → visible (user-input default).
  let recommended = "visible";
  let max = votes.visible;
  if (votes.advanced > max) {
    recommended = "advanced";
    max = votes.advanced;
  }
  if (votes.internal > max) {
    recommended = "internal";
    max = votes.internal;
  }

  // Confidence: based on margin between winner and runner-up.
  const sorted = Object.values(votes).sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  let confidence = "high";
  if (sorted[0] === 0) confidence = "low";
  else if (margin === 0) confidence = "low";
  else if (margin === 1) confidence = "medium";

  return { recommended, confidence, reasoning };
}

function summarizeFlags(entry) {
  const occ = entry.occurrences;
  const f = (flag) => {
    if (entry[flag] === true) return occ.length;
    return occ.filter((o) => o[flag] === true).length;
  };
  return {
    occurrences: occ.length,
    internal: f("internal"),
    advanced: f("advanced"),
    required: f("required"),
  };
}

async function main() {
  const inventory = await readJson(INVENTORY_PATH);
  if (!inventory) {
    console.error(`Cannot read ${INVENTORY_PATH}. Run 01-list-parameters.mjs first.`);
    process.exit(1);
  }
  const outputs = await collectOutputs();
  const overridesRaw = (await readJson(OVERRIDES_PATH)) ?? {};
  const overrides = Object.fromEntries(
    Object.entries(overridesRaw).filter(([k]) => !k.startsWith("_")),
  );

  const classification = {};
  const ids = Object.keys(inventory).sort();
  let overrideHits = 0;
  for (const id of ids) {
    const entry = inventory[id];
    const result = classify(id, entry, outputs);
    classification[id] = {
      recommended: result.recommended,
      confidence: result.confidence,
      reasoning: result.reasoning,
      flags: summarizeFlags(entry),
    };
    if (overrides[id]) {
      const ov = overrides[id];
      classification[id].original_recommendation = result.recommended;
      classification[id].recommended = ov.recommended;
      classification[id].confidence = "override";
      classification[id].reasoning = [`override: ${ov.reason}`];
      overrideHits++;
    }
  }

  await writeFile(
    join(SCRIPT_DIR, "parameter-classification.json"),
    JSON.stringify(classification, null, 2) + "\n",
  );

  // Markdown report grouped by recommendation, sorted by occurrence count desc.
  const buckets = { internal: [], advanced: [], visible: [] };
  for (const id of ids) buckets[classification[id].recommended].push(id);
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => classification[b].flags.occurrences - classification[a].flags.occurrences);
  }

  const counts = { internal: buckets.internal.length, advanced: buckets.advanced.length, visible: buckets.visible.length };
  const lowConfidence = ids.filter((id) => classification[id].confidence === "low").length;

  const md = [];
  md.push("# Parameter classification");
  md.push("");
  md.push(`Generated by \`scripts/migration/02-classify-parameters.mjs\`.`);
  md.push("");
  md.push(`- Total IDs:   **${ids.length}**`);
  md.push(`- internal:    **${counts.internal}**`);
  md.push(`- advanced:    **${counts.advanced}**`);
  md.push(`- visible:     **${counts.visible}**`);
  md.push(`- low-confidence calls (review priority): **${lowConfidence}**`);
  md.push("");

  for (const bucket of ["internal", "advanced", "visible"]) {
    md.push(`## ${bucket} (${counts[bucket]})`);
    md.push("");
    md.push("| ID | Conf. | Occ. | Reasoning | Existing flags (int/adv/req) |");
    md.push("|----|-------|------|-----------|-----|");
    for (const id of buckets[bucket]) {
      const c = classification[id];
      const reason = c.reasoning.join("; ").replace(/\|/g, "\\|");
      const f = c.flags;
      md.push(`| \`${id}\` | ${c.confidence} | ${f.occurrences} | ${reason} | ${f.internal}/${f.advanced}/${f.required} |`);
    }
    md.push("");
  }

  await writeFile(join(SCRIPT_DIR, "parameter-classification.md"), md.join("\n") + "\n");

  console.log(`Total IDs:                ${ids.length}`);
  console.log(`Recommended internal:     ${counts.internal}`);
  console.log(`Recommended advanced:     ${counts.advanced}`);
  console.log(`Recommended visible:      ${counts.visible}`);
  console.log(`Low-confidence calls:     ${lowConfidence}`);
  console.log(`Manual overrides applied: ${overrideHits}`);
  console.log("");
  console.log(`Wrote scripts/migration/parameter-classification.json`);
  console.log(`Wrote scripts/migration/parameter-classification.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
