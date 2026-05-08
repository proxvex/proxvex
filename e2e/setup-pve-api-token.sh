#!/bin/bash
# setup-pve-api-token.sh — one-time bootstrap so the dev machine can drive
# `qm` operations against a PVE host through the REST API instead of SSH.
#
# Phase A2 of the runner-isolation work shipped this for the CI runner LXC
# (install-ci.sh + entrypoint-{root,runner}.sh). This script is the same
# wiring for an interactive operator: after one run, lib/pve-ops.sh
# auto-detects the staged token and step2a/step2b stop emitting
# "Permanently added '<host>' to the list of known hosts" warnings.
#
# Idempotent: if the local token file already exists we keep it and just
# refresh the ACL + CA. Pass --rotate to delete and recreate the token
# (use this when the file got lost or you want to invalidate it).
#
# Usage:
#   ./setup-pve-api-token.sh <pve-host> [--user <name>] [--token <name>] [--rotate]
#
# Defaults:
#   --user   proxvex-runner@pam       (matches install-ci.sh's runner user)
#   --token  dev-<short-hostname>     (per-dev-machine — distinct from the CI runner's
#                                      'runner-token', so rotating one does not
#                                      invalidate the other)
#
# What it writes locally:
#   ~/.config/proxvex/pve-api-token   shell-sourceable: PVE_API_TOKEN_ID=…
#                                                       PVE_API_TOKEN_SECRET=…
#   ~/.config/proxvex/pve-root-ca.pem PEM-encoded PVE root CA (curl --cacert)
#
# Both are picked up automatically by lib/pve-ops.sh on the next step2a/2b run.

set -e

_usage() { sed -n '2,/^set -e/p' "$0" | sed 's/^# \?//'; }

# Match --help/-h before the positional check so the dispatch works for
# `setup-pve-api-token.sh --help` (no PVE host argument).
case "${1:-}" in --help|-h) _usage; exit 0 ;; esac
[ "$#" -ge 1 ] || { _usage; exit 1; }
PVE_HOST="$1"; shift

USER_ID="proxvex-runner@pam"
TOKEN_NAME="dev-$(hostname -s | tr '[:upper:]' '[:lower:]')"
ROTATE=false
ROLE="PVEVMAdmin"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --user)   USER_ID="$2"; shift 2 ;;
        --token)  TOKEN_NAME="$2"; shift 2 ;;
        --rotate) ROTATE=true; shift ;;
        --help|-h) _usage; exit 0 ;;
        *) echo "[ERROR] unknown arg: $1" >&2; exit 1 ;;
    esac
done

CONF_DIR="$HOME/.config/proxvex"
TOKEN_FILE="$CONF_DIR/pve-api-token"
CA_FILE="$CONF_DIR/pve-root-ca.pem"
mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"

# LogLevel=ERROR suppresses the "Permanently added" line — same noise
# fix that lib/pve-ops.sh applies to its own SSH fallback.
SSH_OPTS=( -o StrictHostKeyChecking=no
           -o UserKnownHostsFile=/dev/null
           -o LogLevel=ERROR
           -o BatchMode=yes
           -o ConnectTimeout=10 )
TOKEN_ID="${USER_ID}!${TOKEN_NAME}"

info() { echo "[INFO] $*"; }
ok()   { echo "[OK] $*"; }
err()  { echo "[ERROR] $*" >&2; exit 1; }

info "PVE host: $PVE_HOST"
info "Token ID: $TOKEN_ID"

# Step 1: ensure the user account exists. `pveum user add` errors when the
# user is already there; ignoring that is the simplest idempotent form.
ssh "${SSH_OPTS[@]}" "root@$PVE_HOST" \
    "pveum user add '$USER_ID' --comment 'proxvex E2E API token holder' 2>/dev/null || true" \
    || err "could not contact $PVE_HOST"

# Step 2: ensure the token exists remotely AND that we have its secret
# locally. Three states to reconcile:
#   A. local file present + remote token present  → enforce privsep=0
#   B. local file missing OR --rotate              → drop+recreate, save secret
#   C. local file present + remote token missing  → recreate
# (C) happens after a previously-failed bootstrap leaves a half-staged file.
# The cheap detector is `pveum user token modify`: it errors with "no such
# token" when the remote is gone, which we use to fall through to recreate.
#
# --privsep 0: the token inherits the user's full privileges. We dedicate
# proxvex-runner@pam to token-only use (it's never used for login), so
# inheritance keeps the ACL surface to a single line. Going with privsep=1
# splits ACLs across user AND token (intersection model), and hides
# silent-syntax-error footguns (`-token` vs `-tokens`) that bite on
# reruns: the token ends up unprivileged and step2a hits 403.

