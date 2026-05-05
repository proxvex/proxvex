#!/usr/bin/env node
/**
 * Parameter inventory generator.
 *
 * Walks `json/` for every template/application/addon `.json` file, collects each
 * `parameters[]` entry, and writes:
 *   - parameter-inventory.json: { id -> { occurrences: [...] } }
 *   - parameter-conflicts.md:   ID-Konflikte bei name/description (Markdown-Report)
 *
 * Output goes next to this script.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const JSON_ROOT = join(REPO_ROOT, "json");
const EXAMPLES_ROOT = join(REPO_ROOT, "examples");
const WALK_ROOTS = [JSON_ROOT, EXAMPLES_ROOT];
const STACKTYPES_DIR = join(JSON_ROOT, "stacktypes");

const INVENTORY_FIELDS = [
  "name",
  "description",
  "type",
  "default",
  "required",
  "advanced",
  "internal",
  "multiline",
  "enumValuesTemplate",
  "enumValues",
  "secure",
  "upload",
  "certtype",
  "validatePattern",
  "if",
];

// Skip backup/renamed app directories (validateAllJson skips them too) and
// the static-analysis output dir.
// applications-backup is excluded (truly archival).
// node-red.bck IS loaded by validateAllJson, so we must include it.
const SKIP_DIRS = new Set(["applications-backup"]);

// Files excluded from the inventory. (104 has been deleted; test/refresh
// templates now go through inventory + classification so their parameters
// are part of the canonical registry.)
const SKIP_FILES = new Set([]);

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

async function loadParameterDefs(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const params = parsed?.parameters;
  if (!Array.isArray(params)) return [];
  return params.filter((p) => p && typeof p === "object" && typeof p.id === "string");
}

function pickFields(param) {
  const out = {};
  for (const f of INVENTORY_FIELDS) {
    if (param[f] !== undefined) out[f] = param[f];
  }
  return out;
}

async function loadStackNames() {
  const names = new Set();
  const sourceByName = new Map(); // for diagnostics
  let entries;
  try {
    entries = await readdir(STACKTYPES_DIR, { withFileTypes: true });
  } catch {
    return { names, sourceByName };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = join(STACKTYPES_DIR, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    const collect = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const v of arr) {
        if (v && typeof v.name === "string") {
          names.add(v.name);
          if (!sourceByName.has(v.name)) sourceByName.set(v.name, entry.name);
        }
      }
    };
    collect(parsed.variables);
    collect(parsed.provides);
  }
  return { names, sourceByName };
}

async function main() {
  const { names: stackNames, sourceByName: stackSource } = await loadStackNames();

  const inventory = new Map(); // id -> { occurrences: [{ file, ...fields }] }
  const excluded = new Map(); // id -> { stack, occurrences }

  for (const root of WALK_ROOTS) {
    let exists = true;
    try {
      await readdir(root);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for await (const file of walkJson(root)) {
      const params = await loadParameterDefs(file);
      if (params.length === 0) continue;
      const rel = relative(REPO_ROOT, file);
      for (const p of params) {
        if (stackNames.has(p.id)) {
          if (!excluded.has(p.id)) {
            excluded.set(p.id, { stack: stackSource.get(p.id), occurrences: [] });
          }
          excluded.get(p.id).occurrences.push(rel);
          continue;
        }
        if (!inventory.has(p.id)) inventory.set(p.id, { occurrences: [] });
        inventory.get(p.id).occurrences.push({ file: rel, ...pickFields(p) });
      }
    }
  }

  const ids = [...inventory.keys()].sort();
  const inventoryObj = {};
  for (const id of ids) {
    const occ = inventory.get(id).occurrences;

    // Hoist any field where every occurrence agrees — strip it from occurrences.
    const hoisted = {};
    for (const f of INVENTORY_FIELDS) {
      const values = occ.map((o) => (f in o ? o[f] : undefined));
      const allDefined = values.every((v) => v !== undefined);
      const allUndefined = values.every((v) => v === undefined);
      if (allUndefined) continue;
      if (!allDefined) continue; // some have, some don't → keep per-occurrence
      const json0 = JSON.stringify(values[0]);
      if (values.every((v) => JSON.stringify(v) === json0)) {
        hoisted[f] = values[0];
        for (const o of occ) delete o[f];
      }
    }

    // Stable key order: hoisted scalar fields first, then occurrences last.
    const slim = { ...hoisted, occurrences: occ.map((o) => ({ ...o })) };
    inventoryObj[id] = slim;
  }

  const inventoryPath = join(SCRIPT_DIR, "parameter-inventory.json");
  await writeFile(inventoryPath, JSON.stringify(inventoryObj, null, 2) + "\n");

  // Build conflict report: IDs where name or description differs across occurrences.
  const conflicts = [];
  for (const id of ids) {
    const occ = inventory.get(id).occurrences;
    if (occ.length < 2) continue;
    const names = new Set(occ.map((o) => o.name ?? null));
    const descs = new Set(occ.map((o) => o.description ?? null));
    if (names.size > 1 || descs.size > 1) {
      conflicts.push({ id, occurrences: occ, nameVariants: names.size, descVariants: descs.size });
    }
  }

  // Render markdown report.
  const lines = [];
  lines.push("# Parameter conflicts");
  lines.push("");
  lines.push(`Generated by \`scripts/migration/01-list-parameters.mjs\`.`);
  lines.push("");
  lines.push(`- Templates scanned: see inventory.`);
  lines.push(`- Total unique parameter IDs: **${ids.length}**`);
  lines.push(`- IDs with diverging name/description: **${conflicts.length}**`);
  lines.push("");

  for (const c of conflicts) {
    lines.push(`## \`${c.id}\``);
    lines.push("");
    lines.push(`Variants — name: ${c.nameVariants}, description: ${c.descVariants}.`);
    lines.push("");
    lines.push("| File | Name | Description |");
    lines.push("|------|------|-------------|");
    for (const o of c.occurrences) {
      const name = (o.name ?? "").replace(/\|/g, "\\|");
      const desc = (o.description ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| \`${o.file}\` | ${name} | ${desc} |`);
    }
    lines.push("");
  }

  const conflictsPath = join(SCRIPT_DIR, "parameter-conflicts.md");
  await writeFile(conflictsPath, lines.join("\n") + "\n");

  // Console summary.
  const totalOccurrences = ids.reduce((n, id) => n + inventoryObj[id].occurrences.length, 0);
  const flagSet = (id, flag) => {
    const entry = inventoryObj[id];
    if (entry[flag] !== undefined) return entry[flag] === true;
    return entry.occurrences.every((o) => o[flag] === true);
  };
  const internalIds = ids.filter((id) => flagSet(id, "internal")).length;
  const advancedIds = ids.filter((id) => flagSet(id, "advanced")).length;
  const excludedTotal = [...excluded.values()].reduce((n, v) => n + v.occurrences.length, 0);
  console.log(`Stack names known:           ${stackNames.size}`);
  console.log(`Excluded stack params (IDs): ${excluded.size} (occurrences: ${excludedTotal})`);
  console.log(`Unique parameter IDs:        ${ids.length}`);
  console.log(`Total occurrences:           ${totalOccurrences}`);
  console.log(`IDs marked internal (all):   ${internalIds}`);
  console.log(`IDs marked advanced (all):   ${advancedIds}`);
  console.log(`IDs with name/desc conflict: ${conflicts.length}`);
  console.log("");
  console.log(`Wrote ${relative(REPO_ROOT, inventoryPath)}`);
  console.log(`Wrote ${relative(REPO_ROOT, conflictsPath)}`);

  if (excluded.size > 0) {
    console.log("");
    console.log("Excluded stack parameters:");
    for (const [id, info] of [...excluded.entries()].sort()) {
      console.log(`  ${id} (${info.stack}, ${info.occurrences.length}x)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
