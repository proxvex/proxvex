#!/bin/sh


# Determine storage for LXC rootfs
# 1. Use rootfs_storage parameter if provided
# 2. Otherwise, auto-select: prefer local-zfs, then storage with most free space

PREFERRED_STORAGE=""

# Check if rootfs_storage parameter is provided
if [ -n "{{ rootfs_storage }}" ] && [ "{{ rootfs_storage }}" != "NOT_DEFINED" ]; then
  PREFERRED_STORAGE="{{ rootfs_storage }}"
  echo "Using user-selected storage: $PREFERRED_STORAGE" >&2
fi

# Auto-select if no storage specified
if [ -z "$PREFERRED_STORAGE" ]; then
  # First, check if local-zfs exists and supports rootdir
  if pvesm list "local-zfs" --content rootdir 2>/dev/null | grep -q .; then
    PREFERRED_STORAGE="local-zfs"
    echo "Using preferred storage: local-zfs" >&2
  fi
fi

# If still no storage, find storage with most free space that supports rootdir
if [ -z "$PREFERRED_STORAGE" ]; then
  # Use pvesm status --content rootdir to list storages that SUPPORT rootdir
  # (not just those that have rootdir content)
  ROOTFS_RESULT=$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $6, $1}' | sort -rn | head -n1)

  if [ -n "$ROOTFS_RESULT" ]; then
    set -- $ROOTFS_RESULT
    PREFERRED_STORAGE=$2
    echo "Auto-selected storage with most free space: $PREFERRED_STORAGE" >&2
  fi
fi

if [ -z "$PREFERRED_STORAGE" ]; then
  echo "No suitable storage found for LXC rootfs!" >&2
  exit 1
fi

stor="$PREFERRED_STORAGE"

# Strip unit suffix (e.g. "1G" -> "1") — pct create expects plain number for ZFS
DISK_SIZE=$(echo "{{ disk_size }}" | sed 's/[GgMmKk]$//')
ROOTFS="$stor:${DISK_SIZE}"
echo "Rootfs: $ROOTFS" >&2

# Auto-select VMID if not set
if [ -z "{{ vm_id }}" ] || [ "{{ vm_id }}" = "NOT_DEFINED" ]; then
  # Find the next free VMID (highest existing + 1)
  VMID=$(pvesh get /cluster/nextid)
  CREATE_NEW=1
else
  VMID="{{ vm_id }}"
  CREATE_NEW=0
  # Check if container already exists - if so, skip creation (reconfiguration mode)
  if [ -f "/etc/pve/lxc/${VMID}.conf" ]; then
    echo "Container $VMID already exists - skipping pct create (reconfiguration mode)" >&2
    echo '{ "id": "vm_id", "value": "'$VMID'" }'
    exit 0
  fi
fi

# Check that template_path is set (only required for new containers)
TEMPLATE_PATH="{{ template_path }}"
if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  echo "Error: template_path parameter is empty or not set!" >&2
  echo "Please ensure that 010-get-latest-os-template.json template is executed before 100-create-configure-lxc.json" >&2
  exit 1
fi

# Create the container
# Note: uid and gid parameters are used for volume permissions, not for idmap
# Proxmox may try to automatically create idmap entries during container creation
# The error occurs during template extraction, so we cannot prevent it by editing config afterwards
# Instead, we need to ensure the container is created without triggering automatic idmap
# We'll create the container and then remove any idmap entries that were created
CONFIG_FILE="/etc/pve/lxc/${VMID}.conf"

# Build optional --arch argument (only set for OCI images, not for regular LXC templates)
ARCH_ARG=""
if [ -n "{{ arch }}" ] && [ "{{ arch }}" != "NOT_DEFINED" ]; then
  ARCH_ARG="--arch {{ arch }}"
  echo "Using architecture: {{ arch }}" >&2
fi

# Pass the host's primary nameserver so Proxmox writes /etc/resolv.conf.
# OCI containers have no DHCP client, so ip=dhcp alone won't set DNS.
HOST_NS=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)
NS_ARG=""
if [ -n "$HOST_NS" ]; then
  NS_ARG="--nameserver $HOST_NS"
  echo "Using host nameserver: $HOST_NS" >&2
fi

# Create the container
# Note: The error "newuidmap: uid range [0-65536) -> [100000-165536) not allowed"
# occurs because Proxmox tries to use idmap during template extraction.
# This happens even though we don't want idmap - uid/gid are only for volume permissions.
# shellcheck disable=SC2086
pct create "$VMID" "$TEMPLATE_PATH" \
  --rootfs "$ROOTFS" \
  --hostname "{{ hostname }}" \
  --memory "{{ memory }}" \
  --net0 name=eth0,bridge="{{ bridge }}",ip=dhcp \
  --ostype "{{ ostype }}" \
  --unprivileged 1 \
  --onboot 1 \
  $NS_ARG \
  $ARCH_ARG >&2
RC=$? 
if [ $RC -ne 0 ]; then
  echo "Failed to create LXC container!" >&2
  echo "Note: If you see 'newuidmap' errors, this may be due to automatic UID/GID mapping." >&2
  echo "The uid and gid parameters are used for volume permissions only, not for container idmap." >&2
  exit $RC
fi

# Remove any automatically created idmap entries from the container config
# uid and gid parameters are used for volume permissions, not for idmap configuration
if [ -f "$CONFIG_FILE" ]; then
  # Remove all lxc.idmap lines that Proxmox may have automatically added
  sed -i '/^lxc\.idmap/d' "$CONFIG_FILE" 2>/dev/null || true
fi

# Define log directory and file path for LXC console logging
# Format: /var/log/lxc/{hostname}-{vmid}.log
LOG_DIR="/var/log/lxc"
LOG_FILE="${LOG_DIR}/{{ hostname }}-${VMID}.log"

# Create log directory if it doesn't exist
if [ ! -d "$LOG_DIR" ]; then
    echo "Creating log directory: $LOG_DIR" >&2
    mkdir -p "$LOG_DIR"
fi
# Add lxc.console.logpath to config file

# Check if it already exists to avoid duplicates
if grep -q "^lxc.console.logfile:" "$CONFIG_FILE"; then
    echo "Updating lxc.console.logfile in $CONFIG_FILE" >&2
    sed -i "s|^lxc.console.logfile:.*|lxc.console.logfile: $LOG_FILE|" "$CONFIG_FILE"
else
    echo "Adding lxc.console.logfile to $CONFIG_FILE" >&2
    echo "lxc.console.logfile: $LOG_FILE" >> "$CONFIG_FILE"
fi

echo "Set lxc.console.logfile: $LOG_FILE" >&2

# Notes/description will be written by 190-host-write-lxc-notes.sh
# This allows other conf-* scripts to contribute information before notes are finalized.

echo "LXC container $VMID ({{ hostname }}) created." >&2

echo '{ "id": "vm_id", "value": "'$VMID'" }'
