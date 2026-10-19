#!/bin/sh
# Set KEY=VALUE in the compose project's .env inside the LXC
# (/opt/docker-compose/<project>/.env, written by post-upload-docker-compose-files.sh)
# and apply it. Default: `docker compose up -d` in the project directory —
# compose re-interpolates the .env and recreates only services whose config
# changed (`restart` would NOT: it keeps the old container config). Without -f
# compose also loads docker-compose.override.yml (IPv6, compose-ipv6.sh), like
# the ssl-proxy on-start hook. An app that runs its own stack names its own
# after_command; "none" skips the step.
# Runs on PVE host (execute_on: ve).
#
# Inputs (substituted by deployer):
#   {{ vm_id }}, {{ compose_project }}, {{ env_key }},
#   {{ new_value_b64 }}, {{ after_command_b64 }}   (base64: secrets may contain
#   quotes, $ or backslashes that must not reach the shell unescaped)
#
# Output: JSON on stdout, logs on stderr.

set -u

VM_ID="{{ vm_id }}"
COMPOSE_PROJECT="{{ compose_project }}"
ENV_KEY="{{ env_key }}"
NEW_VALUE_B64="{{ new_value_b64 }}"
AFTER_B64="{{ after_command_b64 }}"

log() { echo "$@" >&2; }
fail() {
  log "ERROR: $1"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"%s"}]\n' "$1"
  exit 1
}

case "$ENV_KEY" in
  ''|*[!A-Za-z0-9_]*) fail "invalid env key" ;;
esac

NEW_VALUE=$(printf '%s' "$NEW_VALUE_B64" | base64 -d) || fail "value not decodable"
case "$NEW_VALUE" in
  *"
"*) fail "value contains a newline (not representable in .env)" ;;
esac
AFTER_COMMAND=$(printf '%s' "$AFTER_B64" | base64 -d 2>/dev/null || true)

if ! pct status "$VM_ID" 2>/dev/null | grep -q running; then
  fail "container not running - start it, then refresh again"
fi

ENV_FILE="/opt/docker-compose/${COMPOSE_PROJECT}/.env"
TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.new"' EXIT

if ! pct exec "$VM_ID" -- cat "$ENV_FILE" > "$TMP" 2>/dev/null; then
  fail "no .env at ${ENV_FILE}"
fi

# Replace the first KEY= line (drop further duplicates), append when missing.
NEW_VALUE="$NEW_VALUE" awk -v key="$ENV_KEY" '
  BEGIN { done = 0; line = key "=" ENVIRON["NEW_VALUE"] }
  index($0, key "=") == 1 { if (!done) { print line; done = 1 } ; next }
  { print }
  END { if (!done) print line }
' "$TMP" > "$TMP.new" || fail "patch failed"

# cp -p keeps owner and mode of the original; then overwrite and move in place.
if ! pct exec "$VM_ID" -- sh -c "cp -p '$ENV_FILE' '$ENV_FILE.refresh' && cat > '$ENV_FILE.refresh' && mv '$ENV_FILE.refresh' '$ENV_FILE'" < "$TMP.new"; then
  fail "writing ${ENV_FILE} failed"
fi
log "Set ${ENV_KEY} in ${ENV_FILE}"

if [ -z "$AFTER_COMMAND" ]; then
  AFTER_COMMAND="cd '/opt/docker-compose/${COMPOSE_PROJECT}' && if command -v docker-compose >/dev/null 2>&1; then docker-compose up -d; else docker compose up -d; fi"
elif [ "$AFTER_COMMAND" = "none" ]; then
  AFTER_COMMAND=""
fi

if [ -n "$AFTER_COMMAND" ]; then
  log "Running after_command in container $VM_ID"
  if pct exec "$VM_ID" -- sh -c "$AFTER_COMMAND" >&2; then
    printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_restarted","value":"true"}]\n'
  else
    # Like compose-env when the restart fails: the file IS patched, so report
    # ok (the stack must store the value, or the next reconfigure would write
    # the old one back) and say what is left to do.
    log "WARNING: after_command failed - .env is patched but not applied"
    printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_restarted","value":"false"},{"id":"refresh_detail","value":"patched .env; applying it failed - run docker compose up -d in the LXC"}]\n'
  fi
else
  printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_restarted","value":"false"}]\n'
fi
