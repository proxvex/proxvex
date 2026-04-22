#!/bin/sh
# Set up two local oci-lxc-deployer instances — one Hub, one Spoke —
# running from the current source tree. Used to verify the Spoke Hub-sync
# path without needing the production Hub on pve1.cluster.
#
# Layout created in the repo root:
#   .dev/
#     hub/
#       data/                  # storagecontext.json + secret.txt for the Hub
#       local/                 # Hub's local overrides (seeded with a marker)
#         shared/
#           DEV-HUB-MARKER.md  # file that proves repo-sync reached the Spoke
#     spoke/
#       data/                  # Spoke's own context (minimal — state on Hub)
#       local/                 # Spoke's own local (populated by Hub-sync)
#
# Ports:
#   Hub   → 3301
#   Spoke → 3302 (with HUB_URL=http://localhost:3301)
#
# Auth mode: **no OIDC** for these dev instances (addons are enabled on
# demand, not in setup). Hub's Bearer auth is off, so the Spoke talks to it
# unauthenticated.
#
# SSH config: both instances target the nested VM at ubuntupve:1022. This
# script prerequisites key-based SSH to that host — it DOES NOT set up SSH
# keys (that's your local ssh-key setup).
#
# Usage:
#   ./scripts/dev-hub-spoke-setup.sh [--reset]
#
# Flags:
#   --reset   Delete .dev/ and re-create everything from scratch.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV="$ROOT/.dev"
HUB_DIR="$DEV/hub"
SPOKE_DIR="$DEV/spoke"
HUB_PORT=3301
SPOKE_PORT=3302
NESTED_SSH_HOST="ubuntupve"
NESTED_SSH_PORT=1022

say() { printf "  %s\n" "$*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- flag parsing ---
RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    *) die "Unknown flag: $arg" ;;
  esac
done

[ -f "$ROOT/backend/dist/oci-lxc-deployer.mjs" ] || die \
  "backend/dist/oci-lxc-deployer.mjs missing — run 'cd backend && pnpm run build' first."

if [ "$RESET" -eq 1 ] && [ -d "$DEV" ]; then
  say "Wiping .dev/"
  rm -rf "$DEV"
fi

# --- 1. Directories ---
say "Creating directories"
mkdir -p \
  "$HUB_DIR/data" "$HUB_DIR/local/shared" \
  "$SPOKE_DIR/data" "$SPOKE_DIR/local"

# --- 2. Marker file in the Hub's local/shared ---
#     When the Spoke syncs, this file must show up at
#     .dev/spoke/local/.hubs/<hub-id>/local/shared/DEV-HUB-MARKER.md
MARKER="$HUB_DIR/local/shared/DEV-HUB-MARKER.md"
if [ ! -f "$MARKER" ]; then
  say "Writing Hub marker: $MARKER"
  cat > "$MARKER" <<'MD'
# Dev-Hub Marker

This file lives in the **Hub's** `local/shared/` and should appear in the
**Spoke's** synced workspace after a `POST /api/spoke/sync`.

If you see this file under `.dev/spoke/local/.hubs/<hub-id>/local/shared/`
then the repositories tarball from `GET /api/hub/repositories.tar.gz`
reached the Spoke and was extracted correctly.
MD
fi

# --- 3. SSH connectivity precondition (no password) ---
say "Checking passwordless SSH to ${NESTED_SSH_HOST}:${NESTED_SSH_PORT}..."
if ssh -o BatchMode=yes -o ConnectTimeout=4 -o StrictHostKeyChecking=no \
    -p "$NESTED_SSH_PORT" "root@${NESTED_SSH_HOST}" 'echo ok' 2>/dev/null | \
    grep -q '^ok$'; then
  say "  SSH OK (key-based)."
else
  echo "" >&2
  echo "WARNING: passwordless SSH to root@${NESTED_SSH_HOST}:${NESTED_SSH_PORT} failed." >&2
  echo "Deploy your public key with:" >&2
  echo "    ssh-copy-id -p ${NESTED_SSH_PORT} root@${NESTED_SSH_HOST}" >&2
  echo "  (you'll be prompted for the nested-VM root password once)" >&2
  echo "" >&2
