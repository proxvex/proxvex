# Parameter-Definitions Migration — Summary

## What changed

The codebase moved from **inline parameter definitions** to a **central registry**.

### Before
```json
// any template / addon / application
"parameters": [
  { "id": "hostname", "name": "Hostname", "type": "string", "required": true, "description": "…" },
  { "id": "memory", "name": "Memory", "type": "number", "default": 512, "advanced": true, … }
]
```

### After
```json
// templates now reference by id only
"parameters": ["hostname", "memory"]

// canonical definition lives in json/shared/parameter-definitions.json
```

The registry file holds **all 178 parameter definitions** (name, description, type, default, required, internal/advanced flags, etc.).

## New / modified files

| Path | Purpose |
|---|---|
| `json/shared/parameter-definitions.json` | Canonical registry (178 entries) |
| `schemas/parameter-definitions.schema.json` | JSON Schema for the registry |
| `schemas/template.schema.json` | `parameters[]` now accepts `string \| object` (object form is transitional, only for `applications-backup/`) |
| `schemas/base-deployable.schema.json` | Same `parameters[]` change |
| `backend/src/parameter-definitions.mts` | Registry loader — expands string IDs into full `IParameter` objects |
| `backend/src/persistence/template-persistence-handler.mts` | Calls `registry.expand()` after loading templates |
| `backend/src/persistence/addon-persistence-handler.mts` | Same for addons |
| `backend/src/persistence/application-persistence-handler.mts` | Same for applications |
| `scripts/migration/01-list-parameters.mjs` | Walks `json/` + `examples/`, builds parameter inventory |
| `scripts/migration/02-classify-parameters.mjs` | Heuristic + manual overrides → internal/advanced/visible recommendation |
| `scripts/migration/03-build-definitions.mjs` | Inventory + classification → `parameter-definitions.json` |
| `scripts/migration/04-rewrite-templates.mjs` | Rewrites all template/addon/app `parameters[]` from objects to string IDs |
| `scripts/migration/05-validate-templates.mjs` | Cross-checks template references against registry |
| `scripts/migration/parameter-classification-overrides.json` | 30 manual classification overrides (uid/gid → internal, etc.) |

## Structural cleanups (already done)

- Deleted `json/shared/templates/pre_start/104-conf-lxc-static-ip-prefix.json` (old static-IP-prefix feature, vm_id is no longer stable as an IP suffix).
- Removed the `Compute Static IPs` command from `100-conf-create-configure-lxc.json`.
- Deleted `json/shared/scripts/pre_start/conf-lxc-static-ip-prefix.sh`.

## Status

- **Backend builds cleanly** (`cd backend && pnpm run build`).
- **Template validation test passes** (`pnpm vitest run tests/validation/validate-all-json.test.mts`).
- **Most other unit tests fail** — by design, deferred per user instruction.

## How the runtime resolves parameters

1. Backend loads `json/shared/parameter-definitions.json` lazily into a process-wide `ParameterDefinitionsRegistry` (`backend/src/parameter-definitions.mts`).
2. When a template / addon / application is loaded from disk, the persistence handler calls `registry.expand(parsed.parameters)`. This converts `["hostname", "memory"]` into the full `IParameter[]` shape downstream code already expects.
3. `expand()` accepts both forms:
   - `string` → looked up in registry (throws if unknown)
   - `object` → passed through as-is (legacy fallback for `applications-backup/`)
4. Stack-managed IDs (`CF_TOKEN`, `SMTP_PASSWORD`, …) are also in the registry as `internal: true` so template references work; their actual values come from the stack-selector flow at runtime.

## Why tests are failing

Most failures fall in three buckets — list with grep snippets so the next session can target them:

### 1. Template tests that exercise actual deployments (`tests/template-tests/**`)
Tests like `tests/template-tests/ssl/post-install-ssl-proxy-on-start.test.mts` run `pct exec` against a live container. They predate the migration and are integration-heavy. **Likely root cause**: stale assumptions about parameter shape in test fixtures, OR live VE not available during local test run. Run a single failing test in isolation and check whether the test fixture's `parameters` array still contains inline objects.

### 2. Templateprocessor / persistence tests (`tests/templateprocessor/**`, `tests/persistence/**`)
These build mock templates inline, e.g.
```ts
const tmpl = { name: "x", parameters: [{ id: "vm_id", name: "VM ID", type: "number" }], commands: [...] };
```
Two options:
- **A (preferred)**: Add a small test helper that registers ad-hoc IParameter definitions into the registry for the duration of a test, and switch fixtures to `parameters: ["vm_id"]`. The registry lives in `backend/src/parameter-definitions.mts`; expose `setForTest()` / use the existing `resetParameterDefinitionsRegistry()`.
- **B**: Keep the inline-object form working in tests via the legacy fallback in `expand()` (already supported). Just make sure tests don't bypass the persistence layer.

Option A matches production semantics — recommended.

### 3. Snapshot / documentation tests (`tests/output/**`)
`documentation-generator.test.mts` etc. build markdown from templates. Snapshots reference inline parameter objects. **Action**: regenerate snapshots after confirming a few are correct (`pnpm vitest run -u tests/output/documentation-generator.test.mts`). Verify a sample by hand before committing.

## Things deliberately not done (track for follow-up)

- **`applications-backup/` directories not migrated.** Schema accepts inline object form transitionally so `validateAllJson` passes. Once the dirs are deleted (or migrated), tighten `schemas/template.schema.json` and `schemas/base-deployable.schema.json` to `string`-only.
- **`group` and `order` fields**: in the schema but not yet populated for any parameter. Next phase: build the UI grouping and decide ordering per app. See `/Users/volkmar/.claude/plans/aufr-umen-des-installation-ui-typed-snowglobe.md` for the bigger plan.
- **`vm_id` type**: registry says `string` (majority across templates). Conceptually it's a number. Manual fix in `parameter-definitions.json` once the rest of the cleanup is done.
- **Per-template overrides** (`default`, `required`, `enumValuesTemplate`) currently live inside the central definition; empirical analysis showed that real conflicts are app-specific (gid, http_port etc.) and belong in `properties[]` of the application — not as per-template overrides. Apps may need cleanup.
- **`parameterOverrides[]` vs `properties[]`**: the plan calls for consolidating into `properties[]`. Not yet implemented in the schema/loader.

## How to re-run the migration

If the registry needs to be regenerated (e.g. after editing classification overrides):

```bash
cd /Users/volkmar/proxvex-green
node scripts/migration/01-list-parameters.mjs    # scan inventory
node scripts/migration/02-classify-parameters.mjs # classify (uses overrides)
node scripts/migration/03-build-definitions.mjs   # write parameter-definitions.json
node scripts/migration/05-validate-templates.mjs  # check
```

`04-rewrite-templates.mjs` is **idempotent** — it only rewrites files that still have inline objects. Safe to re-run.

## Quick sanity checks

```bash
# Registry is parseable and has the expected shape
jq '.parameters | length' /Users/volkmar/proxvex-green/json/shared/parameter-definitions.json   # → 178

# Backend builds
(cd /Users/volkmar/proxvex-green/backend && pnpm run build)

# Template validation (the must-pass test)
(cd /Users/volkmar/proxvex-green/backend && pnpm vitest run tests/validation/validate-all-json.test.mts)
```
