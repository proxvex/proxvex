Run a live integration test against the dev instance.

## Usage
The user provides: `$ARGUMENTS`
Format: `[--fresh] [--fix] [test-filter]` — e.g. `--fresh zitadel/default`, `--fix pgadmin`, `--fix --fresh gitea`, `--all`.

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
   - Delete child snapshots then rollback to baseline:
     ```
     ssh -o StrictHostKeyChecking=no root@ubuntupve 'for snap in $(qm listsnapshot 9000 | grep dep- | awk "{print \$2}"); do qm delsnapshot 9000 $snap; done'
     ssh -o StrictHostKeyChecking=no root@ubuntupve 'qm stop 9000 2>/dev/null; true'
     ssh -o StrictHostKeyChecking=no root@ubuntupve 'qm rollback 9000 baseline'
     ssh -o StrictHostKeyChecking=no root@ubuntupve 'qm start 9000'
     ```
   - Wait for the nested VM to be reachable:
     ```
     for i in $(seq 1 30); do ssh -o StrictHostKeyChecking=no -o ConnectTimeout=2 -p 1022 root@ubuntupve 'echo ok' 2>/dev/null && break; sleep 2; done
     ```

4. **Check if deployer is already running** on port 3201:
   ```
   lsof -i :3201 -sTCP:LISTEN
   ```

5. **Start deployer in background** if not running (using livetest-specific context):
   ```
   mkdir -p .livetest-data
   cd backend && DEPLOYER_PORT=3201 node dist/oci-lxc-deployer.mjs \
     --storageContextFilePath ../.livetest-data/storagecontext.json \
     --secretsFilePath ../.livetest-data/secret.txt &
   ```
   Wait 3 seconds, then verify it responds:
   ```
   curl -sk --connect-timeout 5 http://localhost:3201/api/applications | head -c 50
   ```
   If it doesn't respond, show the error and stop.

6. **Run the livetest** (with flags removed from arguments):
   ```
   DEPLOYER_PORT=3201 npx tsx backend/tests/livetests/src/live-test-runner.mts dev <test-filter>
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
     kill $(lsof -ti :3201 -sTCP:LISTEN) 2>/dev/null; sleep 2
     mkdir -p ../.livetest-data
     cd backend && DEPLOYER_PORT=3201 node dist/oci-lxc-deployer.mjs \
       --storageContextFilePath ../.livetest-data/storagecontext.json \
       --secretsFilePath ../.livetest-data/secret.txt &
     ```
   - If only JSON/scripts changed: reload deployer (no build needed):
     ```
     curl -sk -X POST http://localhost:3201/api/reload
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

### Whole-VM snapshots (dev instance only)
- Enabled via `e2e/config.json` → `snapshot.enabled: true`
- **Created** via `qm snapshot 9000 <name> --vmstate 0` (live, ~2s, no VM stop)
- **Context backup**: Before snapshot, local `.livetest-data/` files are copied to the nested VM so passwords are embedded in the snapshot
- **Naming**: `dep-<app>-<variant>` (e.g. `dep-postgres-default`, `dep-zitadel-ssl`)
- **Scope**: One snapshot captures the entire nested PVE VM including all containers, configs, volumes, and context backup
- **Rollback**: `qm stop` → `qm rollback` → `qm start` → restore local context from VM (~30-60s for VM boot)

### When things go wrong
If a test fails and you want a clean retry:
- **Just re-run**: The runner auto-detects existing snapshots and restores dependencies from them. Only the failed target VM gets reinstalled.
- **Fresh start**: Use `--fresh` flag to rollback to baseline and wipe `.livetest-data/`. This reinstalls everything from scratch.
- **Dependencies are corrupt**: Use `--fresh` to reset to baseline.

### VM cleanup behavior
- **Target VMs**: Destroyed after test (unless `KEEP_VM=1`)
- **Dependency VMs**: Never destroyed (kept for snapshot reuse across runs)
- `KEEP_VM=1`: Prevents target VM destruction for debugging

## Notes
- The `dev` instance config is in `e2e/config.json` — it connects to the deployer at `localhost:${DEPLOYER_PORT}`
- The deployer uses `.livetest-data/` for context (not `examples/`) to isolate test state from manual use
- The PVE host is `ubuntupve` on SSH port 1022 (port-forwarded to nested VM)
- The outer PVE host is `ubuntupve` on SSH port 22 (direct, used for `qm` commands)
- Do NOT stop the deployer after the test — leave it running for subsequent tests
- After code changes that affect the deployer itself, **restart the deployer** (kill + start) so it picks up the new build
