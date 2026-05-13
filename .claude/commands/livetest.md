Run a live integration test against the active workspace instance (green or yellow), or against any instance via `--config`.

## Usage
The user provides: `$ARGUMENTS`
Format: `[--fresh] [--fix] [--debug <level>] [--config <instance>] [test-filter]`

### When `$ARGUMENTS` is empty (no parameters)

**Do not run any test.** Show the help text below to the user verbatim, then use `AskUserQuestion` to find out what to run. After the user answers, restart this skill with the chosen arguments as if the user had typed them — go through all steps below.

Help text to print:

```
Usage: /livetest [--fresh] [--fix] [--debug <level>] [--config <instance>] [test-filter]

Test filter   Application name (eclipse-mosquitto), scenario (zitadel/default),
              "--all" for the full suite, or any tag selector.
--debug LV    off | extLog (default) | script. Sets debug_level on the target
              scenario; bundle lands in livetest-results/<runId>/<scenarioId>/.
              "script" adds set -x to every shell script.
--fresh       Wipe .livetest-data and roll back the nested VM to deployer-installed
              before starting. Use after suspected dependency corruption.
--fix         Autonomously analyse failures (via the debug bundle) and retry
              until all tests pass or you give up.
--config INST Target the nested-VM deployer of <inst> instead of the local
              backend. Runs step2b first (~2 min).

Examples:
  /livetest eclipse-mosquitto
  /livetest --debug script zitadel/default
  /livetest --fresh --all
  /livetest --fix pgadmin
  /livetest --config github-action --all
```

Then ask via `AskUserQuestion`:

- **Question**: "Welcher Test soll ausgeführt werden?"
- **Header**: `Test`
- **Options** (single-select, last is Other-auto):
  - `eclipse-mosquitto/default` — single scenario, ~1 min, no dependencies (Recommended)
  - `--all` — full suite, ~30+ min, all 43 scenarios
  - `zitadel/default` — docker-compose app with postgres dependency
  - `pgadmin` — quick docker-compose test with postgres dependency

When the user picks an option, also ask in a second question whether to enable `--debug` (single-select):
- **Question**: "Debug-Level?"
- **Header**: `Debug`
- **Options**:
  - `extLog (default)` — bundle written, no `set -x` (Recommended)
  - `script` — bundle with `set -x` in shell scripts (slower)
  - `off` — no bundle

Once both answers are in, treat the inputs as if the user had originally typed `/livetest [--debug <level>] <test>` and execute the steps below.

Examples:
- `--fresh zitadel/default` — green/yellow auto-detected, local backend
- `--fix pgadmin` — fix loop, local backend
- `--debug script eclipse-mosquitto` — collect rich debug bundle for the target scenario (set -x in shell scripts + interleaved backend logger + per-script trace)
- `--debug extLog zitadel/default` — extLog level: redacted scripts + var annotations + logger trace, but no `set -x`
- `--config github-action --all` — full suite against the **nested-VM deployer** of the github-action instance, after step2b refresh
- `--config green --all` — same but against the green nested-VM deployer (skips local backend)

**`--debug <level>` values**: `off` | `extLog` | `script`. Defaults to `extLog` when omitted — the livetest writes the debug bundle into `livetest-results/<runId>/<scenarioId>/` regardless of test outcome, and the bundle is the primary failure-analysis tool (see Fix-loop section). `--debug script` adds `set -x` to every shell script — slower but ideal when you need to see exact command expansions.

**Dependencies are not debugged**: the debug bundle is collected only for the user-requested target scenario, not for dependencies pulled in via `depends_on`. To debug a dependency, request it explicitly as the target.

## Two modes

The skill supports two execution modes:

**Local-backend mode (default — no `--config`):**
- Instance auto-detected from `DEPLOYER_PORT` (worktree-specific)
- Backend runs **locally** in the dev terminal on `localhost:$DEPLOYER_PORT`
- Talks to the nested VM only for `pct` operations
- Fast iteration — no docker build, no nested-VM redeploy

**Nested-deployer mode (`--config <instance>`):**
- Instance taken from the `--config` value (must exist in `e2e/config.json`)
- step2b runs first → docker build + skopeo + pct create on the nested VM, so the deployer LXC inside the nested VM has the current PR's code
- live-test-runner connects to that nested-VM deployer via the PVE-host port-forward (`$PVE_HOST:$((ports.deployer + portOffset))`)
- No local backend — closer to what the github-action workflow does, useful to verify install paths end-to-end
- Slower (~2 min for step2b before tests start)

