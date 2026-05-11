#!/bin/sh
# Append a stub `proxy: {}` block to /etc/distribution/config.yml in the
# LXC's rootfs volume BEFORE the LXC starts. See the template description
# for rationale.
set -eu

VM_ID="{{ vm_id }}"
log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VM_ID" ] || [ "$VM_ID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi

# Resolve the rootfs volume's host filesystem path so we can edit
# /etc/distribution/config.yml directly. Works on zfspool/dir/lvm-backed
# rootfs alike (pvesm path is the common abstraction).
ROOTFS_VOLID=$(pct config "$VM_ID" 2>/dev/null \
  | sed -nE 's/^rootfs: ([^,]+),.*$/\1/p')
if [ -z "$ROOTFS_VOLID" ]; then
  fail "Could not read rootfs volid from pct config $VM_ID"
fi
ROOTFS_PATH=$(pvesm path "$ROOTFS_VOLID" 2>/dev/null || true)
if [ -z "$ROOTFS_PATH" ] || [ ! -d "$ROOTFS_PATH" ]; then
  fail "Could not resolve rootfs path for $ROOTFS_VOLID (got: $ROOTFS_PATH)"
fi

CONFIG="${ROOTFS_PATH}/etc/distribution/config.yml"
if [ ! -f "$CONFIG" ]; then
  log "Distribution config $CONFIG not found in rootfs — nothing to patch"
  echo '[{"id":"registry_proxy_stub","value":"missing"}]'
  exit 0
fi

# Idempotency check: only append if no `proxy:` block exists yet (at column
# 0, so we don't match keys like `cache: blobdescriptor:` etc.).
if grep -qE '^proxy:' "$CONFIG"; then
  log "$CONFIG already has a proxy: block — leaving as is"
  echo '[{"id":"registry_proxy_stub","value":"present"}]'
  exit 0
fi

printf '\nproxy: {}\n' >> "$CONFIG"
log "Appended 'proxy: {}' stub to $CONFIG"
echo '[{"id":"registry_proxy_stub","value":"added"}]'
