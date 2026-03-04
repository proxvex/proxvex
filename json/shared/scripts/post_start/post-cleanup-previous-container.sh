#!/bin/sh
# Post-cleanup after deployer reinstall:
# 1) Write deployer-instance marker to new container's notes
# 2) Determine redirect URL (HTTPS if certs exist, else HTTP)
# 3) Schedule async cleanup of previous container
#
# Requires:
#   - previous_vm_id: Previous container to clean up (required)
#   - vm_id: New container ID (required)
#   - hostname: Hostname of the new container (required)
#   - http_port: HTTP port (default 3000)
#   - https_port: HTTPS port (default 3443)
#   - deployer_base_url: External URL (optional, e.g. https://deployer.example.com)

set -eu

PREVIOUS_VMID="{{ previous_vm_id }}"
NEW_VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
HTTP_PORT="{{ http_port }}"
HTTPS_PORT="{{ https_port }}"
DEPLOYER_BASE_URL="{{ deployer_base_url }}"

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

# ─── Step 2: Determine redirect URL and wait for service ─────────────────────
if [ -n "$DEPLOYER_BASE_URL" ] && [ "$DEPLOYER_BASE_URL" != "NOT_DEFINED" ]; then
  # Use configured external URL (handles reverse proxy / nginx)
  REDIRECT_URL="$DEPLOYER_BASE_URL"
else
  # Fallback: build URL from hostname + port with SSL detection
  HAS_SSL=0
  if pct exec "$NEW_VMID" -- test -f /etc/ssl/addon/server.crt 2>/dev/null && \
     pct exec "$NEW_VMID" -- test -f /etc/ssl/addon/server.key 2>/dev/null; then
    HAS_SSL=1
  fi

  if [ "$HAS_SSL" -eq 1 ]; then
    REDIRECT_URL="https://${HOSTNAME}:${HTTPS_PORT}"
  else
    REDIRECT_URL="http://${HOSTNAME}:${HTTP_PORT}"
  fi
fi

# Wait for the service to actually respond before redirecting
log "Waiting for service at $REDIRECT_URL ..."
ATTEMPTS=30
INTERVAL=2
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  if curl -sk --connect-timeout 2 --max-time 5 -o /dev/null "$REDIRECT_URL" 2>/dev/null; then
    log "Service responding at $REDIRECT_URL"
    break
  fi
  sleep "$INTERVAL"
  attempt=$((attempt + 1))
done

if [ "$attempt" -gt "$ATTEMPTS" ]; then
  log "Warning: Service did not respond within $((ATTEMPTS * INTERVAL))s — redirecting anyway"
fi

# ─── Step 3: Schedule async cleanup of previous container ────────────────────
log "Scheduling cleanup of previous container $PREVIOUS_VMID in 15 seconds..."
nohup sh -c "sleep 15 && pct stop $PREVIOUS_VMID 2>/dev/null; pct destroy $PREVIOUS_VMID --purge 2>/dev/null; echo 'Cleaned up container $PREVIOUS_VMID' >&2" >/dev/null 2>&1 &

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