## Instance derivation

```sh
# Mode + instance
CONFIG_INSTANCE=""             # populated from --config; empty means local-backend mode
case "${DEPLOYER_PORT:-3201}" in
  3301) AUTO_INSTANCE=yellow ;;
  *)    AUTO_INSTANCE=green  ;;
esac
INSTANCE="${CONFIG_INSTANCE:-$AUTO_INSTANCE}"

# Per-instance values from config.json
VMID=$(jq -r ".instances.${INSTANCE}.vmId" e2e/config.json)
PORT_OFFSET=$(jq -r ".instances.${INSTANCE}.portOffset" e2e/config.json)
PVE_SSH_PORT=$((1022 + PORT_OFFSET))

# In local-backend mode: DEPLOYER_PORT is the env-set port on dev (3201/3301)
# In nested-deployer mode: DEPLOYER_PORT is the host-side port-forward (1080 + offset)
if [ -n "$CONFIG_INSTANCE" ]; then
    PORTS_DEPLOYER=$(jq -r '.ports.deployer' e2e/config.json)
    DEPLOYER_PORT=$((PORTS_DEPLOYER + PORT_OFFSET))
else
    DEPLOYER_PORT="${DEPLOYER_PORT:-$(jq -r ".instances.${INSTANCE}.deployerPort" e2e/config.json | sed 's/.*:-\([0-9]*\)}/\1/')}"
fi
```

Throughout the rest of the skill, substitute `$VMID`, `$DEPLOYER_PORT`, `$PVE_SSH_PORT`, `$INSTANCE` where the old instructions had hardcoded values.

## Steps

1. **Parse arguments**: Check for `--fresh`, `--fix`, `--config <instance>`. Remove them from the test filter — these are skill-side flags. Validate `--config` value exists in `e2e/config.json`'s `.instances` (else fail with clear error). Apply the instance-derivation block above. **Keep `--debug <level>` in the argument list** — it is consumed by `live-test-runner.mts` (not by the skill) and propagates to the backend as the `debug_level` parameter on the target scenario.

2. **Build if needed**: Only build if backend TypeScript was changed. For JSON/script-only changes, a deployer reload is sufficient.
   - Check if backend was edited: `test -f .claude/claude.backend-edited`
   - If yes: `cd backend && pnpm run build` (and remove marker: `rm -f .claude/claude.backend-edited`)
   - If no: skip build (JSON/script changes are picked up by deployer reload)

2a. **If `--config $INSTANCE` was provided** (nested-deployer mode):
   - Run step2b to refresh the deployer LXC inside the nested VM with the current PR's code:
     ```
     ./e2e/step2b-install-deployer.sh $INSTANCE
     ```
     This rolls back to `mirrors-ready`, runs `pnpm build` + `npm pack` + `docker build` + `skopeo copy oci-archive` + scp + `install-proxvex.sh --use-existing-image`, then snapshots `deployer-installed`. Takes ~2 minutes.
   - **Skip step 4 + 5** (no local backend startup) and **patch `e2e/config.json`** so live-test-runner targets the nested-VM deployer:
     ```sh
     cp e2e/config.json /tmp/livetest-config.bak.$$
     trap 'cp /tmp/livetest-config.bak.$$ e2e/config.json; rm -f /tmp/livetest-config.bak.$$' EXIT
     jq --arg i "$INSTANCE" 'del(.instances[$i].deployerHost) | del(.instances[$i].deployerPort)' \
        e2e/config.json > /tmp/livetest-config.new.$$ && mv /tmp/livetest-config.new.$$ e2e/config.json
     ```
     Removing `deployerHost`/`deployerPort` from the chosen instance makes live-test-runner fall back to `pveHost:ports.deployer + portOffset` — i.e. `$PVE_HOST:$DEPLOYER_PORT`, which is the host-side port-forward to the deployer LXC inside the nested VM. The trap restores the file on exit.
   - Then jump straight to step 6.

