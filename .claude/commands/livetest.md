Run a live integration test against the active workspace instance (green or yellow).

## Usage
The user provides: `$ARGUMENTS`
Format: `[--fresh] [--fix] [test-filter]` — e.g. `--fresh zitadel/default`, `--fix pgadmin`, `--fix --fresh gitea`, `--all`.

## Instance auto-detection

The livetest skill always runs against exactly one instance. Which one is derived from `DEPLOYER_PORT` — set by the VS Code workspace file per worktree:
- `DEPLOYER_PORT=3201` → instance `green`  (worktree proxvex-green, nested VM 9000)
- `DEPLOYER_PORT=3301` → instance `yellow` (worktree proxvex-yellow, nested VM 9002)
- unset → treat as `green` (3201/9000)

At the start of the run, derive once and use consistently:

```sh
case "${DEPLOYER_PORT:-3201}" in
  3301) INSTANCE=yellow ;;
  *)    INSTANCE=green  ;;
esac
VMID=$(jq -r ".instances.${INSTANCE}.vmId" e2e/config.json)
PORT_OFFSET=$(jq -r ".instances.${INSTANCE}.portOffset" e2e/config.json)
DEPLOYER_PORT="${DEPLOYER_PORT:-$(jq -r ".instances.${INSTANCE}.deployerPort" e2e/config.json | sed 's/.*:-\([0-9]*\)}/\1/')}"
PVE_SSH_PORT=$((1022 + PORT_OFFSET))
```

Throughout the rest of the skill, substitute `$VMID`, `$DEPLOYER_PORT`, `$PVE_SSH_PORT`, `$INSTANCE` where the old instructions had hardcoded `9000`, `3201`, `1022`, `dev`.

## Steps

1. **Parse arguments**: Check if `--fresh` and/or `--fix` flags are present. Remove them from the test filter.

2. **Build if needed**: Only build if backend TypeScript was changed. For JSON/script-only changes, a deployer reload is sufficient.
   - Check if backend was edited: `test -f .claude/claude.backend-edited`
   - If yes: `cd backend && pnpm run build` (and remove marker: `rm -f .claude/claude.backend-edited`)
   - If no: skip build (JSON/script changes are picked up by deployer reload)

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

4. **Check if deployer is already running** on port $DEPLOYER_PORT:
   ```
   lsof -i :$DEPLOYER_PORT -sTCP:LISTEN
   ```

5. **Start deployer in background** if not running (using livetest-specific context):
   ```
   mkdir -p .livetest-data
   cd backend && DEPLOYER_PORT=$DEPLOYER_PORT node dist/proxvex.mjs \
     --local ../livetest-local \
     --storageContextFilePath ../.livetest-data/storagecontext.json \
     --secretsFilePath ../.livetest-data/secret.txt &
   ```
   Wait 3 seconds, then verify it responds:
   ```
   curl -sk --connect-timeout 5 http://localhost:$DEPLOYER_PORT/api/applications | head -c 50
   ```
   If it doesn't respond, show the error and stop.

6. **Run the livetest** (with flags removed from arguments):
   ```
   DEPLOYER_PORT=$DEPLOYER_PORT npx tsx backend/tests/livetests/src/live-test-runner.mts $INSTANCE <test-filter>
   ```
   Use a 10 minute timeout. Show the full output to the user.

7. **Report results** — summarize pass/fail status.

8. **If `--fix` and tests failed**: Enter the fix loop (see below).

## Fix loop (`--fix`)

When `--fix` is set, time does not matter — the goal is to get all tests green with minimal user interaction. Work autonomously through failures.

### For each failed scenario:
1. **Analyze the failure**:
   - Extract the diagnostic tarball to `/tmp/` and read the CLI output for the failed VM
   - Look for `"exitCode":-1` or `"exitCode":1` in `cli-output.log` — the `stderr` field contains the error
   - Also check: `lxc.conf`, `lxc.log`, `docker-ps.txt`, `docker-compose.yml` in the diagnostic dir
   - Common causes: template variable not resolved, script syntax error, `from __future__` in prepended library, container failed to start, docker service not healthy, check template running when it shouldn't (missing skip condition)

2. **Fix the issue** in the codebase (templates, scripts, backend code, application JSON)

3. **Rebuild and/or restart**:
   - If backend code changed: rebuild and restart deployer:
     ```
     cd backend && pnpm run build
     kill $(lsof -ti :$DEPLOYER_PORT -sTCP:LISTEN) 2>/dev/null; sleep 2
     mkdir -p ../.livetest-data
     cd backend && DEPLOYER_PORT=$DEPLOYER_PORT node dist/proxvex.mjs \
       --local ../livetest-local \
       --storageContextFilePath ../.livetest-data/storagecontext.json \
       --secretsFilePath ../.livetest-data/secret.txt &
     ```
   - If only JSON/scripts changed: reload deployer (no build needed):
     ```
     curl -sk -X POST http://localhost:$DEPLOYER_PORT/api/reload
     ```

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

## Notes
- `green` / `yellow` instances in `e2e/config.json` connect to the deployer at `localhost:${DEPLOYER_PORT}` (3201 green, 3301 yellow)
- The deployer uses `.livetest-data/` for context (not `examples/`) to isolate test state from manual use
- The PVE host is `ubuntupve`; port-forwarded SSH to the nested VM goes through port `1022 + portOffset` (1022 green, 1222 yellow)
- The outer PVE host is `ubuntupve` on SSH port 22 (direct, used for `qm` commands against the nested VM)
- Do NOT stop the deployer after the test — leave it running for subsequent tests
- After code changes that affect the deployer itself, **restart the deployer** (kill + start) so it picks up the new build
