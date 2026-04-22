#!/bin/sh
# Self-upgrade switchover for the oci-lxc-deployer container.
#
# Why this exists:
# The generic replace-ct.sh runs `pct stop SOURCE; pct destroy SOURCE` inline.
# That works for every OCI-image app EXCEPT the deployer itself — stopping
# the deployer kills the process driving this SSH session, so the script is
# terminated mid-way and the switchover is left half-done.
#
# Instead, this script:
#   1. Writes a marker file into the NEW container's /config volume so the
#      new deployer can run post-upgrade finalization on its first boot.
#   2. Registers a transient systemd unit on the PVE host that performs
#      `pct stop SOURCE && sleep 2 && pct start TARGET` after a short delay.
#   3. Returns immediately so the deployer can emit its HTTP response before
#      systemd stops it.
#
# Uses: ve-global.sh (resolve_host_volume)

set -eu

SOURCE_VMID="{{ previouse_vm_id }}"
TARGET_VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
HTTP_PORT="{{ http_port }}"
HTTPS_PORT="{{ https_port }}"
DEPLOYER_BASE_URL="{{ deployer_base_url }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previouse_vm_id is required"
fi
if [ -z "$TARGET_VMID" ] || [ "$TARGET_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$SOURCE_VMID" = "$TARGET_VMID" ]; then
  fail "previouse_vm_id ($SOURCE_VMID) must differ from vm_id ($TARGET_VMID)"
fi
if [ "$HTTP_PORT" = "NOT_DEFINED" ]; then HTTP_PORT="3080"; fi
if [ "$HTTPS_PORT" = "NOT_DEFINED" ]; then HTTPS_PORT="3443"; fi

# ─── Determine redirect URL ──────────────────────────────────────────────────
if [ -n "$DEPLOYER_BASE_URL" ] && [ "$DEPLOYER_BASE_URL" != "NOT_DEFINED" ]; then
  REDIRECT_URL="$DEPLOYER_BASE_URL"
else
  HAS_SSL=0
  if pct exec "$TARGET_VMID" -- test -f /etc/ssl/addon/fullchain.pem 2>/dev/null && \
     pct exec "$TARGET_VMID" -- test -f /etc/ssl/addon/privkey.pem 2>/dev/null; then
    HAS_SSL=1
  fi
  if [ "$HAS_SSL" -eq 1 ]; then
    REDIRECT_URL="https://${HOSTNAME}:${HTTPS_PORT}"
  else
    REDIRECT_URL="http://${HOSTNAME}:${HTTP_PORT}"
  fi
fi

# ─── Write finalization marker into the new container's /config volume ───────
# The marker is picked up by the new deployer on first boot (see the upgrade
# finalization hook in backend/src/oci-lxc-deployer.mts).
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
if CONFIG_PATH=$(resolve_host_volume "$SAFE_HOST" "config" 2>/dev/null); then
  MARKER_FILE="${CONFIG_PATH}/.pending-post-upgrade.json"
  NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat > "$MARKER_FILE" <<EOF
{
  "previous_vmid": "${SOURCE_VMID}",
  "new_vmid": "${TARGET_VMID}",
  "upgraded_at": "${NOW_UTC}"
}
EOF
  chmod 0644 "$MARKER_FILE" 2>/dev/null || true
  log "Wrote post-upgrade marker: ${MARKER_FILE}"
else
  log "Warning: could not resolve /config volume of new container — skipping marker. Post-upgrade finalization may not trigger automatically."
fi

# ─── Disable autostart on old container (safety net) ─────────────────────────
pct set "$SOURCE_VMID" --onboot 0 >&2 2>/dev/null || true

# ─── Schedule switchover via systemd transient unit ──────────────────────────
# systemd-run creates a one-shot unit that executes out-of-band, so this SSH
# session (and the deployer driving it) can terminate cleanly before the
# deployer container is stopped.
UNIT_NAME="oci-lxc-deployer-upgrade-${SOURCE_VMID}-to-${TARGET_VMID}"
DELAY_SECONDS=5

log "Scheduling switchover via systemd (unit: ${UNIT_NAME}, delay: ${DELAY_SECONDS}s)"
if ! systemd-run \
    --on-active="${DELAY_SECONDS}s" \
    --unit="${UNIT_NAME}" \
    --description="oci-lxc-deployer upgrade switchover ${SOURCE_VMID} -> ${TARGET_VMID}" \
    /bin/sh -c "pct stop ${SOURCE_VMID}; sleep 2; pct start ${TARGET_VMID}" >&2; then
  fail "systemd-run failed to schedule the switchover"
fi

log "Switchover scheduled. In ~${DELAY_SECONDS}s: stop ${SOURCE_VMID}, start ${TARGET_VMID}."
log "Reconnect to ${REDIRECT_URL} after the new container is up (~15-30s total)."

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"},{"id":"switchover_scheduled","value":"true"}]' "$REDIRECT_URL"
