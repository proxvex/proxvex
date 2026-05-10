Run a production setup step against the live cluster (`pve1.cluster`), with mandatory livetest reproduction on failure.

## Usage

The user provides: `$ARGUMENTS`
Format: `[--step N] [--fresh] [--fix] [--upgrade-deployer]`

Examples:
- `--step 10` — run the zitadel deploy step against the live cluster
- `--step 12 --fix` — run gitea deploy; on failure auto-trigger livetest reproduction + fix loop
- `--upgrade-deployer` — upgrade proxvex deployer in place (NEVER destroy+install)
- `--fresh --step 7` — rare, see safety section before using

## Step → livetest scenario mapping

| Step | App / Path | Livetest scenario |
|---|---|---|
| 7 | postgres | `postgres/default` |
| 10 | zitadel | `zitadel/default` |
| 11 | proxvex (reconfigure) | proxvex reconfigure path — no `default.json` scenario today; if a fail happens here, reproduce manually with the `addon-oidc` reconfigure of the proxvex app inside the nested VM |
| 12 | gitea | `gitea/default` |
| 13 | eclipse-mosquitto | `eclipse-mosquitto/default` |
| 15 | node-red | `node-red/default` |
| 16 | modbus2mqtt | `modbus2mqtt/default` |

## ⚠️ HARD SAFETY CONSTRAINTS

These containers MUST NEVER be destroyed by this skill:

- **proxvex** (Deployer) — destroying it loses ACME-Trust-CA, the local cert cache, and the in-memory `ContextManager` carrying every stack secret (ZITADEL_MASTERKEY, ZITADEL_DB_PASSWORD, ZITADEL_ADMIN_PASSWORD, etc.). proxvex is updated **exclusively** via the Upgrade Task (`/production --upgrade-deployer`), never via destroy + install.
- **nginx** — destroying it loses vhost configurations and ACME renewal state.
- **docker-registry-mirror, ghcr-mirror, zot-mirror** — destroying any of these triggers a massive re-pull over the WAN.

`destroy` (bare) — **NEVER** call this. Cleanup ONLY through `production/destroy-except.sh`, and ONLY when the user supplied `--fresh`. `destroy-except.sh` already has an allowlist (proxvex, nginx, mirrors); never modify or bypass it.

`destroy-except.sh` is invoked **only** when `--fresh` is on the command line. Without `--fresh`, the skill operates idempotently against the existing cluster.

If a step fails, **do not** use destroy as a "fix attempt" — failing-state-then-rebuild loses persistent state. Use the livetest reproduction loop instead (failures are reproducible in the isolated nested VM, where destruction is safe).

## Pre-flight check

Before running any step:

```sh
# Verify proxvex / nginx / mirror are running on pve1.cluster
ssh -o StrictHostKeyChecking=no root@${PVE_HOST:-pve1.cluster} \
  "pct list 2>/dev/null | grep -E '^[0-9]+\\s+running\\s+\\S+\\s+(proxvex|nginx|.*mirror)\$'"
```

If proxvex, nginx, or any mirror is NOT running: **abort with a clear message**. Do NOT auto-start; the user must investigate (might be intentional for maintenance, or might require a backup restore).

## Workflow

### 1. Run the step

```sh
./production/setup-production.sh --step ${N}
```

Stream output. Capture stdout/stderr.

### 2. On success → done

If exit code 0 and no `Error:` lines in output → report success.

### 3. On failure → mandatory livetest reproduction

If the step fails, **DO NOT** retry against production. Instead:

1. **Extract failure signature**:
   - Which template step failed (`[N/M] <name>`)?
   - Exit code, error message, stderr lines
   - Which apps were already installed (from `pct list`)?
   - Was this a fresh install or a re-install/reconfigure?
   - Container DB state for stateful apps (e.g. postgres has zitadel events?)

2. **Reproduce in livetest** — try increasingly aggressive tricks before claiming a coverage gap:

   a. **Same scenario, fresh container, KEEP_VM**:
      ```sh
      KEEP_VM=1 npx tsx backend/tests/livetests/src/live-test-runner.mts green <app>/default
      ```
      Use `livetest --fix <app>/default` if a check template should catch the failure.

   b. **Same vorgänger-state**: ensure all production prerequisites are also installed in the livetest, in the same order. The runner resolves dependencies automatically; if production failed at step 12 (gitea), make sure postgres + zitadel scenarios are run first (the runner does this for declared dependencies, but verify).

   c. **Same re-install path**: if production failed during a re-install/reconfigure (not a fresh deploy), reproduce by installing once, then triggering reconfigure or re-install in the livetest. KEEP_VM holds the container so the second pass uses the existing state.

   d. **Same data state**: if the failure is "container new but DB has prior events" (typical Zitadel FirstInstance skip), reproduce by: install app, destroy container only, install app again against same DB. KEEP_VM=1 + manual `pct destroy` of the target.

   e. **Verbose logs**: re-run with elevated logging, capture container logs (`docker logs` in app, `journalctl -u docker`), compare against production logs.

3. **If reproduction succeeds**:
   - Add a check template (analog to `json/applications/zitadel/templates/post_start/371-post-check-deployer-oidc-stack.json`) that catches this specific failure mode going forward.
   - Develop the fix, iterate via `curl POST /api/reload` + re-run, until the livetest is green.
   - Document the fix in the commit message.
   - Then `--step ${N}` against production again.

4. **If reproduction does NOT succeed** after all the tricks above:
   - This is a genuine **test coverage gap** — production exhibits behavior the livetest cannot reproduce.
   - Document: which tricks were tried, what their outputs were, and what's structurally missing in the livetest setup that prevents reproduction (different network topology? different cluster size? real-world DNS? real ACME certs?).
   - Propose: new test variant, new precursor setup, new snapshot state, or extended scenario chain.
   - Only THEN consider risking another production attempt — and make a backup first.

### 4. After successful livetest fix

Re-run the production step. Expect it to succeed since the same code path is now exercised in livetest.

## --upgrade-deployer

Updates proxvex via the Upgrade Task (NOT via destroy + install). The exact mechanism depends on cluster state — typically `setup-production.sh --step <upgrade-N>` or a dedicated `upgrade-deployer.sh` script. Verify the script exists and operates in-place. Refuse to call this if it's missing — never substitute with destroy + install.

## --fresh

Reserves `production/destroy-except.sh` as the cleanup mechanism. The script's built-in allowlist preserves proxvex, nginx, and mirrors. Confirm with the user before running:

> ⚠️ This will destroy ALL containers EXCEPT proxvex, nginx, and the registry mirrors. Postgres, Zitadel, gitea, and other apps will be wiped. Continue? (y/N)

Even with the user's explicit consent, double-check the allowlist in `destroy-except.sh` before running:

```sh
grep -n "preserve\|except\|allowlist\|skip" /Users/volkmar/proxvex-green/production/destroy-except.sh | head
```

If the allowlist no longer includes proxvex/nginx/mirror, **abort** and report the discrepancy.
