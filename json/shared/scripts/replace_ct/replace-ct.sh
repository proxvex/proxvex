#!/bin/sh
# Replace old container with new one.
#
# Steps:
# 1) Validate previous_vm_id and vm_id are set and different.
# 2) Start new container if not already running.
# 3) Stop old container.
# 4) Destroy old container.
# 5) Output redirect_url for frontend.
#
# This script runs on the PVE host (execute_on: "ve"), so it can safely
# stop the deployer's own container without killing the script.

set -eu

PROXVEX_REPLACED_LOCK="${PROXVEX_REPLACED_LOCK:-migrate}"

mark_replaced() {
  _vmid="$1"; _new="$2"
  _now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # `pct config` emits the description as a single URL-encoded line. Without
  # decoding here, appending plain markers below and feeding the result back
  # to `pct set --description` causes Proxmox to encode the value a SECOND
  # time — every %3A becomes %253A, every %0A becomes %250A, and the next
  # is_managed_container() pass no longer matches `proxvex:managed`.
  _desc_enc=$(pct config "$_vmid" 2>/dev/null | sed -n 's/^description: //p' | head -1)
  _desc=$(python3 -c "import sys; from urllib.parse import unquote
s = sys.argv[1]
# Iterative decode handles already-double-encoded descriptions left behind
# by earlier versions of this script.
for _ in range(4):
    n = unquote(s)
    if n == s:
        break
    s = n
print(s, end='')" "$_desc_enc" 2>/dev/null || printf '%s' "$_desc_enc")
  # Strip any prior replaced-* markers; description is now in plain form so
  # grep matches by line correctly.
  _clean=$(printf '%s' "$_desc" | grep -v 'proxvex:replaced-' || true)
  _new_desc=$(printf '%s\n<!-- proxvex:replaced-at %s -->\n<!-- proxvex:replaced-by %s -->' \
    "$_clean" "$_now" "$_new")
  pct set "$_vmid" --description "$_new_desc" >&2 2>/dev/null || true
  pct set "$_vmid" --onboot 0 >&2 2>/dev/null || true
  pct set "$_vmid" --lock "$PROXVEX_REPLACED_LOCK" >&2 2>/dev/null || true
  echo "Marked $_vmid replaced-by $_new at $_now (lock=$PROXVEX_REPLACED_LOCK)" >&2
}

SOURCE_VMID="{{ previous_vm_id }}"
TARGET_VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
HTTP_PORT="{{ http_port }}"
LOCAL_HTTPS_PORT="{{ local_https_port }}"
DEPLOYER_BASE_URL="{{ deployer_base_url }}"
VE_CONTEXT_KEY="{{ ve_context_key }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

# ─── Step 1: Validate ────────────────────────────────────────────────────────
if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previous_vm_id is required"
fi
if [ -z "$TARGET_VMID" ] || [ "$TARGET_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$SOURCE_VMID" = "$TARGET_VMID" ]; then
  fail "previous_vm_id ($SOURCE_VMID) must differ from vm_id ($TARGET_VMID)"
fi
if [ "$HTTP_PORT" = "NOT_DEFINED" ]; then HTTP_PORT="3000"; fi
if [ "$LOCAL_HTTPS_PORT" = "NOT_DEFINED" ]; then LOCAL_HTTPS_PORT="3443"; fi

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
    REDIRECT_URL="https://${HOSTNAME}:${LOCAL_HTTPS_PORT}"
  else
    REDIRECT_URL="http://${HOSTNAME}:${HTTP_PORT}"
  fi
fi

# ─── Step 4a: Self-upgrade detection ─────────────────────────────────────────
# If the SOURCE container is the deployer instance running THIS script (via
# SSH driven by the deployer itself), we cannot stop it inline — stopping
# the container kills the SSH session that's executing this script. Instead
# we drop a marker into the NEW container's /config volume and return.
# The NEW deployer reads the marker on first boot, SSHes back to the PVE
# host, stops SOURCE with --timeout 30 and unlinks its managed volumes
# (see upgrade-finalization-service.mts + host-stop-and-unlink-previous-
# deployer.sh). That removes the previous systemd-run race entirely.
IS_SELF_UPGRADE=false
if pct config "$SOURCE_VMID" 2>/dev/null | grep -qa "deployer-instance"; then
  IS_SELF_UPGRADE=true
fi

if [ "$IS_SELF_UPGRADE" = "true" ]; then
  log "Self-upgrade detected (source $SOURCE_VMID is the deployer instance); handing switchover to new deployer"

  # Resolve the path of the NEW container's /config volume directly from its
  # pct config — during self-upgrade there are two volumes with the same
  # hostname suffix (subvol-OLD-<host>-config AND subvol-NEW-<host>-config),
  # so resolve_host_volume cannot disambiguate them.
  NEW_CONFIG_VOLID=$(pct config "$TARGET_VMID" 2>/dev/null \
    | grep -aE '^mp[0-9]+:.*[ ,]mp=/config([, ]|$)' \
    | head -1 \
    | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/' \
    || true)
  CONFIG_PATH=""
  if [ -n "$NEW_CONFIG_VOLID" ]; then
    CONFIG_PATH=$(pvesm path "$NEW_CONFIG_VOLID" 2>/dev/null || true)
  fi
  if [ -z "$CONFIG_PATH" ] || [ ! -d "$CONFIG_PATH" ]; then
    fail "Could not resolve /config volume of new container $TARGET_VMID (volid=$NEW_CONFIG_VOLID, path=$CONFIG_PATH) — new deployer needs the marker to finish the switchover"
  fi

  NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # ve_context_key lets the new deployer pick the right SSH context when it
  # SSHes back to the PVE host to stop SOURCE.
  cat > "${CONFIG_PATH}/.pending-post-upgrade.json" <<EOF
{
  "previous_vmid": "${SOURCE_VMID}",
  "new_vmid": "${TARGET_VMID}",
  "upgraded_at": "${NOW_UTC}",
  "ve_context_key": "${VE_CONTEXT_KEY}"
}
EOF
  chmod 0644 "${CONFIG_PATH}/.pending-post-upgrade.json" 2>/dev/null || true
  log "Wrote post-upgrade marker: ${CONFIG_PATH}/.pending-post-upgrade.json"

  # Mark the old deployer container as replaced (sets onboot=0 + lock + notes
  # markers). lock is informational here — the new deployer issues
  # `pct unlock` before `pct stop` regardless. SOURCE keeps serving on its
  # IP until the new deployer stops it.
  mark_replaced "$SOURCE_VMID" "$TARGET_VMID"

  # The new container was already started by 200-start-lxc.json before this
  # replace_ct template ran, so its finalizeUpgradeIfPending check at boot
  # ran BEFORE we wrote the marker — and silently skipped because the marker
  # didn't exist yet. Without restarting, the new deployer never reads the
  # marker, the old deployer keeps holding the static IP, and the new
  # deployer can't bind its listener (port conflict via the shared MAC).
  # Reboot the new container so finalizeUpgradeIfPending runs again — this
  # time it sees the marker, SSHes back to the PVE host, stops the old
  # container, unlinks its managed volumes, and removes the marker.
  log "Restarting new container $TARGET_VMID so its finalizer reads the marker..."
  pct reboot "$TARGET_VMID" --timeout 30 >&2 || \
    log "Warning: pct reboot $TARGET_VMID returned non-zero — finalizer may not have triggered"

  log "Switchover marker placed. New deployer (vmid $TARGET_VMID) takes over and stops $SOURCE_VMID once it has finished booting."
  printf '[{"id":"redirect_url","value":"%s"},{"id":"switchover_scheduled","value":"true"}]' "$REDIRECT_URL"
  exit 0
fi

# ─── Step 4b: Regular stop + mark for delayed cleanup (non-self upgrades) ────
source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$source_status" = "running" ]; then
  log "Stopping old container $SOURCE_VMID..."
  pct stop "$SOURCE_VMID" >&2 || log "Warning: failed to stop old container $SOURCE_VMID"
fi

# Unlink all managed volumes and rename to clean names. The new container
# already owns these volumes; the old container keeps only its rootfs.
vol_unlink_persistent "$SOURCE_VMID"

# Mark + lock instead of immediate destroy. A periodic backend cleanup service
# entsorgt the container after grace period. Activate-button rollback bleibt
# during the grace window möglich.
mark_replaced "$SOURCE_VMID" "$TARGET_VMID"

log "Container $SOURCE_VMID marked for delayed cleanup (replaced by $TARGET_VMID)"

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
