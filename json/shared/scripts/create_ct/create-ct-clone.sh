#!/bin/sh
# Clone an existing LXC container for reconfigure.
#
# Steps:
# 1) Verify source container exists and was created by proxvex.
# 2) Determine target VMID (explicit, vm_id_start-based, or next free).
# 3) Clone source to target using vzdump + pct restore.
# 4) Output target VMID, source VMID, and installed addons.
#
# Inputs (templated):
#   - previous_vm_id (required)
#   - vm_id (optional target id)
#   - vm_id_start (optional start index for auto-assigned IDs)
#
# Output:
#   - JSON to stdout with vm_id, previous_vm_id, installed_addons

set -eu

SOURCE_VMID="{{ previous_vm_id }}"
TARGET_VMID_INPUT="{{ vm_id }}"

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previous_vm_id is required"
fi

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Source container config not found: $SOURCE_CONF"
fi

# Refuse if source carries any pct lock (migrate, backup, snapshot, …).
# pct snapshot/set would fail later anyway, but by then we've already
# stripped bind mounts from the source config — leaving it half-modified.
SOURCE_LOCK=$(awk '/^lock:/ {print $2; exit}' "$SOURCE_CONF" 2>/dev/null || true)
if [ -n "$SOURCE_LOCK" ]; then
  fail "Source container $SOURCE_VMID is locked ($SOURCE_LOCK). Confirm no related operation is still running on the host, then 'pct unlock $SOURCE_VMID' and retry."
fi

# Verify source was created by proxvex
SOURCE_DESC=$(extract_description "$SOURCE_CONF")
SOURCE_CONF_TEXT=$(cat "$SOURCE_CONF" 2>/dev/null || echo "")
SOURCE_DESC_DECODED=$(decode_url "$SOURCE_DESC")
SOURCE_CONF_TEXT_DECODED=$(decode_url "$SOURCE_CONF_TEXT")

if ! check_managed_marker "$SOURCE_DESC" "$SOURCE_DESC_DECODED" "$SOURCE_CONF_TEXT" "$SOURCE_CONF_TEXT_DECODED"; then
  fail "Source container does not look like it was created by proxvex (missing notes marker)."
fi

# Determine target VMID
if [ -n "$TARGET_VMID_INPUT" ] && [ "$TARGET_VMID_INPUT" != "NOT_DEFINED" ] && [ "$TARGET_VMID_INPUT" != "" ]; then
  TARGET_VMID="$TARGET_VMID_INPUT"
else
  # Find next free VMID starting from vm_id_start
  _id_start="{{ vm_id_start }}"
  if [ -n "$_id_start" ] && [ "$_id_start" != "NOT_DEFINED" ]; then
    _id="$_id_start"
    _id_max=$(( _id_start + 1000 ))
    TARGET_VMID=""
    while [ "$_id" -le "$_id_max" ]; do
      if TARGET_VMID=$(pvesh get /cluster/nextid --vmid "$_id" 2>/dev/null); then
        break
      fi
      _id=$(( _id + 1 ))
    done
    if [ -z "$TARGET_VMID" ]; then
      echo "Error: no free VMID found between $_id_start and $_id_max" >&2
      exit 1
    fi
  else
    TARGET_VMID=$(pvesh get /cluster/nextid)
  fi
fi

if [ "$TARGET_VMID" = "$SOURCE_VMID" ]; then
  fail "Target VMID ($TARGET_VMID) must differ from source VMID ($SOURCE_VMID)"
fi

# Detect rootfs storage. Prefer the source container's own rootfs, fall back
# to whatever rootdir-content storage is actually configured on this host
# (LVM-thin on github-action CI, dir on minimal hosts, etc.). The previous
# fallback to a hardcoded `local-zfs` broke any non-ZFS deployment.
ROOTFS_STORAGE=$(pct config "$SOURCE_VMID" | grep "^rootfs:" | sed 's/^rootfs: *//; s/:.*//')
if [ -z "$ROOTFS_STORAGE" ]; then
  ROOTFS_STORAGE=$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $1; exit}')
