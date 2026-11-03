#!/bin/sh
# TEST-ONLY (test-rebuild livetest). Fails the reconfigure between start and
# replace-ct. Before failing it asserts what has to hold at this point: the
# new container is running and tagged as a rebuild of the source.

VMID="{{ vm_id }}"
SOURCE_VMID="{{ previous_vm_id }}"

fail() { echo "livetest: ERROR — $*" >&2; exit 2; }

[ "$(vol_rebuild_source_of "$VMID")" = "$SOURCE_VMID" ] \
  || fail "$VMID is not tagged proxvex-rebuild-of-$SOURCE_VMID: $(pct config "$VMID" | grep '^tags:')"
[ "$(pct status "$VMID" | awk '{print $2}')" = "running" ] || fail "$VMID is not running"
[ "$(pct status "$SOURCE_VMID" | awk '{print $2}')" = "running" ] || fail "source $SOURCE_VMID is not running"

echo "livetest: $VMID tagged and running next to $SOURCE_VMID — failing the reconfigure on purpose" >&2
exit 1
