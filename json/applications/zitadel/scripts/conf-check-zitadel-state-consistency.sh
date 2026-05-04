#!/bin/sh
# Pre-compose drift check between postgres zitadel DB and bootstrap PATs.
#
# Two drift directions are caught:
#
#   DB events present + login-client.pat missing
#     zitadel-api treats the DB as already-initialized and skips
#     FirstInstance migration, so the PAT is never (re-)written. The
#     zitadel-login container then hangs forever waiting for the file.
#
#   PAT(s) present + DB missing/empty
#     Orphan tokens from a previous deploy whose DB was wiped underneath.
#     zitadel-api would re-init and overwrite them.
#
# admin-client.pat may be absent on purpose (post-deploy hardening removes
# it). Its presence implies the DB must exist.
set -eu

VMID="{{ vm_id }}"

PG_VMID=$(pct list | awk '$NF=="postgres"{print $1; exit}')
if [ -z "$PG_VMID" ]; then
  echo "  No postgres container found — first ever deploy, skipping drift check" >&2
  echo '[{"id":"zitadel_state_check","value":"skipped-no-postgres"}]'
  exit 0
fi
echo "  Postgres container: VMID $PG_VMID" >&2

EVENTS=$(pct exec "$PG_VMID" -- su postgres -c \
  "psql -d zitadel -tAc 'SELECT COUNT(*) FROM eventstore.events2'" 2>/dev/null \
  | tr -d '[:space:]' || true)

if echo "${EVENTS:-}" | grep -qE '^[0-9]+$'; then
  EVENTS_COUNT="$EVENTS"
  DB_STATE="exists"
else
  EVENTS_COUNT=0
  DB_STATE="missing"
fi

HAS_LOGIN_PAT=no
HAS_ADMIN_PAT=no
if pct exec "$VMID" -- sh -c "[ -f /bootstrap/login-client.pat ]" 2>/dev/null; then
  HAS_LOGIN_PAT=yes
fi
if pct exec "$VMID" -- sh -c "[ -f /bootstrap/admin-client.pat ]" 2>/dev/null; then
  HAS_ADMIN_PAT=yes
fi

echo "  zitadel DB:               $DB_STATE (events=$EVENTS_COUNT)" >&2
echo "  /bootstrap/login-client.pat: $HAS_LOGIN_PAT" >&2
echo "  /bootstrap/admin-client.pat: $HAS_ADMIN_PAT" >&2

ERR=0

if [ "$DB_STATE" = "exists" ] && [ "$EVENTS_COUNT" -gt 0 ] && [ "$HAS_LOGIN_PAT" = "no" ]; then
  echo "" >&2
  echo "ERROR: zitadel DB has $EVENTS_COUNT events but login-client.pat is missing." >&2
  echo "  zitadel-api will skip the FirstInstance migration, so the login-client" >&2
  echo "  PAT will not be (re-)created and zitadel-login will hang forever." >&2
  echo "" >&2
  echo "Fix: drop the zitadel DB, destroy this container, and redeploy." >&2
  echo "  pct exec $PG_VMID -- su postgres -c \"psql -c 'DROP DATABASE zitadel WITH (FORCE); CREATE DATABASE zitadel OWNER zitadel;'\"" >&2
  echo "  pct stop $VMID && pct destroy $VMID --purge --force" >&2
  echo "  ./production/setup-production.sh --step 10" >&2
  ERR=1
fi

if [ "$HAS_LOGIN_PAT" = "yes" ] && [ "$DB_STATE" = "missing" ]; then
  echo "" >&2
  echo "ERROR: login-client.pat exists in /bootstrap but the zitadel DB does not." >&2
  echo "  These PATs are orphans from a previous deploy whose DB was wiped." >&2
  echo "  Remove the PATs (or restore the DB) before continuing." >&2
  ERR=1
fi

if [ "$HAS_ADMIN_PAT" = "yes" ] && [ "$DB_STATE" = "missing" ]; then
  echo "" >&2
  echo "ERROR: admin-client.pat exists in /bootstrap but the zitadel DB does not." >&2
  echo "  Orphan PAT. Remove it (or restore the DB) before continuing." >&2
  ERR=1
fi

if [ "$ERR" -ne 0 ]; then
  exit 1
fi

echo "  state is consistent — proceeding" >&2
echo '[{"id":"zitadel_state_check","value":"ok"}]'
