#!/bin/sh
# Replace old container with new one.
#
# Steps:
# 1) Validate previouse_vm_id and vm_id are set and different.
# 2) Start new container if not already running.
# 3) Stop old container.
# 4) Destroy old container.
# 5) Output redirect_url for frontend.
#
# This script runs on the PVE host (execute_on: "ve"), so it can safely
# stop the deployer's own container without killing the script.

set -eu

SOURCE_VMID="{{ previouse_vm_id }}"
TARGET_VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
HTTP_PORT="{{ http_port }}"
HTTPS_PORT="{{ https_port }}"
DEPLOYER_BASE_URL="{{ deployer_base_url }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

# ─── Step 1: Validate ────────────────────────────────────────────────────────
if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previouse_vm_id is required"
fi
if [ -z "$TARGET_VMID" ] || [ "$TARGET_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$SOURCE_VMID" = "$TARGET_VMID" ]; then
  fail "previouse_vm_id ($SOURCE_VMID) must differ from vm_id ($TARGET_VMID)"
fi
if [ "$HTTP_PORT" = "NOT_DEFINED" ]; then HTTP_PORT="3000"; fi
if [ "$HTTPS_PORT" = "NOT_DEFINED" ]; then HTTPS_PORT="3443"; fi

# ─── Step 2: Start new container if not running ──────────────────────────────
target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$target_status" != "running" ]; then
  log "Starting new container $TARGET_VMID..."
  ATTEMPTS=3
  WAIT_SECONDS=40
  INTERVAL=2
  attempt=1
  while [ "$attempt" -le "$ATTEMPTS" ]; do
    pct start "$TARGET_VMID" >&2 2>&1 || true
    ELAPSED=0
    while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
      target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
      if [ "$target_status" = "running" ]; then
        break 2
      fi
      sleep "$INTERVAL"
      ELAPSED=$((ELAPSED + INTERVAL))
    done
    attempt=$((attempt + 1))
  done
  if [ "$target_status" != "running" ]; then
    # Rollback: restart old container
    log "Failed to start new container $TARGET_VMID. Restarting old container $SOURCE_VMID..."
    pct start "$SOURCE_VMID" >/dev/null 2>&1 || log "Warning: failed to restart old container $SOURCE_VMID"
    fail "Failed to start new container $TARGET_VMID after $ATTEMPTS attempts"
  fi
fi
log "New container $TARGET_VMID is running"

# ─── Step 3: Determine redirect URL ──────────────────────────────────────────
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

# ─── Step 4a: Self-upgrade detection ─────────────────────────────────────────
# If the SOURCE container is the deployer instance running THIS script (via
# SSH driven by the deployer itself), we cannot stop it inline — stopping
# the container kills the SSH session that's executing this script, and the
# cleanup below never happens. Detect via the deployer-instance marker in
# the source container's PVE notes, and offload stop/start to a transient
# systemd unit on the PVE host.
IS_SELF_UPGRADE=false
if pct config "$SOURCE_VMID" 2>/dev/null | grep -qa "deployer-instance"; then
  IS_SELF_UPGRADE=true
fi

if [ "$IS_SELF_UPGRADE" = "true" ]; then
  log "Self-upgrade detected (source $SOURCE_VMID is the deployer instance); scheduling switchover via systemd"

  # Write a marker into the NEW container's /config volume so the new
  # deployer can log the completed upgrade on its first boot.
  # Resolve the path directly from TARGET_VMID's pct config instead of via
  # resolve_host_volume — during self-upgrade there are two volumes with the
  # same hostname suffix (subvol-OLD-<host>-config AND subvol-NEW-<host>-config),
  # and resolve_host_volume can't distinguish them.
  NEW_CONFIG_VOLID=$(pct config "$TARGET_VMID" 2>/dev/null \
    | grep -aE '^mp[0-9]+:.*[ ,]mp=/config([, ]|$)' \
    | head -1 \
    | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/' \
    || true)
  CONFIG_PATH=""
  if [ -n "$NEW_CONFIG_VOLID" ]; then
    CONFIG_PATH=$(pvesm path "$NEW_CONFIG_VOLID" 2>/dev/null || true)
  fi
  if [ -n "$CONFIG_PATH" ] && [ -d "$CONFIG_PATH" ]; then
    NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    cat > "${CONFIG_PATH}/.pending-post-upgrade.json" <<EOF
{
  "previous_vmid": "${SOURCE_VMID}",
  "new_vmid": "${TARGET_VMID}",
  "upgraded_at": "${NOW_UTC}"
}
EOF
    chmod 0644 "${CONFIG_PATH}/.pending-post-upgrade.json" 2>/dev/null || true
    log "Wrote post-upgrade marker: ${CONFIG_PATH}/.pending-post-upgrade.json"
  else
    log "Warning: could not resolve /config volume of new container $TARGET_VMID (volid=$NEW_CONFIG_VOLID, path=$CONFIG_PATH) — post-upgrade log marker skipped"
  fi

  # Disable autostart on the old container (safety net)
  pct set "$SOURCE_VMID" --onboot 0 >&2 2>/dev/null || true

  # Schedule the switchover. TARGET is already running (start phase started
  # it), but its network is racing with SOURCE. Stop SOURCE, wait, restart
  # TARGET so it cleanly takes over the IP.
  UNIT_NAME="proxvex-upgrade-${SOURCE_VMID}-to-${TARGET_VMID}"
  DELAY_SECONDS=5
  log "systemd-run: unit=${UNIT_NAME}, delay=${DELAY_SECONDS}s"
  if ! systemd-run \
      --on-active="${DELAY_SECONDS}s" \
      --unit="${UNIT_NAME}" \
      --description="proxvex upgrade switchover ${SOURCE_VMID} -> ${TARGET_VMID}" \
      /bin/sh -c "pct stop ${SOURCE_VMID}; sleep 2; pct restart ${TARGET_VMID}" >&2; then
    fail "systemd-run failed — cannot schedule self-upgrade switchover"
  fi

  log "Switchover scheduled. Reconnect to ${REDIRECT_URL} after ~10-20s."
  printf '[{"id":"redirect_url","value":"%s"},{"id":"switchover_scheduled","value":"true"}]' "$REDIRECT_URL"
  exit 0
fi

# ─── Step 4b: Regular stop + destroy (non-self upgrades) ─────────────────────
source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
# Disable autostart first — if destroy fails, the container must not boot on reboot
pct set "$SOURCE_VMID" --onboot 0 >&2 2>/dev/null || true
if [ "$source_status" = "running" ]; then
  log "Stopping old container $SOURCE_VMID..."
  pct stop "$SOURCE_VMID" >&2 || log "Warning: failed to stop old container $SOURCE_VMID"
fi

# Unlink all managed volumes and rename to clean names before destroy.
# This preserves data volumes across container lifecycles.
vol_unlink_persistent "$SOURCE_VMID"

log "Destroying old container $SOURCE_VMID..."
pct destroy "$SOURCE_VMID" --force --purge >&2 || log "Warning: failed to destroy old container $SOURCE_VMID"

log "Container replaced: $SOURCE_VMID → $TARGET_VMID"

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
