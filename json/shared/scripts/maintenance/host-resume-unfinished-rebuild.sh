#!/bin/sh
# Resume an unfinished rebuild before its task is restarted.
#
# Counterpart of host-pause-unfinished-rebuild.sh: the failure hook stopped
# the new container; a restart that continues after the start phase needs it
# running again. onboot stays 0 until replace-ct.sh completes the rebuild.
#
# vol-common.sh is prepended via the template `library` property.

set -eu

VMID="{{ vm_id }}"

log() { echo "$@" >&2; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  log "vm_id is required"
  exit 1
fi

if ! vol_rebuild_source_of "$VMID" >/dev/null; then
  log "Container $VMID is not an unfinished rebuild — nothing to resume"
  exit 0
fi

status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$status" = "running" ]; then
  log "Unfinished rebuild $VMID is already running"
  exit 0
fi

log "Starting unfinished rebuild $VMID for the task restart..."
pct start "$VMID" >&2
