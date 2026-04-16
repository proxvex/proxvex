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
  log "previous_vm_id not set — skipping cleanup"
  printf '[{"id":"redirect_url","value":""}]'
  exit 0
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
  if pct exec "$NEW_VMID" -- test -f /etc/ssl/addon/fullchain.pem 2>/dev/null && \
     pct exec "$NEW_VMID" -- test -f /etc/ssl/addon/privkey.pem 2>/dev/null; then
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

# ─── Step 3: Cleanup previous container + reboot new one ─────────────────────
# The new container was started while the old one still held the DNS name.
# After stopping the old container, reboot the new one so it picks up the hostname via DHCP/DNS.
CLEANUP_SCRIPT="
  pct set $PREVIOUS_VMID --onboot 0 2>&1 || true
  pct stop $PREVIOUS_VMID 2>&1 || echo 'Warning: pct stop $PREVIOUS_VMID failed'
  pct reboot $NEW_VMID 2>&1 || echo 'Warning: pct reboot $NEW_VMID failed'
  sleep 3
  if [ \"\$(pct status $NEW_VMID 2>/dev/null | awk '{print \$2}')\" = 'running' ]; then
    # Unlink all managed volumes before destroy and rename to clean names.
    # This preserves data volumes across container lifecycles.
    for _mpkey in \$(pct config $PREVIOUS_VMID 2>/dev/null | grep -aE '^mp[0-9]+:' | cut -d: -f1); do
      _mpsrc=\$(pct config $PREVIOUS_VMID 2>/dev/null | grep \"^\${_mpkey}:\" | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/')
      case \"\$_mpsrc\" in /*) continue ;; esac
      _stor=\"\${_mpsrc%%:*}\"
      _vname=\"\${_mpsrc#*:}\"
      pct set $PREVIOUS_VMID -delete \$_mpkey 2>&1 || true
      echo \"Unlinked volume \$_mpkey (\$_mpsrc) from container $PREVIOUS_VMID\"
      # Rename to clean name (strip subvol-{VMID}- prefix)
      _clean=\"\"
      case \"\$_vname\" in
        subvol-${PREVIOUS_VMID}-*) _clean=\"\${_vname#subvol-${PREVIOUS_VMID}-}\" ;;
        vm-${PREVIOUS_VMID}-*)     _clean=\"\${_vname#vm-${PREVIOUS_VMID}-}\" ;;
      esac
      if [ -n \"\$_clean\" ]; then
        _stype=\$(pvesm status -storage \"\$_stor\" 2>/dev/null | awk 'NR==2 {print \$2}')
        if [ \"\$_stype\" = \"zfspool\" ]; then
          _pool=\$(awk -v s=\"\$_stor\" '\$1==\"zfspool:\" && \$2==s {b=1} b && \$1==\"pool\" {print \$2;exit}' /etc/pve/storage.cfg 2>/dev/null)
          [ -n \"\$_pool\" ] && zfs rename \"\${_pool}/\${_vname}\" \"\${_pool}/\${_clean}\" 2>/dev/null && echo \"Renamed volume to clean name: \$_clean\"
        elif [ \"\$_stype\" = \"lvmthin\" ] || [ \"\$_stype\" = \"lvm\" ]; then
          _vg=\$(awk -v s=\"\$_stor\" '(\$1==\"lvmthin:\" || \$1==\"lvm:\") && \$2==s {b=1} b && \$1==\"vgname\" {print \$2;exit}' /etc/pve/storage.cfg 2>/dev/null)
          [ -n \"\$_vg\" ] && lvrename \"\$_vg\" \"\$_vname\" \"\$_clean\" 2>/dev/null && echo \"Renamed volume to clean name: \$_clean\"
        fi
      fi
    done
    pct destroy $PREVIOUS_VMID --purge 2>&1 || echo 'Warning: pct destroy $PREVIOUS_VMID failed'
    echo 'Destroyed previous container $PREVIOUS_VMID'
  else
    echo 'Error: new container $NEW_VMID not running after reboot — keeping previous container $PREVIOUS_VMID'
  fi
"

IS_DEPLOYER="false"
if echo "$CURRENT_DESC" | grep -qi "deployer-instance"; then
  IS_DEPLOYER="true"
fi

if [ "$IS_DEPLOYER" = "true" ]; then
  # Deployer instance: must use nohup because this script runs inside the container
  # that will be destroyed.
  CLEANUP_LOG="/var/log/lxc/oci-lxc-deployer-${PREVIOUS_VMID}.log"
  log "Deployer instance: scheduling async cleanup of container $PREVIOUS_VMID (log: $CLEANUP_LOG)..."
  nohup sh -c "sleep 5; $CLEANUP_SCRIPT" >> "$CLEANUP_LOG" 2>&1 &
else
  log "Cleaning up previous container $PREVIOUS_VMID..."
  eval "$CLEANUP_SCRIPT" >&2
fi

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