fi
if [ -z "$ROOTFS_STORAGE" ]; then
  fail "Cannot determine rootfs storage for clone (source vmid=$SOURCE_VMID, no rootdir-content storages found)"
fi

# Temporarily remove bind mounts (pct snapshot/clone refuse if any mp*
# points to a host path — bind mounts have no storage backend).
# Managed volumes (storage:subvol-...) are fine.
# We strip them from the config for snapshot/clone, then restore them on
# source (and copy them to target) afterwards. The running source container
# keeps its kernel mounts active until it is next stopped, so no data is lost.
BIND_MOUNTS_FILE=$(mktemp)
pct config "$SOURCE_VMID" | while IFS= read -r line; do
  case "$line" in
    mp[0-9]*:\ /*)
      echo "$line" >> "$BIND_MOUNTS_FILE"
      ;;
  esac
done

BIND_KEYS=""
if [ -s "$BIND_MOUNTS_FILE" ]; then
  BIND_KEYS=$(awk -F: '{print $1}' "$BIND_MOUNTS_FILE" | paste -sd, -)
  log "Temporarily removing bind mounts ($BIND_KEYS) from $SOURCE_VMID for snapshot/clone"
  pct set "$SOURCE_VMID" --delete "$BIND_KEYS" >&2 \
    || fail "Failed to delete bind mounts $BIND_KEYS from $SOURCE_VMID"
fi

restore_source_binds() {
  [ -s "$BIND_MOUNTS_FILE" ] || return 0
  while IFS= read -r line; do
    mpkey=$(echo "$line" | cut -d: -f1)
    mpval=$(echo "$line" | sed "s/^${mpkey}: //")
    log "Restoring bind mount $mpkey on source $SOURCE_VMID"
    pct set "$SOURCE_VMID" -"$mpkey" "$mpval" >&2 || true
  done < "$BIND_MOUNTS_FILE"
}

# Snapshot + clone so the source container (potentially the deployer itself)
# can keep running throughout. Cloning from a snapshot works on a running
# source on snapshot-capable storage (ZFS, LVM-thin, etc.).
SNAPNAME="oci-clone-$(date +%s)"
log "Creating snapshot $SNAPNAME on $SOURCE_VMID..."
if ! pct snapshot "$SOURCE_VMID" "$SNAPNAME" >&2; then
  restore_source_binds
  rm -f "$BIND_MOUNTS_FILE"
  fail "pct snapshot failed — source $SOURCE_VMID may have unsupported volumes"
fi

# Run "$@" in the background and emit a stderr heartbeat every 30s, so the
# livetest runner's 120s no-output watchdog sees we're alive while a large
# volume is being copied. Returns the command's exit status.
run_with_heartbeat() {
  _hb_label="$1"; shift
  "$@" &
  _hb_pid=$!
  _hb_started=$(date +%s)
  while kill -0 "$_hb_pid" 2>/dev/null; do
    sleep 30
    kill -0 "$_hb_pid" 2>/dev/null || break
    log "$_hb_label: still running ($(($(date +%s) - _hb_started))s elapsed)"
  done
  wait "$_hb_pid"
}

# ─── Volume copy ──────────────────────────────────────────────────────────────
# `pct clone --full` copies every mountpoint with PVE::LXC::copy_volume, which
# is rsync — file by file. On a Docker host (hundreds of thousands of small
# files under /var/lib/docker) that takes ~10 minutes for 3.5 GB. When every
# volume lives on a zfspool storage we do what pct clone does with pct/pvesm
# primitives and copy each volume as ONE block stream (zfs send | zfs recv)
# instead. Everything else falls back to pct clone unchanged.
#
# What pct clone does (PVE::API2::LXC clone_vm) and what we reproduce:
#   - config from the source (snapshot == current: the snapshot was just taken)
#   - netN: always a new MAC                 -> drop hwaddr, `pct set` rolls one
#   - drop parent/snaptime/snapstate/lock/template/pending/unusedN
#   - firewall config (clone_vmfw_conf)      -> copy <vmid>.fw if present
#   - lock 'create' while copying, then unlock
#   - each volume copied to the target storage as subvol-<new>-disk-<n>

# storage.cfg lookups: "<type>: <id>" header, "<tab>pool <dataset>" property.
storage_type() {
  awk -v id="$1" '/^[a-z]+: / { t = $1; sub(/:$/, "", t); if ($2 == id) { print t; exit } }' \
    /etc/pve/storage.cfg
}
storage_pool() {
  awk -v id="$1" '/^[a-z]+: / { cur = $2; next } cur == id && $1 == "pool" { print $2; exit }' \
    /etc/pve/storage.cfg
}

# Main section of the source config (up to the first [snapshot]/[pending]).
MAIN_CONF_FILE=$(mktemp)
awk '/^\[/ { exit } { print }' "$SOURCE_CONF" > "$MAIN_CONF_FILE"

# Volume mountpoints: "rootfs: <storage>:<volname>,..." / "mpN: ...". Bind
# mounts start with "/" and were already removed from the config above.
VOLUMES_FILE=$(mktemp)
awk -F': ' '$1 ~ /^(rootfs|mp[0-9]+)$/ && $2 !~ /^\// {
  vol = $2; sub(/,.*/, "", vol); print $1, vol
}' "$MAIN_CONF_FILE" > "$VOLUMES_FILE"

