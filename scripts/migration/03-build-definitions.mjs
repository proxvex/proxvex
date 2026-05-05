#!/usr/bin/env node
/**
 * Builds json/shared/parameter-definitions.json from inventory + classification.
 *
 * Each entry in the resulting file is the canonical definition for a parameter.
 * Templates reference parameters by id; this file holds the rest.
 *
 * Field selection per id:
 *   id                  — from inventory key
 *   name                — hoisted; else the most-used name across occurrences
 *   description         — hoisted; else the longest description (most informative)
 *   type                — hoisted; else "string" fallback (and warn)
 *   default             — hoisted; else first non-empty default if any
 *   required            — hoisted; majority across occurrences
 *   multiline           — hoisted; otherwise undefined
 *   enumValuesTemplate  — hoisted; else first occurrence
 *   enumValues          — hoisted; else first occurrence
 *   upload, secure, certtype, validatePattern, if  — hoisted; else first occurrence
 *   internal / advanced — from classification.recommended ('internal' | 'advanced'
 *                         set the corresponding flag; 'visible' sets neither)
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const INVENTORY = join(SCRIPT_DIR, "parameter-inventory.json");
const CLASSIFICATION = join(SCRIPT_DIR, "parameter-classification.json");
const STACKTYPES_DIR = join(REPO_ROOT, "json", "stacktypes");
const JSON_ROOT = join(REPO_ROOT, "json");
const EXAMPLES_ROOT = join(REPO_ROOT, "examples");
const WALK_ROOTS = [JSON_ROOT, EXAMPLES_ROOT];
const OUT_FILE = join(REPO_ROOT, "json", "shared", "parameter-definitions.json");
const GROUPS_OVERRIDES_PATH = join(SCRIPT_DIR, "parameter-groups-overrides.json");

// Keep in sync with 01-list-parameters.mjs.
const SKIP_DIRS = new Set(["applications-backup"]);
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

async function loadStackVarsByName() {
  const map = new Map(); // name -> { stack, source: 'variables' | 'provides' }
  let entries;
  try {
    entries = await readdir(STACKTYPES_DIR, { withFileTypes: true });
  } catch {
    return map;
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
    const stack = entry.name.replace(/\.json$/, "");
    const collect = (arr, kind) => {
      if (!Array.isArray(arr)) return;
      for (const v of arr) {
        if (v && typeof v.name === "string" && !map.has(v.name)) {
          map.set(v.name, { stack, kind, def: v });
        }
      }
    };
    collect(parsed.variables, "variables");
    collect(parsed.provides, "provides");
  }
  return map;
}

/** Collect parameter definitions for stack-var IDs from any template. */
async function collectStackVarParamDefs(stackVarIds) {
  // id -> { occurrences: [{name, description, type, secure, ...}] }
  const found = new Map();
  for (const root of WALK_ROOTS) {
    let exists = true;
    try {
      await readdir(root);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for await (const file of walkJson(root)) {
      let parsed;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch {
        continue;
      }
      const params = parsed?.parameters;
      if (!Array.isArray(params)) continue;
      for (const p of params) {
        if (!p || typeof p.id !== "string") continue;
        if (!stackVarIds.has(p.id)) continue;
        if (!found.has(p.id)) found.set(p.id, []);
        found.get(p.id).push(p);
      }
    }
  }
  return found;
}

/**
 * Heuristic group assignment by parameter ID. Returns one of the allowed groups.
 * Manual overrides in parameter-groups-overrides.json take precedence.
 *
 * Allowed: Application | Authentication | Network | Storage | Diagnostics | Other
 */
function suggestGroup(id) {
  const m = (re) => re.test(id);

  // Authentication
  if (
    m(/^acme(_|$)/) ||
    m(/^oidc(_|$)/) ||
    m(/^ssl(_|$)/) ||
    m(/^smb(_|$)/) ||
    m(/^smtp(_|$)/) ||
    m(/_password$/i) ||
    m(/_token$/i) ||
    m(/_secret(s)?$/i) ||
    m(/^cert(_|s$)/i) ||
    m(/^cf_/i)
  ) return "Authentication";

  // Network
  if (
    id === "hostname" ||
    id === "bridge" ||
    id === "searchdomain" ||
    id === "domain_suffix" ||
    m(/^static_/) ||
    m(/^nameserver/) ||
    m(/_gw[0-9]*$/) ||
    m(/^gateway/) ||
    m(/^ip[46]_(prefix|cidr)$/) ||
    m(/^http(s)?_port$/) ||
    m(/_port$/i)
  ) return "Network";

  // Storage
  if (
    id === "memory" ||
    id === "compose_file" ||
    id === "env_file" ||
    m(/^volume/i) ||
    m(/^disk_/) ||
    m(/^rootfs/) ||
    m(/_storage$/) ||
    m(/^mapped_/) ||
    m(/^upload_.*_(content|destination)$/) ||
    m(/^addon_(content|path)$/) ||
    m(/^shared_volpath$/) ||
    id === "storage_selection"
  ) return "Storage";

  // Diagnostics — backend/internal observation; usually never visible.
  if (
    m(/^ve_(debug|context)/) ||
    m(/^deployer_/) ||
    m(/^startup_/) ||
    id === "ve_debug_commands"
  ) return "Diagnostics";

  // Application — image / package / app metadata / device mapping
  if (
    m(/^oci_image/) ||
    id === "envs" ||
    id === "app_name" ||
    id === "application_id" ||
    m(/^package/) ||
    id === "database_name" ||
    id === "flow_source" ||
    id === "audio_card" ||
    id === "usb_bus_device" ||
    id === "host_device_path" ||
    m(/_versions$/) ||
    id === "REPO_URL" ||
    id === "DOCKER_HUB_USERNAME"
  ) return "Application";

  return "Other";
}

const ORDER_FIELDS = [
  "id",
  "name",
  "description",
  "type",
  "default",
  "required",
  "multiline",
  "upload",
  "secure",
  "certtype",
  "validatePattern",
  "enumValuesTemplate",
  "enumValues",
  "if",
  "group",
  "order",
  "advanced",
  "internal",
];

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function pickHoistedOrFirst(entry, field) {
  if (entry[field] !== undefined) return entry[field];
  for (const o of entry.occurrences) {
    if (o[field] !== undefined) return o[field];
  }
  return undefined;
}

function pickMajorityName(entry) {
  if (typeof entry.name === "string") return entry.name;
  const counts = new Map();
  for (const o of entry.occurrences) {
    if (typeof o.name !== "string") continue;
    counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best || undefined;
}

function pickLongestDescription(entry) {
  if (typeof entry.description === "string") return entry.description;
  let best = "";
  for (const o of entry.occurrences) {
    if (typeof o.description === "string" && o.description.length > best.length) {
      best = o.description;
    }
  }
  return best || undefined;
}

function pickMajorityRequired(entry) {
  if (typeof entry.required === "boolean") return entry.required;
  let trues = 0;
  let falses = 0;
  for (const o of entry.occurrences) {
    if (o.required === true) trues++;
    else if (o.required === false) falses++;
  }
  if (trues === 0 && falses === 0) return undefined;
  return trues > falses;
}

function pickMajorityType(entry) {
  if (typeof entry.type === "string") return entry.type;
  const counts = new Map();
  for (const o of entry.occurrences) {
    if (typeof o.type === "string") {
      counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
    }
  }
  let best;
  let bestCount = 0;
  for (const [t, count] of counts) {
    if (count > bestCount) {
      best = t;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Returns a registry-wide default ONLY if all occurrences agree.
 *
 * Picking the first non-empty default is dangerous — e.g. `hostname` has
 * `default: "gitea"` from one app and `"node-red"` from another. Putting
 * one of those into the global registry breaks the framework-loader
 * fallback (which expects `default === undefined` to substitute the
 * application id). When occurrences disagree, leave the field unset and
 * let app-level `properties[]` provide app-specific defaults.
 */
function pickConsensusDefault(entry) {
  if (entry.default !== undefined) return entry.default;
  const values = entry.occurrences
    .map((o) => o.default)
    .filter((v) => v !== undefined);
  if (values.length === 0) return undefined;
  const json0 = JSON.stringify(values[0]);
  for (const v of values) {
    if (JSON.stringify(v) !== json0) return undefined;
  }
  return values[0];
}

async function loadGroupOverrides() {
  try {
    const raw = await readJson(GROUPS_OVERRIDES_PATH);
    const map = new Map();
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_")) continue;
      if (v && typeof v === "object" && typeof v.group === "string") {
        map.set(k, v.group);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function main() {
  const inventory = await readJson(INVENTORY);
  const classification = await readJson(CLASSIFICATION);
  const groupOverrides = await loadGroupOverrides();

  const ids = Object.keys(inventory).sort();
  const definitions = [];
  const warnings = [];

  for (const id of ids) {
    const entry = inventory[id];
    const cls = classification[id];

    const def = { id };
    const name = pickMajorityName(entry);
    if (name) def.name = name;

    const description = pickLongestDescription(entry);
    if (description) def.description = description;

    const type = pickMajorityType(entry);
    def.type = type ?? "string";
    if (!type) warnings.push(`${id}: no type found, defaulting to "string"`);

    const def_ = pickConsensusDefault(entry);
    if (def_ !== undefined) def.default = def_;

    const required = pickMajorityRequired(entry);
    if (required !== undefined) def.required = required;

    for (const field of [
      "multiline",
      "upload",
      "secure",
      "certtype",
      "validatePattern",
      "enumValuesTemplate",
      "enumValues",
      "if",
    ]) {
      const v = pickHoistedOrFirst(entry, field);
      if (v !== undefined) def[field] = v;
    }

    // Apply classification flags. Visible = neither flag.
    if (cls?.recommended === "internal") {
      def.internal = true;
      // Internal params don't carry advanced.
      delete def.advanced;
    } else if (cls?.recommended === "advanced") {
      def.advanced = true;
    }

    // Group assignment: only required for non-internal parameters.
    // Manual override wins over heuristic.
    if (def.internal !== true) {
      def.group = groupOverrides.get(id) ?? suggestGroup(id);
    }

    // Order keys for readability.
    const ordered = {};
    for (const k of ORDER_FIELDS) {
      if (def[k] !== undefined) ordered[k] = def[k];
    }
    // Catch any field not in ORDER_FIELDS (shouldn't happen, but safe).
    for (const k of Object.keys(def)) {
      if (!(k in ordered)) ordered[k] = def[k];
    }

    // Validate basic invariants.
    if (!ordered.name) warnings.push(`${id}: no name`);
    if (!ordered.description) warnings.push(`${id}: no description`);

    definitions.push(ordered);
  }

  // Add stack-var IDs that templates reference but the inventory excluded.
  // Stack vars are conceptually internal: resolved via stack-selector + backend.
  const stackVars = await loadStackVarsByName();
  const stackVarsAlsoInTemplates = await collectStackVarParamDefs(
    new Set(stackVars.keys()),
  );
  let stackVarsAdded = 0;
  for (const [id, occurrences] of stackVarsAlsoInTemplates) {
    if (definitions.some((d) => d.id === id)) continue;
    // Pick best name/description from the template occurrences.
    const names = occurrences.map((p) => p.name).filter((n) => typeof n === "string");
    const descs = occurrences.map((p) => p.description).filter((d) => typeof d === "string");
    const types = occurrences.map((p) => p.type).filter((t) => typeof t === "string");
    const def = {
      id,
      name: names[0] ?? id,
      description:
        descs.sort((a, b) => b.length - a.length)[0] ??
        `Stack-managed value (provided by ${stackVars.get(id)?.stack} stack).`,
      type: types[0] ?? "string",
      internal: true,
    };
    if (occurrences.some((p) => p.secure === true)) def.secure = true;
    if (occurrences.some((p) => p.multiline === true)) def.multiline = true;
    definitions.push(def);
    stackVarsAdded++;
  }
  if (stackVarsAdded > 0) {
    console.log(`Added ${stackVarsAdded} stack-var definitions (internal:true)`);
  }

  // Sort by id for stable diffs.
  definitions.sort((a, b) => a.id.localeCompare(b.id));

  const out = { parameters: definitions };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n");

  console.log(`Wrote ${definitions.length} parameter definitions to`);
  console.log(`  ${OUT_FILE.replace(REPO_ROOT + "/", "")}`);
  console.log("");
  const counts = { internal: 0, advanced: 0, visible: 0 };
  for (const d of definitions) {
    if (d.internal) counts.internal++;
    else if (d.advanced) counts.advanced++;
    else counts.visible++;
  }
  console.log(`Visibility: internal=${counts.internal}, advanced=${counts.advanced}, visible=${counts.visible}`);
  if (warnings.length > 0) {
    console.log("");
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 30)) console.log(`  ${w}`);
    if (warnings.length > 30) console.log(`  ... and ${warnings.length - 30} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
