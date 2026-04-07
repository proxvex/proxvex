#!/bin/sh
# Harden Zitadel Docker Compose after successful bootstrap.
#
# Modifies the deployed docker-compose.yaml inside the LXC container:
#   1. Changes command from 'start-from-init' to 'start'
#      (start-from-init is NOT idempotent and causes unique index errors on restart)
#   2. Changes bootstrap volume from :rw to :ro for zitadel-api
#   3. Removes ZITADEL_FIRSTINSTANCE_* environment variables (no longer needed)
#   4. Removes tmpfs mount for admin PAT (no longer needed after bootstrap)
#   5. Reduces healthcheck start_period (fast startup with 'start' command)
#   6. Runs 'docker compose up -d' to apply changes
#
# This script runs inside the LXC container (execute_on: lxc).
#
# Inputs:
#   compose_project        - Docker Compose project name (e.g. "zitadel")
#   zitadel_project_id     - Output from bootstrap (proves bootstrap ran)
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

echo "Hardening Zitadel compose at ${COMPOSE_FILE}..." >&2

# --- 1. Change 'start-from-init' to 'start' ---
if grep -q "start-from-init" "$COMPOSE_FILE"; then
  sed -i 's/start-from-init/start/g' "$COMPOSE_FILE"
  echo "  Changed command: start-from-init -> start" >&2
else
  echo "  Command already uses 'start' (no change needed)" >&2
fi

# --- 2. Change bootstrap volume to :ro for zitadel-api ---
# Match lines like: - /bootstrap:/zitadel/persistent (without :ro)
# But NOT lines that already have :ro
if grep -q "/bootstrap:/zitadel/persistent$" "$COMPOSE_FILE" 2>/dev/null || \
   grep -q '/bootstrap:/zitadel/persistent"' "$COMPOSE_FILE" 2>/dev/null; then
  sed -i "s|/bootstrap:/zitadel/persistent\"|/bootstrap:/zitadel/persistent:ro\"|g" "$COMPOSE_FILE"
  sed -i "s|/bootstrap:/zitadel/persistent$|/bootstrap:/zitadel/persistent:ro|g" "$COMPOSE_FILE"
  echo "  Changed zitadel-api bootstrap volume to :ro" >&2
else
  echo "  Bootstrap volume already :ro or not found (no change)" >&2
fi

# --- 3. Remove ZITADEL_FIRSTINSTANCE_* environment variables ---
REMOVED=$(grep -c "ZITADEL_FIRSTINSTANCE_" "$COMPOSE_FILE" 2>/dev/null || echo "0")
if [ "$REMOVED" -gt 0 ]; then
  sed -i '/ZITADEL_FIRSTINSTANCE_/d' "$COMPOSE_FILE"
  echo "  Removed ${REMOVED} ZITADEL_FIRSTINSTANCE_* env vars" >&2
fi

# --- 4. Remove tmpfs mount for admin-client.pat ---
# The admin PAT is on a Docker tmpfs (/zitadel/tmp) and disappears on container
# restart. Remove the tmpfs directive so it cannot reappear on future restarts.
if grep -q '/zitadel/tmp' "$COMPOSE_FILE" 2>/dev/null; then
  sed -i '/\/zitadel\/tmp/d' "$COMPOSE_FILE"
  # Remove empty tmpfs: section if no entries remain
  sed -i '/^[[:space:]]*tmpfs:$/{ N; /^[[:space:]]*tmpfs:\n$/d; }' "$COMPOSE_FILE"
  echo "  Removed tmpfs mount for admin PAT" >&2
else
  echo "  tmpfs mount already removed (no change)" >&2
fi

# --- 5. Reduce healthcheck start_period for production mode ---
# After init, Zitadel starts much faster with 'start' command (DB already set up).
# Reduce start_period from 300s to 30s to avoid long waits on restart.
if grep -q 'start_period:.*300s' "$COMPOSE_FILE" 2>/dev/null; then
  sed -i 's/start_period:.*300s/start_period: 30s/' "$COMPOSE_FILE"
  echo "  Reduced healthcheck start_period to 30s" >&2
fi

# --- 6. Restart with hardened config ---
echo "Restarting Docker Compose with hardened config..." >&2
cd "$COMPOSE_DIR"

# Detect docker compose command
if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose > /dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' found" >&2
  exit 1
fi

$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --wait --wait-timeout 120

echo "Zitadel compose hardened successfully" >&2
