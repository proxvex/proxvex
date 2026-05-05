#!/usr/bin/env node
/**
 * Rewrites every template/addon/application file's `parameters[]` from
 * inline objects to a flat array of string IDs.
 *
 * Before:
 *   "parameters": [
 *     { "id": "vm_id", "name": "VM ID", "type": "number", ... },
 *     { "id": "hostname", "name": "Hostname", "type": "string", ... }
 *   ]
 *
 * After:
 *   "parameters": ["vm_id", "hostname"]
 *
 * Validates that every referenced id exists in
 * json/shared/parameter-definitions.json.
 *
 * --dry-run: print changes without writing.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const JSON_ROOT = join(REPO_ROOT, "json");
const EXAMPLES_ROOT = join(REPO_ROOT, "examples");
const WALK_ROOTS = [JSON_ROOT, EXAMPLES_ROOT];
const DEFINITIONS_PATH = join(JSON_ROOT, "shared", "parameter-definitions.json");
const SKIP_DIRS = new Set(["applications-backup"]);
// Skip the central definitions file itself + encrypted/non-template files in
// examples/.
const SKIP_FILES = new Set([
  "json/shared/parameter-definitions.json",
  "examples/storagecontext.json",
  "examples/refresh-history.json",
  "examples/enum-values-cache.json",
]);

const dryRun = process.argv.includes("--dry-run");

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

async function main() {
  const definitionsRaw = await readFile(DEFINITIONS_PATH, "utf8");
  const definitions = JSON.parse(definitionsRaw);
  const knownIds = new Set(definitions.parameters.map((p) => p.id));

  let filesScanned = 0;
  let filesChanged = 0;
  let totalReplaced = 0;
  const unknownIds = new Map(); // id -> [files]
  const skippedFiles = []; // already string[]

  for (const root of WALK_ROOTS) {
    let exists = true;
    try {
      await readdir(root);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for await (const file of walkJson(root)) {
    filesScanned++;
    const rel = relative(REPO_ROOT, file);
    const raw = await readFile(file, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`SKIP (parse error): ${rel} — ${err.message}`);
      continue;
    }

    if (!Array.isArray(parsed.parameters)) continue;
    if (parsed.parameters.length === 0) continue;

    // Already migrated?
    if (parsed.parameters.every((p) => typeof p === "string")) {
      skippedFiles.push(rel);
      continue;
    }

    const newParams = [];
    for (const p of parsed.parameters) {
      if (typeof p === "string") {
        newParams.push(p);
        continue;
      }
      if (!p || typeof p.id !== "string") {
        console.error(`SKIP entry without id in ${rel}`);
        continue;
      }
      if (!knownIds.has(p.id)) {
        if (!unknownIds.has(p.id)) unknownIds.set(p.id, []);
        unknownIds.get(p.id).push(rel);
      }
      newParams.push(p.id);
    }

    parsed.parameters = newParams;
    totalReplaced += newParams.length;
    filesChanged++;

    if (dryRun) {
      console.log(`(dry-run) would rewrite ${rel}: ${newParams.length} param IDs`);
    } else {
      // Detect indentation: try 2 (most common) and preserve trailing newline.
      const out = JSON.stringify(parsed, null, 2);
      const trailingNl = raw.endsWith("\n") ? "\n" : "";
      await writeFile(file, out + trailingNl);
    }
    }
  }

  console.log("");
  console.log(`Files scanned:      ${filesScanned}`);
  console.log(`Files ${dryRun ? "would be " : ""}changed: ${filesChanged}`);
  console.log(`Already migrated:   ${skippedFiles.length}`);
  console.log(`Param IDs rewired:  ${totalReplaced}`);

  if (unknownIds.size > 0) {
    console.log("");
    console.log(`UNKNOWN parameter IDs (not in parameter-definitions.json):`);
    for (const [id, files] of unknownIds) {
      console.log(`  ${id}  (in ${files.length} file${files.length > 1 ? "s" : ""})`);
      for (const f of files.slice(0, 3)) console.log(`    ${f}`);
      if (files.length > 3) console.log(`    … +${files.length - 3} more`);
    }
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
