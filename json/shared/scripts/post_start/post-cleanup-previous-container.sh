#!/bin/sh
# Post-cleanup after deployer reinstall:
# 1) Write deployer-instance marker to new container's notes
# 2) Determine redirect URL (HTTPS if certs exist, else HTTP)
# 3) Schedule async cleanup of previous container
#
# Requires:
#   - previous_vm_id: Previous container to clean up (required)
#   - vm_id: New container ID (required)
#   - http_port: HTTP port (default 3000)
#   - https_port: HTTPS port (default 3443)

set -eu

PREVIOUS_VMID="{{ previous_vm_id }}"
NEW_VMID="{{ vm_id }}"
HTTP_PORT="{{ http_port }}"
HTTPS_PORT="{{ https_port }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$PREVIOUS_VMID" ] || [ "$PREVIOUS_VMID" = "NOT_DEFINED" ] || [ "$PREVIOUS_VMID" = "0" ]; then
  fail "previous_vm_id is required and must be non-zero"
fi
if [ -z "$NEW_VMID" ] || [ "$NEW_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$HTTP_PORT" = "NOT_DEFINED" ]; then HTTP_PORT="3000"; fi
if [ "$HTTPS_PORT" = "NOT_DEFINED" ]; then HTTPS_PORT="3443"; fi

CONFIG_DIR="/etc/pve/lxc"
NEW_CONF="${CONFIG_DIR}/${NEW_VMID}.conf"

if [ ! -f "$NEW_CONF" ]; then
  fail "New container config not found: $NEW_CONF"
fi

# ─── Step 1: Write deployer-instance marker to new container's notes ─────────
# Read and decode current description from Proxmox config.
# PVE stores descriptions in two formats:
#   Format 1: "description: URL-encoded-content" (single-line, + for spaces)
#   Format 2: "#URL-encoded-line" comment lines at the top (PVE 8)
# We use Python to handle both formats reliably.
CURRENT_DESC=$(python3 -c "
import re, sys
from urllib.parse import unquote

conf_text = open('$NEW_CONF', 'r').read()

# Format 1: single-line description: field
match = re.search(r'^description:\s*(.*)$', conf_text, re.MULTILINE)
if match:
    raw = match.group(1)
    normalized = raw.replace('\\\\n', '\n')
    print(unquote(normalized.replace('+', ' ')), end='')
    sys.exit(0)

# Format 2: #-prefixed comment lines at top of file
lines = conf_text.split('\n')
desc_lines = []
for line in lines:
    if line.startswith('#'):
        desc_lines.append(unquote(line[1:]))
    elif line.strip() == '':
        continue
    else:
        break

if desc_lines:
    print('\n'.join(desc_lines), end='')
" 2>/dev/null || echo "")

if echo "$CURRENT_DESC" | grep -qi "deployer-instance"; then
  log "deployer-instance marker already present in new container notes"
else
  DEPLOYER_MARKER="<!-- oci-lxc-deployer:deployer-instance -->"
  MANAGED_MARKER="<!-- oci-lxc-deployer:managed -->"

  if echo "$CURRENT_DESC" | grep -qF "$MANAGED_MARKER"; then
    # Insert deployer-instance marker after managed marker
    NEW_DESC=$(printf '%s' "$CURRENT_DESC" | sed "s|${MANAGED_MARKER}|${MANAGED_MARKER}\n${DEPLOYER_MARKER}|")
  elif [ -n "$CURRENT_DESC" ]; then
    # No managed marker but description exists - prepend deployer-instance marker
    NEW_DESC=$(printf '%s\n%s' "$DEPLOYER_MARKER" "$CURRENT_DESC")
  else
    # Empty description - create with deployer-instance marker only
    NEW_DESC="$DEPLOYER_MARKER"
  fi

  pct set "$NEW_VMID" --description "$NEW_DESC" >&2 || log "Warning: failed to update notes with deployer-instance marker"
  log "deployer-instance marker written to container $NEW_VMID"
fi

# ─── Step 2: Determine redirect URL ─────────────────────────────────────────
# Get the IP of the new container
NEW_IP=""
ATTEMPTS=10
INTERVAL=3
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  NEW_IP=$(pct exec "$NEW_VMID" -- ip -4 -o addr show 2>/dev/null | grep -v "127.0.0.1" | awk '{print $4}' | cut -d/ -f1 | head -1 || echo "")
  if [ -n "$NEW_IP" ]; then
    break
  fi
  sleep "$INTERVAL"
  attempt=$((attempt + 1))
done

if [ -z "$NEW_IP" ]; then
  log "Warning: Could not determine IP of new container, using hostname"
  NEW_IP=$(pct exec "$NEW_VMID" -- hostname 2>/dev/null || echo "localhost")
fi

# Check if SSL certs exist in the new container
HAS_SSL=0
if pct exec "$NEW_VMID" -- test -f /etc/ssl/addon/server.crt 2>/dev/null && \
   pct exec "$NEW_VMID" -- test -f /etc/ssl/addon/server.key 2>/dev/null; then
  HAS_SSL=1
fi

if [ "$HAS_SSL" -eq 1 ]; then
  REDIRECT_URL="https://${NEW_IP}:${HTTPS_PORT}"
else
  REDIRECT_URL="http://${NEW_IP}:${HTTP_PORT}"
fi

log "Redirect URL: $REDIRECT_URL"

# ─── Step 3: Schedule async cleanup of previous container ────────────────────
log "Scheduling cleanup of previous container $PREVIOUS_VMID in 15 seconds..."
nohup sh -c "sleep 15 && pct stop $PREVIOUS_VMID 2>/dev/null; pct destroy $PREVIOUS_VMID --purge 2>/dev/null; echo 'Cleaned up container $PREVIOUS_VMID' >&2" >/dev/null 2>&1 &

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