3. **If `--fresh`**:
   - Delete livetest data (wipe local context/secrets):
     ```
     rm -rf .livetest-data
     ```
   - Delete all test-created snapshots then rollback to `deployer-installed`
     (this snapshot is created by `step2b-install-deployer.sh` and sits on top
     of `mirrors-ready`, which holds the Docker Hub / ghcr.io pull-through
     caches every test needs):
     ```
     ssh -o StrictHostKeyChecking=no root@ubuntupve "for snap in \$(qm listsnapshot $VMID | grep -v 'baseline\|mirrors-ready\|deployer-installed\|current' | awk '{print \$2}'); do [ -n \"\$snap\" ] && qm delsnapshot $VMID \$snap; done"
     ssh -o StrictHostKeyChecking=no root@ubuntupve "qm stop $VMID 2>/dev/null; true"
     ssh -o StrictHostKeyChecking=no root@ubuntupve "qm rollback $VMID deployer-installed"
     ssh -o StrictHostKeyChecking=no root@ubuntupve "qm start $VMID"
     ```
   - Wait for the nested VM to be reachable:
     ```
     for i in $(seq 1 30); do ssh -o StrictHostKeyChecking=no -o ConnectTimeout=2 -p $PVE_SSH_PORT root@ubuntupve 'echo ok' 2>/dev/null && break; sleep 2; done
     ```

   > **Why not `baseline`?** The `baseline` snapshot is the raw Proxmox install
   > without the deployer and without the registry mirrors. Rolling back to it
   > means every image pull hits the internet via double-NAT and fails (skopeo
   > TLS mismatch). Snapshot chain: `baseline` (step1) → `mirrors-ready`
   > (step2a, fills Docker Hub + ghcr.io pull-through caches) → `deployer-installed`
   > (step2b, installs proxvex). Livetests always roll back to `deployer-installed`
   > so they start from a known-good state with filled mirrors. To recreate from
   > scratch, re-run `./e2e/step1-create-vm.sh $INSTANCE`,
   > `./e2e/step2a-setup-mirrors.sh $INSTANCE`, then
   > `./e2e/step2b-install-deployer.sh $INSTANCE`. To rebuild just the deployer
   > on top of the existing mirrors, re-run step2b — step2a is idempotent (checks
   > versions.sh hash) and will no-op if nothing changed.

4. **(local-backend mode only — skip if `--config` was set)** Start the local backend in Spoke mode via the helper script. The script ensures the proxvex-LXC inside the nested VM (the Hub) is running, waits for its API, then starts the local backend with `HUB_URL` set so it pulls project settings from the Hub.

   **Always start the deployer this way — never `node dist/proxvex.mjs` directly.**

   **Decide whether to pass `--refresh-hub`:** the Hub-LXC has its own baked-in copy of `backend/dist/`, `schemas/`, and `json/`. If your local change touches:
   - `schemas/**` (template/output/application schema)
   - `backend/src/types.mts` or anything that adds new template-validation fields (`execute_on` enum, parameter shapes, etc.)
   - `backend/src/persistence/**`, `backend/src/templates/**`, `backend/src/ve-execution/**`

   then the Hub schema must be refreshed or it will crash-loop on boot when validating templates. Use:
   ```
   ./e2e/start-livetest-deployer.sh --refresh-hub $INSTANCE
   ```
   `--refresh-hub` runs `pnpm build` + `npm pack` + `docker build` + `skopeo copy oci-archive` + scp + `install-proxvex.sh --tarball` (~2 min). It cleanly redeploys the Hub-LXC — preferred over the older `--update-from-tarball` live-patch flow.

   For pure `json/` template/script edits (no schema change): plain `./e2e/start-livetest-deployer.sh $INSTANCE` is enough; the Spoke uses its local jsonPath.

   **Recovery from Hub crash-loop** (`curl Hub/api/applications` times out but `qm status 9002` says running):
   ```
   ssh root@ubuntupve "qm stop $VMID; qm rollback $VMID deployer-installed; qm start $VMID"
   ./e2e/start-livetest-deployer.sh --refresh-hub $INSTANCE
   ```

   The script kills any deployer already on `$DEPLOYER_PORT`, so it is safe to re-run. On failure it prints the last log lines and exits non-zero — abort the livetest run.

5. **(reserved)** — historically this slot held the manual deployer-start; now folded into step 4.