zfs_clone_possible() {
  [ "$(storage_type "$ROOTFS_STORAGE")" = "zfspool" ] || return 1
  [ -n "$(storage_pool "$ROOTFS_STORAGE")" ] || return 1
  [ -s "$VOLUMES_FILE" ] || return 1
  while read -r _key _volid; do
    _sid="${_volid%%:*}"
    _volname="${_volid#*:}"
    [ "$(storage_type "$_sid")" = "zfspool" ] || return 1
    [ -n "$(storage_pool "$_sid")" ] || return 1
    case "$_volname" in subvol-*) ;; *) return 1 ;; esac
    zfs list -H -o name "$(storage_pool "$_sid")/$_volname@$SNAPNAME" >/dev/null 2>&1 || return 1
  done < "$VOLUMES_FILE"
  return 0
}

# Datasets created on the target pool (for cleanup) and "<key> <new volid>".
CREATED_FILE=$(mktemp)
MAPPING_FILE=$(mktemp)

# Copy every volume: zfs send -p (properties like refquota/acltype/xattr come
# along) of the single snapshot — not -R, which would drag older snapshots of
# the source along as orphans — into the next free subvol-<new>-disk-<n>.
zfs_copy_volumes() {
  _tgt_pool=$(storage_pool "$ROOTFS_STORAGE")
  _n=0
  while read -r _key _volid; do
    _src_ds="$(storage_pool "${_volid%%:*}")/${_volid#*:}"
    while zfs list -H -o name "$_tgt_pool/subvol-$TARGET_VMID-disk-$_n" >/dev/null 2>&1; do
      _n=$((_n + 1))
    done
    _new="subvol-$TARGET_VMID-disk-$_n"
    _n=$((_n + 1))
    log "zfs send $_src_ds@$SNAPNAME -> $_tgt_pool/$_new ($_key)"
    echo "$_tgt_pool/$_new" >> "$CREATED_FILE"
    zfs send -p "$_src_ds@$SNAPNAME" | zfs recv "$_tgt_pool/$_new" >&2 || return 1
    zfs list -H -o name "$_tgt_pool/$_new@$SNAPNAME" >/dev/null 2>&1 || return 1
    zfs destroy "$_tgt_pool/$_new@$SNAPNAME" >&2 || return 1
    echo "$_key $ROOTFS_STORAGE:$_new" >> "$MAPPING_FILE"
  done < "$VOLUMES_FILE"
}

zfs_clone_cleanup() {
  log "Cleaning up partial clone $TARGET_VMID"
  while read -r _ds; do
    zfs destroy -r "$_ds" >&2 2>/dev/null || log "Warning: could not destroy $_ds"
  done < "$CREATED_FILE"
  # Only what this script created — never a config someone else reserved.
  if [ "$TARGET_CONF_CREATED" = true ]; then
    rm -f "${CONFIG_DIR}/${TARGET_VMID}.conf" "/etc/pve/firewall/${TARGET_VMID}.fw"
  fi
}

