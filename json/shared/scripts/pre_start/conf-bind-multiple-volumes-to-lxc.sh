#!/bin/sh
# Bind multiple host directories to an LXC container
#
# This script binds multiple volumes to an LXC container by:
# 1. Parsing volumes (key=value format, one per line)
# 2. Creating host directories under <base_path>/<hostname>/<key>
# 3. Creating bind mounts from host to container paths
# 4. Setting proper ownership and permissions
#
# Requires:
#   - vm_id: LXC container ID (from context)
#   - hostname: Container hostname (from context)
#   - volumes: Volume mappings in key=value format, one per line (required)
#             Format: key=path[,permissions[,uid:gid]]
#             Examples: data=/srv/data
#                       data=/srv/data,0755
#                       data=/srv/data,0755,1000:1000
#                       private=/var/lib/samba/private,0700,0:0
#   - base_path: Base path for host directories (optional)
#   - host_mountpoint: Host mountpoint base (optional)
#   - username: Username for ownership (optional)
#   - uid: User ID - default for volumes without explicit uid:gid (optional)
#   - gid: Group ID - default for volumes without explicit uid:gid (optional)
#
# Script is idempotent and can be run multiple times safely.
#
# Output: JSON to stdout (errors to stderr)

VMID="{{ vm_id}}"
HOSTNAME="{{ hostname}}"
VOLUMES="{{ volumes}}"
ADDON_VOLUMES="{{ addon_volumes}}"

# Guard against NOT_DEFINED (unresolved template variables)
if [ "$VOLUMES" = "NOT_DEFINED" ]; then
  VOLUMES=""
fi
if [ "$ADDON_VOLUMES" = "NOT_DEFINED" ]; then
  ADDON_VOLUMES=""
fi
USERNAME="{{ username}}"
UID_VALUE="{{ uid}}"
GID_VALUE="{{ gid}}"
MAPPED_UID="{{ mapped_uid}}"
MAPPED_GID="{{ mapped_gid}}"

# Check that required parameters are not empty
if [ -z "$VMID" ] || [ -z "$HOSTNAME" ]; then
  echo "Error: Required parameters (vm_id, hostname) must be set and not empty!" >&2
  exit 1
fi

# Merge addon_volumes with base volumes BEFORE the empty check,
# otherwise addon-only volumes are silently ignored.
# Application volumes take precedence — addon entries with duplicate keys are skipped with a warning.
if [ -n "$ADDON_VOLUMES" ] && [ "$ADDON_VOLUMES" != "" ]; then
  if [ -n "$VOLUMES" ]; then
    _base_keys=""
    _IFS="$IFS"; IFS='
'
    for _bline in $VOLUMES; do
      _bkey=$(echo "$_bline" | cut -d'=' -f1)
      [ -n "$_bkey" ] && _base_keys="$_base_keys $_bkey "
    done
    IFS="$_IFS"
    _IFS="$IFS"; IFS='
'
    for _aline in $ADDON_VOLUMES; do
      _akey=$(echo "$_aline" | cut -d'=' -f1)
      case "$_base_keys" in
        *" $_akey "*) ;;
        *) VOLUMES="$VOLUMES
$_aline" ;;
      esac
    done
    IFS="$_IFS"
  else
    VOLUMES="$ADDON_VOLUMES"
  fi
  echo "Merged addon_volumes with base volumes" >&2
fi

if [ -z "$VOLUMES" ]; then
  echo "No volumes to bind, skipping." >&2
  exit 0
fi

# Set default base_path if not provided
if [ -z "$BASE_PATH" ] || [ "$BASE_PATH" = "" ]; then
  BASE_PATH="volumes"
fi

# Read container config once (used for idmap/unprivileged detection)
PCT_CONFIG=$(pct config "$VMID" 2>/dev/null || true)

