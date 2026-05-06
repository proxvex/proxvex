#!/usr/bin/env node
/**
 * Cross-checks templates / addons / applications against
 * json/shared/parameter-definitions.json.
 *
 * Reports:
 *   - templates with non-string entries in parameters[]
 *   - parameter IDs referenced from templates that aren't defined in the registry
 *   - parameter IDs in the registry that aren't referenced anywhere (warning only)
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const JSON_ROOT = join(REPO_ROOT, "json");
const EXAMPLES_ROOT = join(REPO_ROOT, "examples");
const WALK_ROOTS = [JSON_ROOT, EXAMPLES_ROOT];
const DEFINITIONS_PATH = join(JSON_ROOT, "shared", "parameter-definitions.json");
const SKIP_DIRS = new Set(["applications-backup"]);
const SKIP_FILES = new Set([
  "json/shared/parameter-definitions.json",
  "examples/storagecontext.json",
  "examples/refresh-history.json",
  "examples/enum-values-cache.json",
]);

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
  const definitions = JSON.parse(await readFile(DEFINITIONS_PATH, "utf8"));
  const knownIds = new Set(definitions.parameters.map((p) => p.id));

  const referencedIds = new Set();
  const errors = [];
  let scanned = 0;
  let withParams = 0;

  for (const root of WALK_ROOTS) {
    let exists = true;
    try {
      await readdir(root);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for await (const file of walkJson(root)) {
      scanned++;
      const rel = relative(REPO_ROOT, file);
      let parsed;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        errors.push(`${rel}: parse error — ${e.message}`);
        continue;
      }
      if (!Array.isArray(parsed.parameters)) continue;
      if (parsed.parameters.length === 0) continue;
      withParams++;
      for (const entry of parsed.parameters) {
        if (typeof entry !== "string") {
          errors.push(`${rel}: non-string parameter entry ${JSON.stringify(entry)} (migration not complete)`);
          continue;
        }
        referencedIds.add(entry);
        if (!knownIds.has(entry)) {
          errors.push(`${rel}: unknown parameter id "${entry}"`);
        }
      }
    }
  }

  const unreferenced = [];
  for (const id of knownIds) {
    if (!referencedIds.has(id)) unreferenced.push(id);
  }

  console.log(`Files scanned:              ${scanned}`);
  console.log(`Files with parameters[]:    ${withParams}`);
  console.log(`IDs in parameter registry:  ${knownIds.size}`);
  console.log(`IDs referenced:             ${referencedIds.size}`);
  console.log(`IDs unreferenced (warning): ${unreferenced.length}`);
  console.log(`Errors:                     ${errors.length}`);
  if (errors.length > 0) {
    console.log("");
    for (const e of errors.slice(0, 50)) console.log(`  ERROR ${e}`);
    if (errors.length > 50) console.log(`  ... and ${errors.length - 50} more`);
    process.exitCode = 2;
  }
  if (unreferenced.length > 0) {
    console.log("");
    console.log("Unreferenced parameter IDs (defined in registry but not used by any template):");
    for (const id of unreferenced.slice(0, 30)) console.log(`  ${id}`);
    if (unreferenced.length > 30) console.log(`  ... and ${unreferenced.length - 30} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
