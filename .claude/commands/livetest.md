Run a live integration test against the dev instance.

## Usage
The user provides: `$ARGUMENTS`
Format: `[--fresh] [--fix] [test-filter]` — e.g. `--fresh zitadel/default`, `--fix pgadmin`, `eclipse-mosquitto/ssl`, `--all`.

## Steps

1. **Parse arguments**: Check if `--fresh` and/or `--fix` flags are present. Remove them from the test filter.

2. **Build backend** (required — tests use compiled output):
   ```
   cd backend && pnpm run build
   ```

3. **If `--fresh`**: Rollback the nested PVE VM to baseline snapshot. This wipes ALL containers and starts from a clean Proxmox installation.
   ```
   ssh -o StrictHostKeyChecking=no root@ubuntupve 'qm stop 9000 2>/dev/null; true' && \
   ssh -o StrictHostKeyChecking=no root@ubuntupve 'qm rollback 9000 baseline' && \
   ssh -o StrictHostKeyChecking=no root@ubuntupve 'qm start 9000'
   ```
   Then wait for the nested VM to be reachable (poll SSH on port 1022, up to 60s):
   ```
   for i in $(seq 1 30); do ssh -o StrictHostKeyChecking=no -o ConnectTimeout=2 -p 1022 root@ubuntupve 'echo ok' 2>/dev/null && break; sleep 2; done
   ```
   The deployer runs locally (not in the nested VM), so no reinstall needed.

4. **Check if deployer is already running** on port 3201:
   ```
   lsof -i :3201 -sTCP:LISTEN
   ```

5. **Start deployer in background** if not running:
   ```
   cd backend && DEPLOYER_PORT=3201 node dist/oci-lxc-deployer.mjs &
   ```
   Wait 3 seconds, then verify it responds:
   ```
   curl -sk --connect-timeout 5 http://localhost:3201/api/health || curl -sk --connect-timeout 5 https://localhost:3201/api/health
   ```
   If it doesn't respond, show the error and stop.

6. **Run the livetest** (with `--fresh` removed from arguments):
   ```
   DEPLOYER_PORT=3201 npx tsx backend/tests/livetests/src/live-test-runner.mts dev <test-filter>
   ```
   Use a 10 minute timeout. Show the full output to the user.

7. **Report results** — summarize pass/fail status.

8. **If `--fix` and tests failed**: Analyze the failure, fix the code, then loop:
   1. Read the diagnostic tarball (extracted to `/tmp/`) and CLI output to identify the root cause
   2. Fix the issue in the codebase (templates, scripts, backend code, application JSON)
   3. Rebuild: `cd backend && pnpm run build`
   4. Restart the deployer if backend code changed: `kill $(lsof -ti :3201 -sTCP:LISTEN) 2>/dev/null; sleep 2; cd backend && DEPLOYER_PORT=3201 node dist/oci-lxc-deployer.mjs &`
   5. Re-run the same livetest (step 6)
   6. Repeat until all tests pass or the issue requires user input

   When analyzing failures, check these in order:
   - CLI output: look for `exitCode":1` or `"error"` in the JSON lines
   - The diagnostic tarball contains per-VM dirs with: `cli-output.log`, `lxc.conf`, `lxc.log`, `docker-ps.txt`, `docker-compose.yml`
   - Common causes: template variable not resolved, script error, container failed to start, docker service not up

## How the test runner works

### Dependencies and VM reuse
Tests declare dependencies (e.g. `gitea/default` depends on `zitadel/default` which depends on `postgres/default`). The runner resolves the full chain and creates an execution plan with VM IDs.

**VM reuse priority** (highest first):
1. **Whole-VM snapshot restore**: If a `qm snapshot` exists for the dependency chain, rollback the entire nested PVE VM (fastest)
2. **Running VM**: If the dependency container is already running inside the nested VM, reuse it as-is
3. **Fresh install**: Install the dependency from scratch

### Whole-VM snapshots (dev instance only)
- Enabled via `e2e/config.json` → `snapshot.enabled: true`
- **Created** via `qm snapshot 9000 <name> --vmstate 0` (live, ~2s, no VM stop)
- **Naming**: `dep-<app>-<variant>` (e.g. `dep-postgres-default`, `dep-zitadel-ssl`)
- **Scope**: One snapshot captures the entire nested PVE VM including all containers, configs, volumes
- **Rollback**: `qm stop` → `qm rollback` → `qm start` (~30-60s for VM boot)

### When things go wrong
If a test fails and you want a clean retry:
- **Just re-run**: The runner auto-detects existing snapshots and restores dependencies from them. Only the failed target VM gets reinstalled.
- **Fresh start**: Use `--fresh` flag to rollback to baseline. This reinstalls everything from scratch.
- **Dependencies are corrupt**: Use `--fresh` to reset to baseline.

### VM cleanup behavior
- **Target VMs**: Destroyed after test (unless `KEEP_VM=1`)
- **Dependency VMs**: Never destroyed (kept for snapshot reuse across runs)
- `KEEP_VM=1`: Prevents target VM destruction for debugging

## Notes
- The `dev` instance config is in `e2e/config.json` — it connects to the deployer at `localhost:${DEPLOYER_PORT}`
- The PVE host is `ubuntupve` on SSH port 1022 (port-forwarded to nested VM)
- The outer PVE host is `ubuntupve` on SSH port 22 (direct, used for `qm` commands)
- Do NOT stop the deployer after the test — leave it running for subsequent tests
- After code changes that affect the deployer itself, **restart the deployer** (kill + start) so it picks up the new build