fi

# --- 4. Write minimal plaintext storagecontext.json for each instance ---
#     DEPLOYER_PLAINTEXT_CONTEXT=1 is set in the start scripts so these are
#     read as-is without decryption. The only content is an SSH entry for
#     the nested VM; everything else (stacks, CA) is created at runtime
#     when the user triggers it via UI or addons.

write_plaintext_ctx() {
  dir="$1"
  ctx="$dir/data/storagecontext.json"
  if [ -f "$ctx" ]; then
    say "  $(basename "$dir")/data/storagecontext.json already exists — leaving untouched"
    return
  fi
  say "  Writing $ctx"
  cat > "$ctx" <<JSON
{
  "sshs": [
    { "host": "${NESTED_SSH_HOST}", "port": ${NESTED_SSH_PORT}, "current": true }
  ],
  "stacks": {},
  "cas": {}
}
JSON
}

write_secret() {
  dir="$1"
  sec="$dir/data/secret.txt"
  if [ -f "$sec" ]; then
    return
  fi
  say "  Writing $(basename "$dir")/data/secret.txt"
  # Random 32-byte hex for encryption even if we run plaintext today
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$sec"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$sec"
  fi
  chmod 600 "$sec"
}

say "Seeding Hub context"
write_plaintext_ctx "$HUB_DIR"
write_secret "$HUB_DIR"

say "Seeding Spoke context"
write_plaintext_ctx "$SPOKE_DIR"
write_secret "$SPOKE_DIR"

# --- 5. Generate start scripts ---
say "Writing start scripts"

cat > "$DEV/start-hub.sh" <<SH
#!/bin/sh
# Starts the Dev-Hub on port ${HUB_PORT}.
set -eu
ROOT=$ROOT
HUB=$HUB_DIR
export DEPLOYER_PLAINTEXT_CONTEXT=1
export DEPLOYER_PORT=${HUB_PORT}
cd "\$ROOT/backend"
exec node dist/oci-lxc-deployer.mjs \\
  --local "\$HUB/local" \\
  --storageContextFilePath "\$HUB/data/storagecontext.json" \\
  --secretsFilePath "\$HUB/data/secret.txt"
SH
chmod +x "$DEV/start-hub.sh"

cat > "$DEV/start-spoke.sh" <<SH
#!/bin/sh
# Starts the Dev-Spoke on port ${SPOKE_PORT}, wired to the local Hub at
# http://localhost:${HUB_PORT}. The Spoke fetches repositories from the Hub
# on startup (bootstrap-sync, Non-OIDC mode) and pipes them into
# \$SPOKE_DIR/local/.hubs/<hub-id>/.
set -eu
ROOT=$ROOT
SPOKE=$SPOKE_DIR
export DEPLOYER_PLAINTEXT_CONTEXT=1
export DEPLOYER_PORT=${SPOKE_PORT}
export HUB_URL=http://localhost:${HUB_PORT}
export LXC_MANAGER_LOCAL_PATH="\$SPOKE/local"
cd "\$ROOT/backend"
exec node dist/oci-lxc-deployer.mjs \\
  --local "\$SPOKE/local" \\
  --storageContextFilePath "\$SPOKE/data/storagecontext.json" \\
  --secretsFilePath "\$SPOKE/data/secret.txt"
SH
chmod +x "$DEV/start-spoke.sh"

# --- 6. Unset the EXIT trap because there wasn't one; just say done ---
echo ""
echo "=== Setup complete ==="
echo ""
echo "Two terminals:"
echo "  1) ./.dev/start-hub.sh      (Hub on http://localhost:${HUB_PORT})"
echo "  2) ./.dev/start-spoke.sh    (Spoke on http://localhost:${SPOKE_PORT})"
echo ""
echo "Then verify Spoke sync:"
echo "  curl -s http://localhost:${SPOKE_PORT}/api/spoke/sync | python3 -m json.tool"
echo "  ls -la .dev/spoke/local/.hubs/*/local/shared/"
echo ""
echo "Expected: DEV-HUB-MARKER.md appears in the Spoke's .hubs/<id>/local/shared/"
