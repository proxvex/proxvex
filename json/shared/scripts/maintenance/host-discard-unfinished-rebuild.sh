#!/bin/sh
# Discard an unfinished rebuild: destroy the new container and bring the
# source back.
#
# Steps:
# 1) Refuse unless the source exists and was not replaced — otherwise the new
#    container may be the only live instance.
# 2) Stop the new container, hand any clone dependents over (zfs promote).
# 3) pct destroy --force --purge: the new container's managed volumes are
#    copies of the source's and go with it.
# 4) Remove the clone snapshot on the source (it would block rollbacks there).
# 5) Start the source if it is not running.
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

if ! pct config "$VMID" >/dev/null 2>&1; then
  log "Container $VMID does not exist — nothing to do"
  exit 0
fi
SOURCE_CONF=$(pct config "$SOURCE_VMID" 2>/dev/null) \
  || fail "Source $SOURCE_VMID does not exist — $VMID may be the only instance, not discarding"
# `pct config` prints the description URL-encoded (":" as %3A).
if printf '%s' "$SOURCE_CONF" | grep -qE 'proxvex(:|%3A)replaced-at'; then
  fail "Source $SOURCE_VMID is already marked replaced — $VMID is the live instance, not discarding"
fi

pct unlock "$VMID" >&2 2>/dev/null || true
status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$status" = "running" ]; then
  log "Stopping $VMID..."
  pct shutdown "$VMID" --timeout 30 --forceStop 1 >&2 \
    || pct stop "$VMID" >&2 \
    || fail "pct shutdown/stop $VMID failed"
fi

ORIGINS=$(vol_promote_dependents "$VMID")
ZFS_POOLS=$(vol_zfs_datasets_of "$VMID" | sed 's#/[^/]*$##' | sort -u)

log "Destroying unfinished rebuild $VMID (source $SOURCE_VMID)..."
pct destroy "$VMID" --force --purge >&2 || fail "pct destroy $VMID failed"

vol_destroy_unused_origins "$ORIGINS"
for _pool in $ZFS_POOLS; do
  vol_destroy_stale_clone_snapshots "$_pool"
done

source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$source_status" != "running" ]; then
  log "Starting source $SOURCE_VMID..."
  pct start "$SOURCE_VMID" >&2 || fail "pct start $SOURCE_VMID failed — start it manually"
fi

log "Unfinished rebuild $VMID discarded; $SOURCE_VMID is serving"
