#!/bin/sh
# Finish an unfinished rebuild: the new container takes over, the source is
# retired the way replace-ct.sh does it.
#
# Steps:
# 1) Source gone or already replaced: only clear the rebuild tag.
# 2) New container not replaced itself: refuse while a newer rebuild of it is
#    running (finish that one first), otherwise start it.
#    New container already replaced by a newer rebuild (chain
#    source -> new -> newer): it is not started, only the source is retired.
# 3) Stop the source, unlink its managed volumes, mark it replaced. The
#    replaced-container cleanup destroys it after the grace period.
# 4) Clear the rebuild tag; the new container takes over the source's onboot.
#
# vol-common.sh is prepended via the template `library` property.

set -eu

VMID="{{ vm_id }}"
SOURCE_VMID="{{ previous_vm_id }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previous_vm_id is required"
fi
if [ "$SOURCE_VMID" = "$VMID" ]; then
  fail "previous_vm_id ($SOURCE_VMID) must differ from vm_id ($VMID)"
fi

TARGET_CONF=$(pct config "$VMID" 2>/dev/null) || fail "Container $VMID does not exist"

# `pct config` prints the description URL-encoded (":" as %3A).
is_replaced() { printf '%s' "$1" | grep -qE 'proxvex(:|%3A)replaced-at'; }

SOURCE_CONF=$(pct config "$SOURCE_VMID" 2>/dev/null || true)
if [ -z "$SOURCE_CONF" ] || is_replaced "$SOURCE_CONF"; then
  log "Source $SOURCE_VMID is gone or already replaced — only clearing the rebuild tag on $VMID"
  vol_rebuild_tag_clear "$VMID"
  exit 0
fi

if is_replaced "$TARGET_CONF"; then
  log "$VMID is itself replaced by a newer rebuild — retiring $SOURCE_VMID without starting $VMID"
else
  for _newer in $(vol_rebuilds_of "$VMID"); do
    if [ "$(pct status "$_newer" 2>/dev/null | awk '{print $2}')" = "running" ]; then
      fail "Container $_newer (rebuilt from $VMID) is running — finish the rebuild $VMID -> $_newer first"
    fi
  done
  if [ "$(pct status "$VMID" 2>/dev/null | awk '{print $2}')" != "running" ]; then
    log "Starting $VMID..."
    pct start "$VMID" >&2 || fail "pct start $VMID failed"
  fi
fi

source_onboot=$(printf '%s\n' "$SOURCE_CONF" | awk '/^onboot:/ {print $2; exit}')
pct unlock "$SOURCE_VMID" >&2 2>/dev/null || true
if [ "$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}')" = "running" ]; then
  log "Stopping source $SOURCE_VMID..."
  pct shutdown "$SOURCE_VMID" --timeout 30 --forceStop 1 >&2 \
    || pct stop "$SOURCE_VMID" >&2 \
    || fail "pct shutdown/stop $SOURCE_VMID failed"
fi

vol_unlink_persistent "$SOURCE_VMID"
vol_mark_replaced "$SOURCE_VMID" "$VMID"

if [ "$source_onboot" = "1" ] && ! is_replaced "$TARGET_CONF"; then
  pct set "$VMID" --onboot 1 >&2 || log "Warning: could not set onboot on $VMID"
fi
vol_rebuild_tag_clear "$VMID"

log "Rebuild $SOURCE_VMID -> $VMID finished; $SOURCE_VMID is marked for delayed cleanup"