6. **Run the livetest** (with skill-only flags stripped, but `--debug <level>` kept):
   - Local-backend mode (default): `DEPLOYER_PORT=$DEPLOYER_PORT npx tsx backend/tests/livetests/src/live-test-runner.mts $INSTANCE <remaining-args>`
   - Nested-deployer mode (`--config`): `npx tsx backend/tests/livetests/src/live-test-runner.mts $INSTANCE <remaining-args>` — no `DEPLOYER_PORT` env override; live-test-runner derives the URL from the patched config (`pveHost:ports.deployer + portOffset`).

   `<remaining-args>` includes any `--debug <level>` flag and the test filter. The runner defaults `debug_level=extLog` when no `--debug` was passed, so the debug bundle is always produced for the target scenario.

   Use a 10 minute timeout (15 in `--config` mode to allow for step2b). Show the full output to the user.

7. **Report results** — summarize pass/fail status. Always mention the debug-bundle location: `livetest-results/$(ls -1t livetest-results/ | head -1)/`. For failed scenarios, the bundle's `livetest-index.md` is the first place the user (or fix loop) should look.

8. **If `--fix` and tests failed**: Enter the fix loop (see below).

## Fix loop (`--fix`)

When `--fix` is set, time does not matter — the goal is to get all tests green with minimal user interaction. Work autonomously through failures.