create_token_remote() {
    SECRET=$(ssh "${SSH_OPTS[@]}" "root@$PVE_HOST" "
        pveum user token remove '$USER_ID' '$TOKEN_NAME' 2>/dev/null || true
        pveum user token add '$USER_ID' '$TOKEN_NAME' --privsep 0 --output-format json \
            | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"value\"])'
    ") || err "failed to create token $TOKEN_ID on $PVE_HOST"
    [ -n "$SECRET" ] || err "pveum did not return a token secret — check $PVE_HOST logs"

    umask 077
    cat > "$TOKEN_FILE" <<EOF
PVE_API_TOKEN_ID='$TOKEN_ID'
PVE_API_TOKEN_SECRET='$SECRET'
EOF
    ok "Token saved to $TOKEN_FILE"
}

if [ "$ROTATE" = "true" ] || [ ! -s "$TOKEN_FILE" ]; then
    info "Creating API token (existing token of the same name will be replaced)..."
    create_token_remote
else
    # privsep=0 modify doubles as remote-existence probe AND idempotent
    # privsep correction for tokens left over from older script versions.
    if ssh "${SSH_OPTS[@]}" "root@$PVE_HOST" \
        "pveum user token modify '$USER_ID' '$TOKEN_NAME' --privsep 0 >/dev/null 2>&1"; then
        info "Reusing existing token at $TOKEN_FILE (pass --rotate to refresh)"
    else
        info "Local token file references a token that no longer exists on $PVE_HOST — recreating..."
        create_token_remote
    fi
fi

# Step 4: ACL on the user. With --privsep 0 the token inherits these privs
# in full. Note the plural flag forms (`--users`, `--roles`) — pveum's
# singular aliases are silent-no-ops on some PVE versions, which is what
# left earlier runs of this script with a token that authenticated but
# couldn't read /qemu/<vmid>/snapshot.
ssh "${SSH_OPTS[@]}" "root@$PVE_HOST" \
    "pveum acl modify / --users '$USER_ID' --roles '$ROLE' --propagate 1 >/dev/null" \
    || err "failed to set ACL on $PVE_HOST"
ok "ACL: $USER_ID has role $ROLE on / (propagate=1); token inherits via privsep=0"

# Step 5: refresh root CA. Cheap to redo on every invocation; covers cert
# rotation on the PVE side without a separate flag.
ssh "${SSH_OPTS[@]}" "root@$PVE_HOST" "cat /etc/pve/pve-root-ca.pem" > "$CA_FILE" \
    || err "failed to read /etc/pve/pve-root-ca.pem on $PVE_HOST"
chmod 644 "$CA_FILE"
ok "PVE root CA saved to $CA_FILE"

# Step 6: end-to-end verification — does the API actually accept this token,
# AND does it have the privileges step2a needs?
#
# /api2/json/version only proves the token is recognized (any auth'd identity
# passes). To catch ACL misconfiguration we also probe
# /access/permissions, which echoes the token's effective ACLs.
# shellcheck disable=SC1090
. "$TOKEN_FILE"
AUTH_HDR="Authorization: PVEAPIToken=${PVE_API_TOKEN_ID}=${PVE_API_TOKEN_SECRET}"
curl -fsS --cacert "$CA_FILE" -H "$AUTH_HDR" \
    "https://${PVE_HOST}:8006/api2/json/version" >/dev/null \
    || err "API authentication failed (token+CA mismatch?) — see $TOKEN_FILE / $CA_FILE"

PERMS=$(curl -fsS --cacert "$CA_FILE" -H "$AUTH_HDR" \
    "https://${PVE_HOST}:8006/api2/json/access/permissions") \
    || err "GET /access/permissions failed — token cannot inspect its own ACLs"

# A correctly-wired token shows `"VM.Audit":1` etc on `/` (or on /vms). If
# it just shows `{}` the ACL didn't apply.
if echo "$PERMS" | python3 -c 'import sys,json
data=json.load(sys.stdin).get("data") or {}
need=["VM.Audit","VM.PowerMgmt","VM.Snapshot"]
for path,perms in data.items():
    if all(perms.get(p)==1 for p in need):
        print("authz_ok"); sys.exit(0)
sys.exit(1)' 2>/dev/null | grep -q authz_ok; then
    ok "API token verified (auth + VM.Audit/PowerMgmt/Snapshot present)"
else
    echo "[ERROR] token authenticated but lacks VM.Audit/PowerMgmt/Snapshot." >&2
    echo "        Effective permissions reported by PVE:" >&2
    echo "$PERMS" | python3 -m json.tool >&2 || echo "$PERMS" >&2
    err "ACL misconfiguration — re-run with --rotate, or fix manually on $PVE_HOST"
fi

cat <<MSG

Done. lib/pve-ops.sh auto-loads these files on the next step2a/step2b run:
   $TOKEN_FILE
   $CA_FILE

Verify by re-running:
   ./step2a-setup-mirrors.sh green
The 'Permanently added' warnings should be gone — qm operations now go
through https://$PVE_HOST:8006/api2/json instead of SSH.
MSG
