#!/bin/sh
# TEST-ONLY (test-rebuild livetest). Runs after replace-ct.

VMID="{{ vm_id }}"
SOURCE_VMID="{{ previous_vm_id }}"

fail() { echo "livetest: ERROR — $*" >&2; exit 1; }

if src=$(vol_rebuild_source_of "$VMID"); then
  fail "$VMID still carries proxvex-rebuild-of-$src"
fi
[ "$(pct config "$VMID" | awk '/^onboot:/ {print $2}')" = "1" ] || fail "$VMID does not have onboot 1"
pct config "$SOURCE_VMID" | grep -qE "proxvex(:|%3A)replaced-by $VMID" \
  || fail "source $SOURCE_VMID is not marked replaced-by $VMID"
echo "livetest: rebuild $SOURCE_VMID -> $VMID finished, tag cleared" >&2