### For each failed scenario:
1. **Analyze the failure via the debug bundle**:

   Every livetest run writes a per-scenario debug bundle to `livetest-results/<runId>/<scenarioId>/`. This is the primary failure-analysis tool — far richer than the legacy `cli-output.log`. Use it first.

   The latest run directory is `livetest-results/$(ls -1t livetest-results/ | head -1)`. Inside each scenario directory:

   ```
   <scenarioId>/
     livetest-index.md          ← entry point (status + links to everything)
     test-result.md             ← pass/fail JSON (status, verify_results, error_message)
     host-diagnostics.md        ← LXC log, dmesg, docker logs (legacy diagnostics)
     index.md                   ← backend debug bundle entry (start here for "why did it fail")
     variables.md               ← variable cross-reference (which var, which script, which line)
     scripts/NN-<slug>.md       ← per-script: redacted body + chronological trace (logger+stderr interleaved)
     scripts/NN-<slug>.meta.json       ← parseable: exitCode, durations, command, executeOn
     scripts/NN-<slug>.trace.json      ← parseable: full trace events with timestamps
     scripts/NN-<slug>.substitutions.json ← parseable: which {{var}} got which value (redacted for secrets)
   ```

   **Recommended analysis flow**:
   1. Read `test-result.md` to confirm `status: "failed"` and grab `error_message`.
   2. Find the failed script: `jq 'select(.exitCode != 0) | {index, command, exitCode}' scripts/*.meta.json` — gives index + name of every non-zero script.
   3. Open `scripts/<NN>-<slug>.md` for that script — Trace section shows logger lines, stderr, and (if `--debug script` was used) `set -x` output interleaved chronologically. Each `.md` has CSS toggle checkboxes to hide noise (logger debug lines, stderr-only view, etc.).
   4. If a variable looks wrong, open `variables.md` to see every line where it was used. Secure values are redacted as `*** redacted ***`.
   5. If the failure is post-script (docker container couldn't start), check `host-diagnostics.md`.

   **Bundle availability prerequisite**: the bundle exists only when `debug_level != off` for the scenario. The livetest defaults to `extLog`. If the user explicitly passed `--debug off`, redo the run with the default (or `--debug script`) before fix-loop analysis.

   **Common failure causes** (which the bundle makes obvious):
   - Template variable not resolved → check `variables.md` for `NOT_DEFINED` entries.
   - Script syntax error → script's `.md` Trace shows the shell parser error.
   - `from __future__` in prepended library → trace shows the python import error.
   - Container failed to start → `host-diagnostics.md` + last script's Post-Trace.
   - Docker service not healthy → `verify_results` in `test-result.md` flags it.
   - Check template ran when it shouldn't → script in scripts/ with name "check…" that has exitCode != 0; review skip condition.

   **Legacy fallback**: If the bundle is empty or missing (e.g. backend died before task end), fall back to reading the deployer log at `/tmp/livetest-deployer-${INSTANCE}.log` and the CLI stdout the runner captured under `livetest-results/<runId>/<scenarioId>/test-result.md`'s `error_message` field.

2. **Fix the issue** in the codebase (templates, scripts, backend code, application JSON)

3. **Rebuild and/or restart**:

   **Local-backend mode** (default):
   - If schema/types/persistence/templates/ve-execution changed: rebuild + redeploy Hub:
     ```
     cd backend && pnpm run build && cd ..
     ./e2e/start-livetest-deployer.sh --refresh-hub $INSTANCE
     ```
   - If only other backend code changed (no schema/validation impact): rebuild + restart Spoke:
     ```
     cd backend && pnpm run build && cd ..
     ./e2e/start-livetest-deployer.sh $INSTANCE
     ```
   - If only JSON/scripts changed: reload deployer (no build needed):
     ```
     curl -sk -X POST http://localhost:$DEPLOYER_PORT/api/reload
     ```

   **Nested-deployer mode** (`--config`):
   - The deployer LXC inside the nested VM doesn't reload from local code — it carries the OCI image we built at step2b time. So any backend or JSON/script change requires re-running step2b to rebuild the image and reinstall the LXC:
     ```
     ./e2e/step2b-install-deployer.sh $INSTANCE
     ```
   - Slower iteration than local-backend mode (~2 min per fix attempt). For tight loops on backend logic, prefer local-backend mode.

4. **Re-run the livetest** (step 6) with the same filter

5. **If the same scenario fails again** with a different error: fix and retry again

6. **If a scenario fails with an issue you cannot fix** (infrastructure problem, external service down, unclear root cause after 2 attempts): Skip it and continue with the remaining scenarios. Report the unfixable issue to the user at the end.

7. **Repeat** until all fixable tests pass

### Fix loop principles:
- **Be autonomous**: Don't ask the user unless you're truly stuck. Fix, rebuild, retest.
- **Time is not a concern**: A full test run can take 5-10 minutes. That's fine.
- **Dependency failures cascade**: If postgres fails, zitadel and gitea will also fail. Fix the root dependency first.
- **Always restart the deployer** after code changes — it caches schemas and templates.
- **Run unit tests** (`pnpm test`) after significant backend changes to catch regressions early.
- **At the end**, report: which tests pass, which were unfixable and why.

## How the test runner works

### Dependencies and VM reuse
Tests declare dependencies (e.g. `gitea/default` depends on `zitadel/default` which depends on `postgres/default`). The runner resolves the full chain and creates an execution plan with VM IDs.

**VM reuse priority** (highest first):
1. **Whole-VM snapshot restore**: If a `qm snapshot` exists for the dependency chain, rollback the entire nested PVE VM (fastest). Local context (storagecontext.json, secret.txt) is restored from the VM to match snapshot state.
2. **Running VM**: If the dependency container is already running inside the nested VM, reuse it as-is
3. **Fresh install**: Install the dependency from scratch

### Whole-VM snapshots (green/yellow instances)
- Enabled via `e2e/config.json` → `snapshot.enabled: true` (set for both green and yellow)
- **Created** via `qm snapshot $VMID <name> --vmstate 0` (live, ~2s, no VM stop)
- **Context backup**: Before snapshot, local `.livetest-data/` files are copied to the nested VM so passwords are embedded in the snapshot
- **Naming**: `dep-<app>-<variant>` (e.g. `dep-postgres-default`, `dep-zitadel-ssl`)
- **Scope**: One snapshot captures the entire nested PVE VM including all containers, configs, volumes, and context backup
- **Rollback**: `qm stop` → `qm rollback` → `qm start` → restore local context from VM (~30-60s for VM boot)

### When things go wrong
If a test fails and you want a clean retry:
- **Just re-run**: The runner auto-detects existing snapshots and restores dependencies from them. Only the failed target VM gets reinstalled.
- **Fresh start**: Use `--fresh` flag to rollback to `deployer-installed` and wipe `.livetest-data/`. This reinstalls every app from scratch while keeping the deployer + registry mirrors from step2.
- **Dependencies are corrupt**: Use `--fresh` to reset to `deployer-installed`.
- **Deployer itself is corrupt**: Re-run `./e2e/step2b-install-deployer.sh $INSTANCE` — rolls back to `mirrors-ready` and rebuilds the deployer LXC from a freshly-built local OCI image (no mirror re-fill).
- **Mirrors missing or corrupt**: Re-run `./e2e/step2a-setup-mirrors.sh $INSTANCE --force` (rolls back to `baseline`, reinstalls Docker + mirrors + pre-pulls ~15 min), then `./e2e/step2b-install-deployer.sh $INSTANCE`.
- **Nothing usable at all**: Re-run `./e2e/step1-create-vm.sh $INSTANCE`, `./e2e/step2a-setup-mirrors.sh $INSTANCE`, `./e2e/step2b-install-deployer.sh $INSTANCE` to rebuild all three snapshots from scratch.

### VM cleanup behavior
- **Target VMs**: Destroyed after test (unless `KEEP_VM=1`)
- **Dependency VMs**: Never destroyed (kept for snapshot reuse across runs)
- `KEEP_VM=1`: Prevents target VM destruction for debugging

## Debug bundle reference

Every livetest run with `debug_level != off` (default: `extLog`) produces a per-scenario debug bundle. Knowing the layout speeds up failure analysis.

**Levels** (set via `--debug <level>`):
- `off` — no bundle, fastest, no analysis aid.
- `extLog` (default) — redacted-script twin + `# vars: …` line annotations + Logger debug lines pulled into the trace + per-script chronological trace (logger + stderr interleaved).
- `script` — everything from `extLog` **plus** `set -x` injected into every shell script, so the trace shows each expanded command. Pick this when you need to see why a shell command behaved unexpectedly.

**Layout** (per `livetest-results/<runId>/<scenarioId>/`):

| File | Audience | When to read |
|---|---|---|
| `livetest-index.md` | human | start here — overview + links |
| `test-result.md` | human + machine (PostgREST-shaped JSON inside) | confirm pass/fail, get `error_message` |
| `host-diagnostics.md` | human | LXC log, dmesg, docker logs (post-mortem) |
| `index.md` | human | backend bundle entry: script table with exit/duration, preamble/postamble trace |
| `variables.md` | human | which variable was used where; secure values redacted |
| `scripts/NN-<slug>.md` | human | redacted script body + chronological trace per command |
| `header.json`, `variables.json`, `scripts/NN-….meta.json`, `.substitutions.json`, `.trace.json` | machine | jq-parseable structured data — same content as the .md, no formatting noise |

**Trace section format**: HTML `<div class="trace">` with per-row CSS classes (`source-logger`, `source-stderr`, `source-subst`, `source-docker`, `level-debug`, `level-warn`, `level-error`). Each trace section has filter checkboxes (Logger / Stderr / Substitutions / per-level toggles) that hide rows via `:has()`-based CSS. Works in VS Code preview and any modern browser. Codeblock fallback exists for plain-text viewers (`glow`, GitHub strips `<style>`).

**Quick analysis recipes**:

```sh
# Find all failed scripts across all scenarios of the latest run
RUN=livetest-results/$(ls -1t livetest-results/ | head -1)
jq -r 'select(.exitCode != null and .exitCode != 0)
       | "\(.index)\t\(.exitCode)\t\(.command)"' \
   "$RUN"/*/scripts/*.meta.json

# Show all variables that were NOT_DEFINED at substitution time
jq -r '.[] | select(.redactedValue == "NOT_DEFINED")
       | "\(.var)\tline \(.line)"' \
   "$RUN"/*/scripts/*.substitutions.json

# Open the bundle for one scenario in a browser-renderer
npx markserv "$RUN/zitadel-default/"
```

## Notes
- `green` / `yellow` instances in `e2e/config.json` connect to the deployer at `localhost:${DEPLOYER_PORT}` (3201 green, 3301 yellow)
- The deployer uses `.livetest-data/` for context (not `examples/`) to isolate test state from manual use
- The PVE host is `ubuntupve`; port-forwarded SSH to the nested VM goes through port `1022 + portOffset` (1022 green, 1222 yellow)
- The outer PVE host is `ubuntupve` on SSH port 22 (direct, used for `qm` commands against the nested VM)
- Do NOT stop the deployer after the test — leave it running for subsequent tests
- After code changes that affect the deployer itself, **restart the deployer** (kill + start) so it picks up the new build
