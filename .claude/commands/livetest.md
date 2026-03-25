Run a live integration test against the dev instance.

## Usage
The user provides: `$ARGUMENTS`
Format: `[test-filter]` — e.g. `eclipse-mosquitto/ssl`, `--all`, or empty for all tests.

## Steps

1. **Build backend** (required — tests use compiled output):
   ```
   cd backend && pnpm run build
   ```

2. **Check if deployer is already running** on port 3201:
   ```
   lsof -i :3201 -sTCP:LISTEN
   ```

3. **Start deployer in background** if not running:
   ```
   cd backend && DEPLOYER_PORT=3201 node dist/oci-lxc-deployer.mjs &
   ```
   Wait 3 seconds, then verify it responds:
   ```
   curl -sk --connect-timeout 5 http://localhost:3201/api/health || curl -sk --connect-timeout 5 https://localhost:3201/api/health
   ```
   If it doesn't respond, show the error and stop.

4. **Run the livetest**:
   ```
   DEPLOYER_PORT=3201 npx tsx backend/tests/livetests/src/live-test-runner.mts dev $ARGUMENTS
   ```
   Use a 10 minute timeout. Show the full output to the user.

5. **Report results** — summarize pass/fail status.

## Notes
- The `dev` instance config is in `e2e/config.json` — it connects to the deployer at `localhost:${DEPLOYER_PORT}`
- The PVE host is `ubuntupve` on SSH port 1022
- Do NOT stop the deployer after the test — leave it running for subsequent tests
