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

# ─── Step 4: Stop and destroy old container ───────────────────────────────────
source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
# Disable autostart first — if destroy fails, the container must not boot on reboot
pct set "$SOURCE_VMID" --onboot 0 >&2 2>/dev/null || true
if [ "$source_status" = "running" ]; then
  log "Stopping old container $SOURCE_VMID..."
  pct stop "$SOURCE_VMID" >&2 || log "Warning: failed to stop old container $SOURCE_VMID"
fi

log "Destroying old container $SOURCE_VMID..."
pct destroy "$SOURCE_VMID" --force --purge >&2 || log "Warning: failed to destroy old container $SOURCE_VMID"

log "Container replaced: $SOURCE_VMID → $TARGET_VMID"

# ─── Output ──────────────────────────────────────────────────────────────────
printf '[{"id":"redirect_url","value":"%s"}]' "$REDIRECT_URL"
