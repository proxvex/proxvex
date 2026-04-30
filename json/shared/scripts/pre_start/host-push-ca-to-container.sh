#!/bin/sh
# Write the deployer CA cert into the (stopped) container's system trust
# store BEFORE the first start. Mounts the container's rootfs offline via
# vol_mount (no pct push, no running container required) and:
#   1. Drops the canonical cert file at
#      /usr/local/share/ca-certificates/proxvex-ca.crt
#   2. Splices the cert into /etc/ssl/certs/ca-certificates.crt — the merged
#      trust bundle that TLS clients (curl, openssl, docker daemon) read
#      directly. Marker comments make the splice idempotent.
#
# Result: the cert is trusted from first boot. No update-ca-certificates
# inside the container needed.
#
# No-op when the host has no /usr/local/share/ca-certificates/proxvex-ca.crt
# (registry-mirror trust isn't relevant in that setup) or when running on a
# non-applicable host.
#
# Library: pve-common.sh + vol-common.sh (vol_mount, vol_get_storage_type)

set -eu

VMID="{{ vm_id }}"

CA_HOST=/usr/local/share/ca-certificates/proxvex-ca.crt
GUEST_RELPATH=usr/local/share/ca-certificates/proxvex-ca.crt
BUNDLE_RELPATH=etc/ssl/certs/ca-certificates.crt
BEGIN_MARKER="# proxvex-ca BEGIN"
END_MARKER="# proxvex-ca END"

if [ ! -f "$CA_HOST" ]; then
  echo "No deployer CA on host ($CA_HOST) — skipping push" >&2
  echo '[{"id":"ca_pushed","value":"false"}]'
  exit 0
fi

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  echo "Error: vm_id not set" >&2
  exit 1
fi

# Read rootfs volid from pct config: `rootfs: local-zfs:subvol-500-disk-0,size=1G`
ROOTFS_VOLID=$(pct config "$VMID" 2>/dev/null \
  | awk '/^rootfs:/ {
      sub(/^rootfs:[[:space:]]+/,"");
      split($0,a,",");
      print a[1];
      exit
    }')

if [ -z "$ROOTFS_VOLID" ]; then
  echo "Error: cannot determine rootfs of vmid $VMID from pct config" >&2
  exit 1
fi

ROOTFS_VOLNAME="${ROOTFS_VOLID#*:}"
STORAGE="${ROOTFS_VOLID%%:*}"
STORAGE_TYPE=$(vol_get_storage_type "$STORAGE")
if [ -z "$STORAGE_TYPE" ]; then
  echo "Error: cannot determine storage type for $STORAGE" >&2
  exit 1
fi

ROOTFS_PATH=$(vol_mount "$ROOTFS_VOLID" "$ROOTFS_VOLNAME" "$STORAGE_TYPE" "$STORAGE")
if [ -z "$ROOTFS_PATH" ] || [ ! -d "$ROOTFS_PATH" ]; then
  echo "Error: vol_mount returned no usable directory for $ROOTFS_VOLID (got '$ROOTFS_PATH')" >&2
  exit 1
fi

# For block-based storages we mounted ourselves; release the mount on exit
# so pct start can attach the rootfs cleanly. Directory-backed storages
# (zfspool, dir, nfs) need no unmount — vol_mount was a no-op there.
case "$STORAGE_TYPE" in
  lvm|lvmthin)
    trap 'umount "$ROOTFS_PATH" 2>/dev/null || umount -l "$ROOTFS_PATH" 2>/dev/null || true; rmdir "$ROOTFS_PATH" 2>/dev/null || true' EXIT
    ;;
esac

TARGET_DIR="${ROOTFS_PATH}/$(dirname "$GUEST_RELPATH")"
TARGET_FILE="${ROOTFS_PATH}/${GUEST_RELPATH}"
BUNDLE_FILE="${ROOTFS_PATH}/${BUNDLE_RELPATH}"

mkdir -p "$TARGET_DIR"

# 1) Canonical cert file in /usr/local/share/ca-certificates/
if [ -f "$TARGET_FILE" ] && cmp -s "$CA_HOST" "$TARGET_FILE"; then
  echo "Container $VMID already has matching CA at /${GUEST_RELPATH}" >&2
else
  cp "$CA_HOST" "$TARGET_FILE"
  REF_OWNER=$(stat -c '%u:%g' "$BUNDLE_FILE" 2>/dev/null || true)
  [ -n "$REF_OWNER" ] && chown "$REF_OWNER" "$TARGET_FILE" 2>/dev/null || true
  chmod 644 "$TARGET_FILE"
  echo "Wrote /${GUEST_RELPATH} into vmid $VMID rootfs ($ROOTFS_PATH)" >&2
fi

# 2) Splice into the merged trust bundle so first-boot TLS works without
#    update-ca-certificates needing to run inside the container.
if [ -f "$BUNDLE_FILE" ]; then
  if grep -qF "$BEGIN_MARKER" "$BUNDLE_FILE" 2>/dev/null; then
    echo "Deployer CA already spliced into merged bundle of $VMID" >&2
  else
    {
      printf '\n%s\n' "$BEGIN_MARKER"
      cat "$CA_HOST"
      printf '%s\n' "$END_MARKER"
    } >> "$BUNDLE_FILE"
    echo "Spliced deployer CA into /${BUNDLE_RELPATH} of $VMID" >&2
  fi
else
  echo "Note: /${BUNDLE_RELPATH} missing in $VMID; cert is in /${GUEST_RELPATH} — relying on update-ca-certificates at first run" >&2
fi

echo '[{"id":"ca_pushed","value":"true"}]'
