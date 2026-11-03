#!/bin/sh
# Pause an unfinished rebuild after its task failed.
#
# A reconfigure/upgrade starts the new container (start phase) while the old
# one keeps running until replace-ct.sh. If the task fails in between, both
# would stay up with the same hostname. This stops the new container and keeps
# it from booting with the host, so the old one alone serves again. The new
# container keeps its rebuild tag: a task restart resumes it
# (host-resume-unfinished-rebuild.sh), the Unfinished Rebuilds list offers
# finish or discard.
#
# Only acts on containers tagged proxvex-rebuild-of-<source> whose source is
# running. Without a running source the new container is the only instance
# and stays up.
#
# vol-common.sh is prepended via the template `library` property.

set -eu

VMID="{{ vm_id }}"

log() { echo "$@" >&2; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  log "vm_id is required"
  exit 1
fi

if ! SOURCE_VMID=$(vol_rebuild_source_of "$VMID"); then
  log "Container $VMID is not an unfinished rebuild — nothing to pause"
  exit 0
fi

source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "missing")
if [ "$source_status" != "running" ]; then
  log "Source $SOURCE_VMID is not running ($source_status) — $VMID stays up as the only instance"
  exit 0
fi

status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$status" = "running" ]; then
  log "Stopping unfinished rebuild $VMID (source $SOURCE_VMID keeps running)..."
  pct shutdown "$VMID" --timeout 30 --forceStop 1 >&2 \
    || pct stop "$VMID" >&2 \
    || log "Warning: failed to stop $VMID"
fi
pct set "$VMID" --onboot 0 >&2 || log "Warning: could not set onboot 0 on $VMID"

log "Unfinished rebuild $VMID paused; $SOURCE_VMID is serving"