is_number() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Map a container UID/GID to host UID/GID using lxc.idmap ranges (if present).
# Prints mapped host id or empty string.
map_id_via_idmap() {
  _kind="$1" # u or g
  _cid="$2"  # container id
  echo "$PCT_CONFIG" | awk -v kind="$_kind" -v cid="$_cid" '
    $1 ~ /^lxc\.idmap[:=]$/ {
      # Format: lxc.idmap: u 0 100000 65536
      k=$2; c=$3+0; h=$4+0; l=$5+0;
      if (k==kind && cid>=c && cid < (c+l)) {
        print h + (cid - c);
        exit 0;
      }
    }
    END { }
  '
}

# Detect unprivileged container
IS_UNPRIV=0
if echo "$PCT_CONFIG" | grep -aqE '^unprivileged:\s*1\s*$'; then
  IS_UNPRIV=1
fi

# Compute effective host-side UID/GID for ownership.
# If mapped_uid/mapped_gid are set explicitly, they win.
# Otherwise:
# - if lxc.idmap exists, map via it
# - else if unprivileged: default Proxmox shift 100000+ID
# - else: use container UID/GID directly
EFFECTIVE_UID="$UID_VALUE"
EFFECTIVE_GID="$GID_VALUE"

if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "" ] && [ "$MAPPED_UID" != "NOT_DEFINED" ]; then
  EFFECTIVE_UID="$MAPPED_UID"
elif is_number "$UID_VALUE"; then
  MID=$(map_id_via_idmap u "$UID_VALUE")
  if [ -n "$MID" ]; then
    EFFECTIVE_UID="$MID"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    # Check if custom idmap exists (passthrough UIDs) - if so, UID is already
    # a 1:1 mapped passthrough and should be used directly on the host
    HAS_IDMAP=$(printf '%s' "$PCT_CONFIG" | grep -c 'lxc\.idmap' 2>/dev/null) || HAS_IDMAP=0
    if [ "$HAS_IDMAP" -gt 0 ]; then
      EFFECTIVE_UID="$UID_VALUE"
    else
      EFFECTIVE_UID=$((100000 + UID_VALUE))
    fi
  fi
fi

if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "" ] && [ "$MAPPED_GID" != "NOT_DEFINED" ]; then
  EFFECTIVE_GID="$MAPPED_GID"
elif is_number "$GID_VALUE"; then
  MID=$(map_id_via_idmap g "$GID_VALUE")
  if [ -n "$MID" ]; then
    EFFECTIVE_GID="$MID"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    HAS_IDMAP=$(printf '%s' "$PCT_CONFIG" | grep -c 'lxc\.idmap' 2>/dev/null) || HAS_IDMAP=0
    if [ "$HAS_IDMAP" -gt 0 ]; then
      EFFECTIVE_GID="$GID_VALUE"
    else
      EFFECTIVE_GID=$((100000 + GID_VALUE))
    fi
  fi
fi

echo "bind-multiple-volumes-to-lxc: vm_id=$VMID unprivileged=$IS_UNPRIV uid=$UID_VALUE gid=$GID_VALUE host_uid=$EFFECTIVE_UID host_gid=$EFFECTIVE_GID" >&2

# Store default effective UID/GID (used when volume doesn't specify its own)
DEFAULT_EFFECTIVE_UID="$EFFECTIVE_UID"
DEFAULT_EFFECTIVE_GID="$EFFECTIVE_GID"

# Function to compute effective host UID for a given container UID
# Usage: compute_effective_uid <container_uid>
compute_effective_uid() {
  _cuid="$1"
  if ! is_number "$_cuid"; then
    echo "$_cuid"
    return
  fi
  _mid=$(map_id_via_idmap u "$_cuid")
  if [ -n "$_mid" ]; then
    echo "$_mid"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    HAS_IDMAP=$(printf '%s' "$PCT_CONFIG" | grep -c 'lxc\.idmap' 2>/dev/null) || HAS_IDMAP=0
    if [ "$HAS_IDMAP" -gt 0 ]; then
      echo "$_cuid"
    else
      echo $((100000 + _cuid))
    fi
  else
    echo "$_cuid"
  fi
}

