#!/bin/sh
# Harden the Zitadel deployment after a successful bootstrap.
#
# Zitadel is configured via YAML files on the `config` managed volume
# (written pre-start by conf-write-zitadel-yaml). The compose file is static
# except for the command line. Hardening is therefore reduced to:
#
#   1. Delete zitadel.init.yaml from the `config` volume (FirstInstance
#      bootstrap data is no longer needed and must not linger).
#   2. Rewrite the compose command: drop `--steps .../zitadel.init.yaml`
#      and switch `start-from-init` -> `start`. start-from-init is NOT
#      idempotent (unique-index errors on restart); plain `start` skips the
#      FirstInstance migration. Two narrow seds keep this independent of the
#      --tlsMode value (the SSL addon may have set it to external).
#   3. Bootstrap volume rw -> ro (PATs are written once, never rewritten).
#   4. Reduce healthcheck start_period (DB migrated, `start` is fast).
#   5. docker compose up -d --wait to apply.
#
# This script runs inside the LXC container (execute_on: lxc) and only after
# a successful bootstrap (skip_if_all_missing: zitadel_project_id). Every
# mutation is grep-guarded so re-runs (and the upgrade path, which keeps
# editing this already-hardened compose) are no-ops.
#
# Inputs:
#   compose_project     - Docker Compose project name (e.g. "zitadel")
#   zitadel_project_id  - Output from bootstrap (proves bootstrap ran)
#
# Output: errors to stderr only

COMPOSE_PROJECT="{{ compose_project }}"
ZITADEL_PROJECT_ID="{{ zitadel_project_id }}"

[ "$COMPOSE_PROJECT" = "NOT_DEFINED" ] && COMPOSE_PROJECT=""
[ "$ZITADEL_PROJECT_ID" = "NOT_DEFINED" ] && ZITADEL_PROJECT_ID=""

# Only run if bootstrap produced a project ID
if [ -z "$ZITADEL_PROJECT_ID" ]; then
  echo "No bootstrap output (zitadel_project_id), skipping hardening" >&2
  exit 0
fi

if [ -z "$COMPOSE_PROJECT" ]; then
  echo "No compose_project set, skipping hardening" >&2
  exit 0
fi

COMPOSE_DIR="/opt/docker-compose/${COMPOSE_PROJECT}"

# Support both .yaml and .yml extensions
if [ -f "${COMPOSE_DIR}/docker-compose.yaml" ]; then
  COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yaml"
elif [ -f "${COMPOSE_DIR}/docker-compose.yml" ]; then
  COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"
else
  echo "Error: Compose file not found in: $COMPOSE_DIR" >&2
  exit 1
fi

echo "Hardening Zitadel at ${COMPOSE_FILE}..." >&2

# --- 1. Delete the FirstInstance bootstrap config from the volume ---
# The container mounts /config read-only, but the LXC itself sees it rw.
if [ -f /config/zitadel.init.yaml ]; then
  rm -f /config/zitadel.init.yaml
  echo "  Removed /config/zitadel.init.yaml" >&2
else
  echo "  /config/zitadel.init.yaml already absent (no change)" >&2
fi

# --- 2a. Drop the init.yaml --steps argument from the command ---
if grep -q -- '--steps /zitadel/config/zitadel.init.yaml' "$COMPOSE_FILE"; then
  sed -i 's| --steps /zitadel/config/zitadel.init.yaml||g' "$COMPOSE_FILE"
  echo "  Removed --steps zitadel.init.yaml from command" >&2
else
  echo "  init.yaml --steps already removed (no change)" >&2
fi

# --- 2b. start-from-init -> start ---
if grep -q 'start-from-init' "$COMPOSE_FILE"; then
  sed -i 's/start-from-init/start/g' "$COMPOSE_FILE"
  echo "  Changed command: start-from-init -> start" >&2
else
  echo "  Command already uses 'start' (no change)" >&2
fi

# --- 3. Bootstrap volume rw -> ro ---
if grep -q '/bootstrap:/zitadel/bootstrap"' "$COMPOSE_FILE" 2>/dev/null || \
   grep -qE '/bootstrap:/zitadel/bootstrap$' "$COMPOSE_FILE" 2>/dev/null; then
  sed -i 's|/bootstrap:/zitadel/bootstrap"|/bootstrap:/zitadel/bootstrap:ro"|g' "$COMPOSE_FILE"
  sed -i 's|/bootstrap:/zitadel/bootstrap$|/bootstrap:/zitadel/bootstrap:ro|g' "$COMPOSE_FILE"
  echo "  Changed bootstrap volume to :ro" >&2
else
  echo "  Bootstrap volume already :ro or not found (no change)" >&2
fi

# --- 4. Reduce healthcheck start_period for production mode ---
if grep -q 'start_period:.*300s' "$COMPOSE_FILE" 2>/dev/null; then
  sed -i 's/start_period:.*300s/start_period: 30s/' "$COMPOSE_FILE"
  echo "  Reduced healthcheck start_period to 30s" >&2
fi

# --- 5. Restart with hardened config ---
echo "Restarting Docker Compose with hardened config..." >&2
cd "$COMPOSE_DIR"

if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose > /dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' found" >&2
  exit 1
fi

$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --wait --wait-timeout 120

echo "Zitadel hardened successfully" >&2
