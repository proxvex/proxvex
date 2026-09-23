#!/bin/sh
# =============================================================================
# host-install-init-wrapper.sh — install /usr/local/sbin/proxvex-init into the
# container rootfs so an app that is PID 1 can bind privileged ports.
#
# WHY: in an oci-image app the service IS the container init (lxc.init.cmd),
# and it usually runs as a non-root uid (gitea: uid 1000). Such a process
# cannot bind ports below net.ipv4.ip_unprivileged_port_start (default 1024),
# so an app that should answer on 443 has to be moved to a high port
# (local_https_port defaults to 1443 for exactly that reason).
#
# The sysctl is per network namespace, so it could simply be set for the
# container — but Proxmox rejects raw `lxc.sysctl.*` keys ("unable to parse
# config") and strips them on the next config write, and `lxc.hook.start-host`
# is rejected as well. Inside the container there is no "before the app"
# either: the app is the first process.
#
# SO: wrap init. This script writes a tiny wrapper into the rootfs; the OCI
# configuration step (conf-oci-lxc-configuration.py) points lxc.init.cmd at
# it, keeping the original command as its arguments. The wrapper raises the
# port range and then `exec "$@"` — no extra process stays behind, and it
# happens on every start, not just the deploy.
#
# File capabilities (setcap cap_net_bind_service, parameter
# bind_privileged_port) are not an alternative here: they need libcap inside
# the guest, they must be applied before the process starts (same ordering
# problem), and a capability written from the host is ignored inside a user
# namespace unless it carries a rootid.
#
# Parameters:
#   vm_id                    - container id (required)
#   unprivileged_port_start  - lowest port a non-root process may bind
#                              (e.g. 443). Empty / NOT_DEFINED → no-op.
#
# Runs on the VE with the container stopped; mounts the rootfs offline via
# vol_mount (same mechanism as host-push-ca-to-container.sh).
#
# Library: pve-common.sh + vol-common.sh (vol_mount, vol_get_storage_type)
# Output: JSON array to stdout
# =============================================================================

VMID="{{ vm_id }}"
PORT_START="{{ unprivileged_port_start }}"

WRAPPER_RELPATH=usr/local/sbin/proxvex-init

if [ -z "$PORT_START" ] || [ "$PORT_START" = "NOT_DEFINED" ]; then
  echo "unprivileged_port_start not set — no init wrapper needed" >&2
  echo '[]'
  exit 0
fi

case "$PORT_START" in
  ''|*[!0-9]*)
    echo "Error: unprivileged_port_start must be a number (got '$PORT_START')" >&2
    exit 1
    ;;
esac
if [ "$PORT_START" -lt 1 ] || [ "$PORT_START" -gt 65535 ]; then
  echo "Error: unprivileged_port_start out of range: $PORT_START" >&2
  exit 1
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

# For block-based storages we mounted ourselves; release the mount on exit so
# pct start can attach the rootfs cleanly (see host-push-ca-to-container.sh).
case "$STORAGE_TYPE" in
  lvm|lvmthin)
    trap 'umount "$ROOTFS_PATH" 2>/dev/null || umount -l "$ROOTFS_PATH" 2>/dev/null || true; rmdir "$ROOTFS_PATH" 2>/dev/null || true' EXIT
    ;;
esac

TARGET="${ROOTFS_PATH}/${WRAPPER_RELPATH}"
mkdir -p "$(dirname "$TARGET")" || {
  echo "Error: cannot create $(dirname "$TARGET")" >&2
  exit 1
}

# The wrapper must not fail the app: a read-only or missing sysctl only means
# privileged ports stay closed, which the app itself will report.
cat > "$TARGET" <<EOF
#!/bin/sh
# Written by proxvex (host-install-init-wrapper.sh) — do not edit.
# Raises the unprivileged port range, then hands over to the app as PID 1.
echo $PORT_START > /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null \\
  || echo "proxvex-init: cannot set ip_unprivileged_port_start" >&2
exec "\$@"
EOF
chmod 0755 "$TARGET"

echo "Installed init wrapper /${WRAPPER_RELPATH} (ip_unprivileged_port_start=$PORT_START)" >&2
echo '[]'