# Function to compute effective host GID for a given container GID
# Usage: compute_effective_gid <container_gid>
compute_effective_gid() {
  _cgid="$1"
  if ! is_number "$_cgid"; then
    echo "$_cgid"
    return
  fi
  _mid=$(map_id_via_idmap g "$_cgid")
  if [ -n "$_mid" ]; then
    echo "$_mid"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    HAS_IDMAP=$(printf '%s' "$PCT_CONFIG" | grep -c 'lxc\.idmap' 2>/dev/null) || HAS_IDMAP=0
    if [ "$HAS_IDMAP" -gt 0 ]; then
      echo "$_cgid"
    else
      echo $((100000 + _cgid))
    fi
  else
    echo "$_cgid"
  fi
}

# Create or reuse a Proxmox-managed volume as data root for this container.
# All bind-mount subdirectories live inside this volume so pct snapshot captures everything.
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
VOL_NAME="subvol-${VMID}-${SAFE_HOST}-app"
VOLUME_STORAGE="{{ volume_storage }}"
if [ -z "$VOLUME_STORAGE" ] || [ "$VOLUME_STORAGE" = "NOT_DEFINED" ]; then
  # Auto-detect from rootfs
  VOLUME_STORAGE=$(pct config "$VMID" 2>/dev/null | grep "^rootfs:" | sed 's/^rootfs: *//; s/:.*//')
  [ -z "$VOLUME_STORAGE" ] && VOLUME_STORAGE="local-zfs"
fi

_vol_type=$(pvesm status -storage "$VOLUME_STORAGE" 2>/dev/null | awk 'NR==2 {print $2}' || true)
HOST_PATH=""

# Check if managed volume already exists (current hostname or previous container)
PREV_VMID="{{ previouse_vm_id }}"
_existing_volid=$(pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
  | awk -v pat="${SAFE_HOST}-app\$" '$1 ~ pat {print $1; exit}' || true)

# For upgrade/reconfigure: try to find the old container's app volume
if [ -z "$_existing_volid" ] && [ -n "$PREV_VMID" ] && [ "$PREV_VMID" != "NOT_DEFINED" ]; then
  _prev_hostname=$(pct config "$PREV_VMID" 2>/dev/null | grep "^hostname:" | awk '{print $2}' || true)
  if [ -n "$_prev_hostname" ]; then
    _prev_safe=$(echo "$_prev_hostname" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
    _existing_volid=$(pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
      | awk -v pat="${_prev_safe}-app\$" '$1 ~ pat {print $1; exit}' || true)
    if [ -n "$_existing_volid" ]; then
      echo "Reusing app volume from previous container $PREV_VMID ($_prev_hostname)" >&2
    fi
  fi
fi

if [ -n "$_existing_volid" ]; then
  HOST_PATH=$(pvesm path "$_existing_volid" 2>/dev/null || true)
  echo "Reusing managed app volume: $_existing_volid ($HOST_PATH)" >&2
fi

if [ -z "$HOST_PATH" ] || [ ! -d "$HOST_PATH" ]; then
  # Allocate new managed volume
  _alloc_raw=""
  if [ "$_vol_type" = "zfspool" ]; then
    _alloc_raw=$(pvesm alloc "$VOLUME_STORAGE" "$VMID" "$VOL_NAME" "4G" --format subvol 2>&1 || true)
  else
    _alloc_raw=$(pvesm alloc "$VOLUME_STORAGE" "$VMID" "$VOL_NAME" "4G" 2>&1 || true)
  fi
  # Extract volume ID
  case "$_alloc_raw" in
    *"'"*) _volid=$(echo "$_alloc_raw" | sed -n "s/.*'\\([^']*\\)'.*/\\1/p") ;;
    *) _volid=$(echo "$_alloc_raw" | tr -d '[:space:]') ;;
  esac
  if [ -n "$_volid" ]; then
    HOST_PATH=$(pvesm path "$_volid" 2>/dev/null || true)
    echo "Created managed app volume: $_volid ($HOST_PATH)" >&2
  fi
