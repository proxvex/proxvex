#!/bin/sh
# Write deployer/proxvex CA certs into the (stopped) container's system trust
# store BEFORE the first start. Mounts the container's rootfs offline via
# vol_mount (no pct push, no running container required) and for every
# `/usr/local/share/ca-certificates/proxvex*.crt` file on the host:
#   1. Drops the cert at the same relative path inside the container.
#   2. Splices the cert into /etc/ssl/certs/ca-certificates.crt — the merged
#      trust bundle that TLS clients (curl, openssl, docker daemon) read
#      directly. Per-cert markers make the splice idempotent.
#
# Why glob, not a fixed `proxvex-ca.crt`: a livetest PVE host carries both
# the production-Hub CA (proxvex-ca.crt — signs production mirrors) AND the
# test-Hub's own CA (proxvex-deployer-ca.crt — signs locally-deployed apps).
# Containers must trust BOTH so docker pulls from production mirrors and
# direct API calls to the test deployer all work.
#
# Result: the cert is trusted from first boot. No update-ca-certificates
# inside the container needed.
#
# No-op when the host has no /usr/local/share/ca-certificates/proxvex*.crt
# (registry-mirror trust isn't relevant in that setup) or when running on a
# non-applicable host.
#
# Library: pve-common.sh + vol-common.sh (vol_mount, vol_get_storage_type)

set -eu

VMID="{{ vm_id }}"

CA_DIR=/usr/local/share/ca-certificates
GUEST_REL_DIR=usr/local/share/ca-certificates
BUNDLE_RELPATH=etc/ssl/certs/ca-certificates.crt

# Collect every proxvex CA file on the host (proxvex-ca.crt = production CA,
# proxvex-deployer-ca.crt = deployer's own CA, possibly more in future).
ca_files=""
for f in "$CA_DIR"/proxvex*.crt; do
  [ -f "$f" ] && ca_files="${ca_files} ${f}"
done

if [ -z "$ca_files" ]; then
  echo "No deployer CA on host ($CA_DIR/proxvex*.crt) — skipping push" >&2
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

TARGET_DIR="${ROOTFS_PATH}/${GUEST_REL_DIR}"
BUNDLE_FILE="${ROOTFS_PATH}/${BUNDLE_RELPATH}"

mkdir -p "$TARGET_DIR"

pushed_count=0
spliced_count=0

for ca_file in $ca_files; do
  ca_name=$(basename "$ca_file")
  target_file="${TARGET_DIR}/${ca_name}"
  begin_marker="# ${ca_name} BEGIN"
  end_marker="# ${ca_name} END"

  # 1) Canonical cert file in /usr/local/share/ca-certificates/
  if [ -f "$target_file" ] && cmp -s "$ca_file" "$target_file"; then
    echo "Container $VMID already has matching CA at /${GUEST_REL_DIR}/${ca_name}" >&2
  else
    cp "$ca_file" "$target_file"
    REF_OWNER=$(stat -c '%u:%g' "$BUNDLE_FILE" 2>/dev/null || true)
    [ -n "$REF_OWNER" ] && chown "$REF_OWNER" "$target_file" 2>/dev/null || true
    chmod 644 "$target_file"
    echo "Wrote /${GUEST_REL_DIR}/${ca_name} into vmid $VMID rootfs ($ROOTFS_PATH)" >&2
    pushed_count=$((pushed_count + 1))
  fi

  # 2) Splice into the merged trust bundle so first-boot TLS works without
  #    update-ca-certificates needing to run inside the container.
  if [ -f "$BUNDLE_FILE" ]; then
    if grep -qF "$begin_marker" "$BUNDLE_FILE" 2>/dev/null; then
      echo "${ca_name} already spliced into merged bundle of $VMID" >&2
    else
      {
        printf '\n%s\n' "$begin_marker"
        cat "$ca_file"
        printf '%s\n' "$end_marker"
      } >> "$BUNDLE_FILE"
      echo "Spliced ${ca_name} into /${BUNDLE_RELPATH} of $VMID" >&2
      spliced_count=$((spliced_count + 1))
    fi
  else
    echo "Note: /${BUNDLE_RELPATH} missing in $VMID; ${ca_name} is in /${GUEST_REL_DIR}/ — relying on update-ca-certificates at first run" >&2
  fi
done

echo "[{\"id\":\"ca_pushed\",\"value\":\"true\"},{\"id\":\"ca_pushed_count\",\"value\":\"${pushed_count}\"},{\"id\":\"ca_spliced_count\",\"value\":\"${spliced_count}\"}]"
