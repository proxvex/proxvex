#!/bin/sh
# Safe container destroy — preserves persistent data volumes.
#
# Run directly on the Proxmox VE host.
#
# What it does:
#   1. Shows all volumes attached to the container
#   2. Unlinks managed volumes from the .conf and renames them to clean names
#      (strips the subvol-{VMID}- prefix so they survive pct destroy)
#   3. Destroys the container (only rootfs gets deleted)
#
# The preserved volumes can be found afterwards via:
#   pvesm list <storage> --content rootdir | grep <hostname>
#
# Usage:
#   pve-safe-destroy.sh <VMID>
#   pve-safe-destroy.sh <VMID> --dry-run    # show what would happen
#   pve-safe-destroy.sh <VMID> --force       # skip confirmation

set -eu

VMID="${1:-}"
MODE="${2:-}"

if [ -z "$VMID" ]; then
  echo "Usage: $0 <VMID> [--dry-run|--force]" >&2
  exit 1
fi

DRY_RUN=0
FORCE=0
case "$MODE" in
  --dry-run) DRY_RUN=1 ;;
  --force)   FORCE=1 ;;
esac

# Verify container exists
if ! pct config "$VMID" >/dev/null 2>&1; then
  echo "Error: Container $VMID not found" >&2
  exit 1
fi

HOSTNAME=$(pct config "$VMID" 2>/dev/null | grep -a '^hostname:' | awk '{print $2}')
echo "Container: $VMID ($HOSTNAME)"
echo ""

# Collect all mountpoints
MP_LINES=$(pct config "$VMID" 2>/dev/null | grep -aE '^mp[0-9]+:' || true)

if [ -z "$MP_LINES" ]; then
  echo "No data volumes attached."
  echo ""
else
  echo "Attached volumes:"
  echo "$MP_LINES" | while IFS= read -r line; do
    mpkey=$(echo "$line" | cut -d: -f1)
    rest=$(echo "$line" | sed "s/^${mpkey}: //")
    volid=$(echo "$rest" | cut -d, -f1)
    mpath=$(echo "$rest" | sed -n 's/.*mp=\([^,]*\).*/\1/p')
    echo "  $mpkey: $volid -> $mpath"
  done
  echo ""
fi

# Identify which volumes will be preserved
PRESERVE_COUNT=0
DESTROY_COUNT=0

echo "Plan:"
echo "$MP_LINES" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  mpkey=$(echo "$line" | cut -d: -f1)
  rest=$(echo "$line" | sed "s/^${mpkey}: //")
  volid=$(echo "$rest" | cut -d, -f1)
  stor="${volid%%:*}"
  vname="${volid#*:}"
  mpath=$(echo "$rest" | sed -n 's/.*mp=\([^,]*\).*/\1/p')

  # Determine clean name (strip subvol-{VMID}- or vm-{VMID}- prefix)
  clean=""
  case "$vname" in
    subvol-${VMID}-*) clean="${vname#subvol-${VMID}-}" ;;
    vm-${VMID}-*)     clean="${vname#vm-${VMID}-}" ;;
  esac

  if [ -n "$clean" ]; then
    echo "  PRESERVE $mpkey: $vname -> rename to '$clean' ($mpath)"
  else
    # Bind mount or already clean-named — just unlink
    case "$vname" in
      /*) echo "  SKIP     $mpkey: bind mount $vname ($mpath)" ;;
      *)  echo "  PRESERVE $mpkey: $vname (already clean name) ($mpath)" ;;
    esac
  fi
done

echo ""
echo "  rootfs: will be DESTROYED with container"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run — no changes made)"
  exit 0
fi

# Confirmation
if [ "$FORCE" -eq 0 ]; then
  printf "Proceed? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# Stop container if running
STATUS=$(pct status "$VMID" 2>/dev/null | awk '{print $2}')
if [ "$STATUS" = "running" ]; then
  echo "Stopping container $VMID..."
  pct stop "$VMID" || true
fi

# Unlink and rename volumes
echo "$MP_LINES" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  mpkey=$(echo "$line" | cut -d: -f1)
  rest=$(echo "$line" | sed "s/^${mpkey}: //")
  volid=$(echo "$rest" | cut -d, -f1)
  stor="${volid%%:*}"
  vname="${volid#*:}"

  # Skip bind mounts
  case "$vname" in /*) continue ;; esac

  # Unlink from .conf
  pct set "$VMID" -delete "$mpkey" 2>/dev/null || true
  echo "Unlinked $mpkey ($vname)"

  # Rename to clean name
  clean=""
  case "$vname" in
    subvol-${VMID}-*) clean="${vname#subvol-${VMID}-}" ;;
    vm-${VMID}-*)     clean="${vname#vm-${VMID}-}" ;;
  esac

  if [ -n "$clean" ] && [ "$clean" != "$vname" ]; then
    stype=$(pvesm status -storage "$stor" 2>/dev/null | awk 'NR==2 {print $2}')
    case "$stype" in
      zfspool)
        pool=$(awk -v s="$stor" '$1=="zfspool:" && $2==s {b=1} b && $1=="pool" {print $2;exit}' /etc/pve/storage.cfg 2>/dev/null)
        if [ -n "$pool" ] && zfs rename "${pool}/${vname}" "${pool}/${clean}" 2>/dev/null; then
          echo "Renamed $vname -> $clean"
        else
          echo "Warning: rename failed for $vname" >&2
        fi
        ;;
      lvmthin|lvm)
        vg=$(awk -v s="$stor" '($1=="lvmthin:" || $1=="lvm:") && $2==s {b=1} b && $1=="vgname" {print $2;exit}' /etc/pve/storage.cfg 2>/dev/null)
        if [ -n "$vg" ] && lvrename "$vg" "$vname" "$clean" 2>/dev/null; then
          echo "Renamed $vname -> $clean"
        else
          echo "Warning: rename failed for $vname" >&2
        fi
        ;;
      dir)
        base=$(awk -v s="$stor" '$1=="dir:" && $2==s {b=1} b && $1=="path" {print $2;exit}' /etc/pve/storage.cfg 2>/dev/null)
        if [ -n "$base" ]; then
          mkdir -p "${base}/images/shared"
          if mv "${base}/images/${VMID}/${vname}" "${base}/images/shared/${clean}" 2>/dev/null; then
            echo "Renamed $vname -> $clean"
          else
            echo "Warning: rename failed for $vname" >&2
          fi
        fi
        ;;
    esac
  fi
done

# Destroy container (only rootfs remains in .conf)
echo "Destroying container $VMID..."
pct destroy "$VMID" --force --purge 2>/dev/null || true

echo ""
echo "Done. Preserved volumes can be found with:"
echo "  pvesm list <storage> --content rootdir | grep ${HOSTNAME:-$VMID}"