fi

if [ -z "$HOST_PATH" ] || [ ! -d "$HOST_PATH" ]; then
  echo "Error: Failed to create or find managed app volume for $HOSTNAME" >&2
  exit 1
fi

# Helper function: Is container running?
container_running() {
  pct status "$VMID" 2>/dev/null | grep -aq 'status: running'
}

# Build list of used mp indexes from current config
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
# Track mp indexes assigned during this run to avoid reusing same slot
ASSIGNED_MPS=""

# Helper function: Find next free mpX considering current config and assignments
find_next_mp() {
  for i in $(seq 0 9); do
    case " $USED_MPS $ASSIGNED_MPS " in
      *" $i "*) ;; # already used
      *) echo "mp$i"; return 0 ;;
    esac
  done
  echo ""
}

# Check if container needs to be stopped
WAS_RUNNING=0
if container_running; then
  WAS_RUNNING=1
fi

# Track if we need to stop the container
NEEDS_STOP=0

# Process volumes: split by newlines and process each line
# Use a temporary file to avoid subshell issues
TMPFILE=$(mktemp)
echo "$VOLUMES" > "$TMPFILE"

# Pre-clean: ensure only one mp entry per host source path (based on VOLUMES)
# Build source list from VOLUMES (first field before '=')
SOURCES=""
while IFS= read -r sline; do
  [ -z "$sline" ] && continue
  skey=$(echo "$sline" | cut -d'=' -f1)
  [ -z "$skey" ] && continue
  spath="$HOST_PATH/$skey"
  SOURCES="$SOURCES $spath"
done < "$TMPFILE"

for SRC in $SOURCES; do
  MAP_SRC_LINES=$(pct config "$VMID" | grep -aE "^mp[0-9]+: $SRC," || true)
  if [ -n "$MAP_SRC_LINES" ]; then
    # Delete all mp entries for this source; we'll re-add cleanly below
    if [ "$NEEDS_STOP" -eq 0 ] && container_running; then
      pct stop "$VMID" >&2
      NEEDS_STOP=1
    fi
    printf '%s\n' "$MAP_SRC_LINES" | while IFS= read -r mline; do
      mpkey=$(echo "$mline" | cut -d: -f1)
      if pct set "$VMID" -delete "$mpkey" >&2; then
        echo "Deleted mount $mpkey for source $SRC" >&2
      else
        echo "Warning: Failed to delete mount $mpkey for source $SRC" >&2
      fi
    done
  fi
done

# Pre-clean: ensure only one mp entry per target container path (based on VOLUMES)
# Build target list from VOLUMES (second field after '=')
TARGETS=""
while IFS= read -r tline; do
  [ -z "$tline" ] && continue
  tval=$(echo "$tline" | cut -d'=' -f2- | cut -d',' -f1)
  [ -z "$tval" ] && continue
  # Normalize container path: ensure a single leading slash (avoid //config)
  tval=$(printf '%s' "$tval" | sed -E 's#^/*#/#')
  TARGETS="$TARGETS $tval"
done < "$TMPFILE"