zfs_clone() {
  # Reserve the VMID with a locked placeholder config — never one that names
  # the source volumes: destroying the target must not touch the source.
  if [ -e "${CONFIG_DIR}/${TARGET_VMID}.conf" ]; then
    log "VMID $TARGET_VMID was taken in the meantime"
    return 1
  fi
  printf 'lock: create\n' > "${CONFIG_DIR}/${TARGET_VMID}.conf" || return 1
  TARGET_CONF_CREATED=true

  run_with_heartbeat "zfs clone $SOURCE_VMID -> $TARGET_VMID" zfs_copy_volumes || return 1

  # Target config: source main section with the new volumes, without
  # snapshot/lock/template state and without MAC addresses; still locked.
  awk -v map="$MAPPING_FILE" '
    BEGIN { while ((getline line < map) > 0) { split(line, p, " "); newvol[p[1]] = p[2] } }
    /^(parent|lock|template|snaptime|snapstate|unused[0-9]+): / { next }
    /^net[0-9]+: / {
      sub(/,hwaddr=[^,]*/, ""); sub(/ hwaddr=[^,]*,?/, " "); print; next
    }
    {
      key = $0; sub(/:.*/, "", key)
      if (key in newvol) {
        rest = $0; sub(/^[^ ]+ [^,]*/, "", rest)
        print key ": " newvol[key] rest; next
      }
      print
    }
    END { print "lock: create" }
  ' "$MAIN_CONF_FILE" > "${CONFIG_DIR}/${TARGET_VMID}.conf" || return 1

  if [ -f "/etc/pve/firewall/${SOURCE_VMID}.fw" ]; then
    cp "/etc/pve/firewall/${SOURCE_VMID}.fw" "/etc/pve/firewall/${TARGET_VMID}.fw" || return 1
  fi

  pct unlock "$TARGET_VMID" >&2 || return 1
  # New MAC per interface, the way pct clone does it: PVE fills a missing
  # hwaddr with a random address (datacenter mac_prefix) and persists it.
  for _net in $(awk -F': ' '/^net[0-9]+: / { print $1 }' "${CONFIG_DIR}/${TARGET_VMID}.conf"); do
    _spec=$(awk -F': ' -v k="$_net" '$1 == k { print $2; exit }' "${CONFIG_DIR}/${TARGET_VMID}.conf")
    pct set "$TARGET_VMID" -"$_net" "$_spec" >&2 || return 1
  done
}

clone_ok=true
TARGET_CONF_CREATED=false
if zfs_clone_possible; then
  log "Cloning $SOURCE_VMID → $TARGET_VMID (snapshot $SNAPNAME, storage $ROOTFS_STORAGE, zfs send/recv)..."
  if ! zfs_clone; then
    clone_ok=false
    zfs_clone_cleanup
  fi
else
  log "Cloning $SOURCE_VMID → $TARGET_VMID (snapshot $SNAPNAME, storage $ROOTFS_STORAGE, pct clone --full)..."
  run_with_heartbeat "pct clone $SOURCE_VMID -> $TARGET_VMID" \
    pct clone "$SOURCE_VMID" "$TARGET_VMID" \
      --snapname "$SNAPNAME" \
      --full \
      --storage "$ROOTFS_STORAGE" >&2 \
    || clone_ok=false
fi
rm -f "$MAIN_CONF_FILE" "$VOLUMES_FILE" "$CREATED_FILE" "$MAPPING_FILE"

# With --full the target is independent of the snapshot, so we can drop it.
pct delsnapshot "$SOURCE_VMID" "$SNAPNAME" >&2 \
  || log "Warning: could not delete snapshot $SNAPNAME on $SOURCE_VMID"

# Restore bind mounts on source — done whether clone succeeded or not.
restore_source_binds
rm -f "$BIND_MOUNTS_FILE"

if [ "$clone_ok" != true ]; then
  fail "Failed to clone container $SOURCE_VMID to $TARGET_VMID"
fi

# Copy bind mounts to target as well: the cloned config inherited none
# (we deleted them from source before snapshot). The new container needs the
# same host-path mounts to function.
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"
if [ -f "$TARGET_CONF" ]; then
  pct config "$SOURCE_VMID" | while IFS= read -r line; do
    case "$line" in
      mp[0-9]*:\ /*)
        mpkey=$(echo "$line" | cut -d: -f1)
        mpval=$(echo "$line" | sed "s/^${mpkey}: //")
        log "Adding bind mount $mpkey to target $TARGET_VMID"
        pct set "$TARGET_VMID" -"$mpkey" "$mpval" >&2 || true
        ;;
    esac
  done
fi

# Keep cloned volume mounts on target.
# pct clone --full copies all volumes with their data (compose files,
# docker cache, app data). Template 150/160 will detect existing mounts
# and skip re-creation.

# Volume mounts are NOT restored on target — Template 150/160 in the
# pre_start flow creates fresh managed volumes for the new container.

# Source container keeps running — it will be destroyed by post-cleanup-previous-container

# Update lxc.console.logfile VMID in cloned config
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"
if [ -f "$TARGET_CONF" ] && grep -q "lxc.console.logfile:" "$TARGET_CONF"; then
  sed -i "s/-${SOURCE_VMID}\.log/-${TARGET_VMID}.log/" "$TARGET_CONF"
  log "Updated lxc.console.logfile VMID: $SOURCE_VMID -> $TARGET_VMID"
fi

# Re-stamp the serial replug watcher onto the new VMID. `pct clone` already
# carried over the lxc.mount.entry / lxc.cgroup2.devices.allow lines, but the
# host-side udev rule + systemd unit are keyed by VMID and still point at the
# source container — without this the device would no longer rebind into the
# clone after a USB hot-replug. migrate_device_mapping (idempotent for the
# already-cloned lxc lines) comes from the prepended device-mapping-common.sh.
migrate_device_mapping "$SOURCE_VMID" "$TARGET_VMID"

# Override the searchdomain Proxmox would otherwise inherit from the host's
# `hostname -d`. See conf-create-lxc-container.sh for the rationale —
# inherited search suffixes break bare-hostname DNS resolution from inside
# docker containers. Default empty.
SEARCHDOMAIN_VAL="{{ searchdomain }}"
[ "$SEARCHDOMAIN_VAL" = "NOT_DEFINED" ] && SEARCHDOMAIN_VAL=""
pct set "$TARGET_VMID" --searchdomain "$SEARCHDOMAIN_VAL" >&2 || \
  log "Warning: pct set --searchdomain on $TARGET_VMID failed"

# Determine volume_storage from rootfs storage
VOLUME_STORAGE="$ROOTFS_STORAGE"

# Extract installed addons from source
INSTALLED_ADDONS=$(extract_addons "$SOURCE_DESC$SOURCE_CONF_TEXT")

# Read the actual container hostname from the source config and emit it as
# an output. This overrides the (possibly stale or compose-project-suffixed)
# {{ hostname }} template variable for every downstream pre_start/post_start
# template — outputs win over inputs in the variable resolver. Without this,
# scripts that call resolve_host_volume "{{ hostname }}" "<key>" "<vmid>" on
# reconfigure would search for volumes named after the wrong hostname and
# fail.
SOURCE_HOSTNAME=$(awk '/^hostname:/ {print $2; exit}' "$SOURCE_CONF" 2>/dev/null || true)

log "Clone prepared: source=$SOURCE_VMID target=$TARGET_VMID volume_storage=$VOLUME_STORAGE addons=$INSTALLED_ADDONS hostname=$SOURCE_HOSTNAME"

printf '[{"id":"vm_id","value":"%s"},{"id":"previous_vm_id","value":"%s"},{"id":"installed_addons","value":"%s"},{"id":"volume_storage","value":"%s"},{"id":"hostname","value":"%s"}]' \
  "$TARGET_VMID" "$SOURCE_VMID" "$INSTALLED_ADDONS" "$VOLUME_STORAGE" "$SOURCE_HOSTNAME"