for TARGET in $TARGETS; do
  # Find all mp entries for this target
  MAP_LINES=$(pct config "$VMID" | grep -aE "^mp[0-9]+: .*mp=$TARGET" || true)
  if [ -n "$MAP_LINES" ]; then
    # Only delete OUR bind mounts (source under HOST_PATH), preserve PVE storage mounts
    printf '%s\n' "$MAP_LINES" | while IFS= read -r mline; do
      mpkey=$(echo "$mline" | cut -d: -f1)
      mpsrc=$(echo "$mline" | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/')
      case "$mpsrc" in
        "$HOST_PATH"/*)
          if [ "$NEEDS_STOP" -eq 0 ] && container_running; then
            pct stop "$VMID" >&2
            NEEDS_STOP=1
          fi
          if pct set "$VMID" -delete "$mpkey" >&2; then
            echo "Deleted mount $mpkey for target $TARGET" >&2
          else
            echo "Warning: Failed to delete mount $mpkey for target $TARGET" >&2
          fi
          ;;
        *)
          echo "Keeping mount $mpkey for target $TARGET (PVE storage: $mpsrc)" >&2
          ;;
      esac
    done
  fi
done

# Refresh USED_MPS after cleanup
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')

VOLUME_COUNT=0
while IFS= read -r line <&3; do
  # Skip empty lines
  [ -z "$line" ] && continue

  # Parse format: key=path[,permissions[,uid:gid]]
  VOLUME_KEY=$(echo "$line" | cut -d'=' -f1)
  VOLUME_REST=$(echo "$line" | cut -d'=' -f2-)

  # Count comma-separated fields
  FIELD_COUNT=$(echo "$VOLUME_REST" | tr ',' '\n' | wc -l)

  # Parse fields
  VOLUME_VALUE=$(echo "$VOLUME_REST" | cut -d',' -f1)
  VOLUME_PERMS="0755"  # Default permissions
  VOLUME_UID=""
  VOLUME_GID=""

  if [ "$FIELD_COUNT" -ge 2 ]; then
    VOLUME_PERMS=$(echo "$VOLUME_REST" | cut -d',' -f2)
  fi

  if [ "$FIELD_COUNT" -ge 3 ]; then
    VOLUME_UIDGID=$(echo "$VOLUME_REST" | cut -d',' -f3)
    if echo "$VOLUME_UIDGID" | grep -q ':'; then
      VOLUME_UID=$(echo "$VOLUME_UIDGID" | cut -d':' -f1)
      VOLUME_GID=$(echo "$VOLUME_UIDGID" | cut -d':' -f2)
    fi
  fi

  # Skip if key or value is empty
  [ -z "$VOLUME_KEY" ] && continue
  [ -z "$VOLUME_VALUE" ] && continue

  # Determine effective UID/GID for this volume
  # If volume specifies uid:gid, use that (mapped for unprivileged containers)
  # Otherwise use the default effective UID/GID
  if [ -n "$VOLUME_UID" ] && [ -n "$VOLUME_GID" ]; then
    VOL_EFFECTIVE_UID=$(compute_effective_uid "$VOLUME_UID")
    VOL_EFFECTIVE_GID=$(compute_effective_gid "$VOLUME_GID")
    echo "Volume $VOLUME_KEY uses custom uid:gid $VOLUME_UID:$VOLUME_GID -> host $VOL_EFFECTIVE_UID:$VOL_EFFECTIVE_GID" >&2
  else
    VOL_EFFECTIVE_UID="$DEFAULT_EFFECTIVE_UID"
    VOL_EFFECTIVE_GID="$DEFAULT_EFFECTIVE_GID"
  fi

  # Construct paths: <base_path>/<hostname>/<volume-key>
  SOURCE_PATH="$HOST_PATH/$VOLUME_KEY"
  # Normalize: ensure exactly one leading slash (avoid //config when value starts with /)
  CONTAINER_PATH=$(printf '%s' "$VOLUME_VALUE" | sed -E 's#^/*#/#')

  # Create source directory if it doesn't exist
  if [ ! -d "$SOURCE_PATH" ]; then
    mkdir -p "$SOURCE_PATH" >&2
  fi

  # Set ownership/permissions on the host source directory.
  # IMPORTANT: For unprivileged containers, host ownership must use mapped host IDs;
  # otherwise ownership shows up as "nobody" inside the container.
  if [ -n "$VOL_EFFECTIVE_UID" ] && [ -n "$VOL_EFFECTIVE_GID" ] && [ "$VOL_EFFECTIVE_UID" != "" ] && [ "$VOL_EFFECTIVE_GID" != "" ]; then
    # Set ownership recursively with the provided UID/GID
    if chown -R "$VOL_EFFECTIVE_UID:$VOL_EFFECTIVE_GID" "$SOURCE_PATH" 2>/dev/null; then
      echo "Set ownership of $SOURCE_PATH (recursively) to $VOL_EFFECTIVE_UID:$VOL_EFFECTIVE_GID" >&2
    else
      echo "Warning: Failed to set ownership of $SOURCE_PATH to $VOL_EFFECTIVE_UID:$VOL_EFFECTIVE_GID" >&2
    fi
    # Set permissions recursively with configured value
    if chmod -R "$VOLUME_PERMS" "$SOURCE_PATH" 2>/dev/null; then
      echo "Set permissions of $SOURCE_PATH (recursively) to $VOLUME_PERMS" >&2
    else
      echo "Warning: Failed to set permissions of $SOURCE_PATH to $VOLUME_PERMS" >&2
    fi
  fi
  
  # Determine existing mp slot for the target container path (mp=...)
  EXISTING_LINE=$(pct config "$VMID" | grep -aE "^mp[0-9]+: .*mp=$CONTAINER_PATH" | head -n1)
  EXISTING_MP=""
  EXISTING_SRC=""
  if [ -n "$EXISTING_LINE" ]; then
    EXISTING_MP=$(echo "$EXISTING_LINE" | cut -d: -f1)
    EXISTING_SRC=$(echo "$EXISTING_LINE" | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/')
  fi

  # If an mp entry exists for the target path
  if [ -n "$EXISTING_MP" ]; then
    if [ "$EXISTING_SRC" = "$SOURCE_PATH" ]; then
      echo "Mount $SOURCE_PATH -> $CONTAINER_PATH already exists in $EXISTING_MP, skipping." >&2
      continue
    fi
    # Source path differs: keep existing mount (e.g. PVE storage volume from template 150)
    echo "Mount for $CONTAINER_PATH already exists in $EXISTING_MP with different source ($EXISTING_SRC), keeping existing mount." >&2
    VOLUME_COUNT=$((VOLUME_COUNT + 1))
    continue
  fi
  
  # Stop container if needed (only once, before first mount)
  if [ "$NEEDS_STOP" -eq 0 ] && container_running; then
    pct stop "$VMID" >&2
    NEEDS_STOP=1
  fi
  
  # Find next free mountpoint
  MP=$(find_next_mp)
  if [ -z "$MP" ]; then
    echo "Error: No free mountpoint available (mp0-mp9 all in use)" >&2
    rm -f "$TMPFILE"
    exit 1
  fi
  
  # Set up bind mount
  MOUNT_OPTIONS="$SOURCE_PATH,mp=$CONTAINER_PATH"
  if ! pct set "$VMID" -$MP "$MOUNT_OPTIONS" >&2; then
    echo "Error: Failed to set mount point $MP in container $VMID" >&2
    rm -f "$TMPFILE"
    exit 1
  fi
  
  echo "Bound $SOURCE_PATH to $CONTAINER_PATH in container $VMID" >&2
  VOLUME_COUNT=$((VOLUME_COUNT + 1))
  # Mark this mp as assigned to avoid reuse in subsequent mounts
  MP_NUM="${MP#mp}"
  ASSIGNED_MPS="$ASSIGNED_MPS $MP_NUM"
done 3< "$TMPFILE"
rm -f "$TMPFILE"

# Restart container only if we stopped it
if [ "$NEEDS_STOP" -eq 1 ]; then
  if ! pct start "$VMID" >&2; then
    echo "Error: Failed to restart container $VMID" >&2
    exit 1
  fi
fi

# Note: Permissions are set on the host with mapped UID/GID.
# For containers with custom idmaps (passthrough UIDs), the UID is used directly.
# For standard unprivileged containers, Container UID N → Host UID (100000 + N).
# No need to set permissions inside the container as they are already correct on the host.

echo "Successfully processed volumes for container $VMID" >&2

exit 0

