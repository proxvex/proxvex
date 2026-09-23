#!/bin/sh
# Clone the proxvex deployer-CT into a temporary "upgrader" CT.
#
# Stage A of the self-upgrade-via-clone redesign:
#  - Strict same-storage clone (fail-fast, no fallback)
#  - Renames clone to proxvex-upgrader-<unix-ts>
#  - Switches clone's net0 to DHCP
#  - Strips OIDC env vars from clone config
#  - Strips SSL cert mountpoint (so backend serves plain HTTP)
#  - Emits `previous_vm_id=<target>` so the lxc-start.sh self-upgrade fast
#    path is skipped — we are NOT replacing the original; the clone runs
#    in parallel.
#
# Inputs (templated):
#   previous_vm_id : source deployer-CT vmid (the running proxvex)
#   vm_id          : explicit target vmid (optional)
#   vm_id_start    : start of vmid search range (optional, default 100)
#
# Outputs (JSON to stdout):
#   vm_id           : new clone's vmid
#   previous_vm_id  : same as vm_id (neutralizes lxc-start.sh self-upgrade fast path)
#   hostname        : proxvex-upgrader-<ts>
#   source_vm_id    : actual source vmid (for the orchestrator)

set -eu

SOURCE_VMID="{{ previous_vm_id }}"
TARGET_VMID_INPUT="{{ vm_id }}"
VM_ID_START="{{ vm_id_start }}"

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

# ─── Validate ────────────────────────────────────────────────────────────────
if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previous_vm_id is required (source deployer CT vmid)"
fi
[ -f "$SOURCE_CONF" ] || fail "Source container config not found: $SOURCE_CONF"

SOURCE_LOCK=$(awk '/^lock:/ {print $2; exit}' "$SOURCE_CONF" 2>/dev/null || true)
[ -z "$SOURCE_LOCK" ] || fail "Source $SOURCE_VMID is locked ($SOURCE_LOCK). 'pct unlock $SOURCE_VMID' and retry."

SOURCE_DESC=$(extract_description "$SOURCE_CONF")
SOURCE_CONF_TEXT=$(cat "$SOURCE_CONF" 2>/dev/null || echo "")
SOURCE_DESC_DECODED=$(decode_url "$SOURCE_DESC")
SOURCE_CONF_TEXT_DECODED=$(decode_url "$SOURCE_CONF_TEXT")

check_managed_marker "$SOURCE_DESC" "$SOURCE_DESC_DECODED" "$SOURCE_CONF_TEXT" "$SOURCE_CONF_TEXT_DECODED" \
  || fail "Source $SOURCE_VMID does not look like a proxvex-managed CT."

if ! printf '%s' "$SOURCE_CONF_TEXT_DECODED" | grep -q "deployer-instance"; then
  fail "Source $SOURCE_VMID is not the proxvex deployer (no deployer-instance marker)."
fi

# ─── Strict storage detection — NO FALLBACK ──────────────────────────────────
# create-ct-clone.sh has a fallback to "any rootdir-content storage" if
# pct config rootfs: detection fails. For self-upgrade we refuse that:
# managed volumes (subvol-VMID-*) live on the source's rootfs storage; a
# cross-storage clone would put them on a different pool and the
# volume-restore logic in 150-conf-create-storage-volumes-for-lxc.sh would
# not find them.
ROOTFS_STORAGE=$(pct config "$SOURCE_VMID" | grep -a "^rootfs:" | sed 's/^rootfs: *//; s/:.*//')
[ -n "$ROOTFS_STORAGE" ] || fail "Cannot determine source $SOURCE_VMID rootfs storage. Refusing to fall back."
log "Source rootfs storage: $ROOTFS_STORAGE (clone will land here)"

# ─── Target VMID ─────────────────────────────────────────────────────────────
if [ -n "$TARGET_VMID_INPUT" ] && [ "$TARGET_VMID_INPUT" != "NOT_DEFINED" ]; then
  TARGET_VMID="$TARGET_VMID_INPUT"
else
  _id_start="$VM_ID_START"
  [ -n "$_id_start" ] && [ "$_id_start" != "NOT_DEFINED" ] || _id_start="100"
  TARGET_VMID=$(pvesh get /cluster/nextid --vmid "$_id_start" 2>/dev/null || pvesh get /cluster/nextid)
fi
[ "$TARGET_VMID" != "$SOURCE_VMID" ] || fail "Target VMID ($TARGET_VMID) must differ from source ($SOURCE_VMID)"

# ─── Strip bind mounts for snap/clone, restore after ─────────────────────────
BIND_MOUNTS_FILE=$(mktemp)
pct config "$SOURCE_VMID" | while IFS= read -r line; do
  case "$line" in
    mp[0-9]*:\ /*) echo "$line" >> "$BIND_MOUNTS_FILE" ;;
  esac
done

BIND_KEYS=""
if [ -s "$BIND_MOUNTS_FILE" ]; then
  BIND_KEYS=$(awk -F: '{print $1}' "$BIND_MOUNTS_FILE" | paste -sd, -)
  log "Removing bind mounts ($BIND_KEYS) from source for snapshot/clone"
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

# ─── Snapshot + clone --full --storage SAME ──────────────────────────────────
SNAPNAME="selfup-clone-$(date +%s)"
log "Snapshot $SNAPNAME on $SOURCE_VMID..."
if ! pct snapshot "$SOURCE_VMID" "$SNAPNAME" >&2; then
  restore_source_binds; rm -f "$BIND_MOUNTS_FILE"
  fail "pct snapshot $SOURCE_VMID failed"
fi

log "Cloning $SOURCE_VMID → $TARGET_VMID on $ROOTFS_STORAGE (full)..."
clone_ok=true
pct clone "$SOURCE_VMID" "$TARGET_VMID" \
  --snapname "$SNAPNAME" \
  --full \
  --storage "$ROOTFS_STORAGE" >&2 || clone_ok=false

pct delsnapshot "$SOURCE_VMID" "$SNAPNAME" >&2 \
  || log "Warning: could not delete snapshot $SNAPNAME on $SOURCE_VMID"

restore_source_binds
rm -f "$BIND_MOUNTS_FILE"

[ "$clone_ok" = "true" ] || fail "pct clone $SOURCE_VMID → $TARGET_VMID failed"

# ─── Customize clone: hostname, DHCP, strip OIDC, strip SSL mount ────────────
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"
[ -f "$TARGET_CONF" ] || fail "Cloned config $TARGET_CONF missing"

NEW_HOSTNAME="proxvex-upgrader-$(date +%s)"

# Fix lxc.console.logfile vmid in cloned config
if grep -q "lxc.console.logfile:" "$TARGET_CONF"; then
  sed -i "s/-${SOURCE_VMID}\.log/-${TARGET_VMID}.log/" "$TARGET_CONF"
fi

# Detect source bridge + IP/GW. The clone uses the SAME bridge (so it sits
# on the same L2 segment as the deployer it will replace).
#
# Two source-IP modes are supported:
#   1) Source has a static IP (production deployer-CTs run with
#      host-managed=1 + ip=<cidr>): the clone gets a static IP derived
#      from the source by incrementing the last octet by 1..9 (wall-clock
#      mod 9, retry-friendly). Source-CT lock blocks parallel self-
#      upgrades, so octet collisions are practically impossible.
#   2) Source has ip=dhcp (fresh-installed proxvex CTs in nested test
#      environments where dnsmasq serves vmbr1, e.g. proxvex/plain
#      livetest scenario): clone also uses ip=dhcp and gets its IP from
#      the same pool. CLONE_IP is "" pre-start; populated post-pct-start
#      by pct's lease tracking writing back the leased address into
#      /etc/pve/lxc/<vmid>.conf.
SRC_NET0=$(pct config "$SOURCE_VMID" | grep -a "^net0:")
SRC_BRIDGE=$(printf '%s' "$SRC_NET0" | awk -F'[=,]' '{for(i=1;i<=NF;i++) if ($i=="bridge") print $(i+1)}' | head -1)
SRC_IPCIDR=$(printf '%s' "$SRC_NET0" | awk -F'[=,]' '{for(i=1;i<=NF;i++) if ($i=="ip") print $(i+1)}' | head -1)
SRC_GW=$(printf '%s' "$SRC_NET0" | awk -F'[=,]' '{for(i=1;i<=NF;i++) if ($i=="gw") print $(i+1)}' | head -1)
SRC_HOSTMGD=$(printf '%s' "$SRC_NET0" | awk -F'[=,]' '{for(i=1;i<=NF;i++) if ($i=="host-managed") print $(i+1)}' | head -1)
# VLAN tag of the source. On a VLAN-aware bridge an untagged veth port gets
# the bridge default PVID (1), not the VLAN the deployer lives in — a clone
# without the tag then carries a correct-looking static address in the wrong
# VLAN, and the orchestrator waits 300s for an API that cannot answer.
SRC_TAG=$(printf '%s' "$SRC_NET0" | awk -F'[=,]' '{for(i=1;i<=NF;i++) if ($i=="tag") print $(i+1)}' | head -1)
[ -n "$SRC_BRIDGE" ] || SRC_BRIDGE="vmbr0"

if [ -z "$SRC_IPCIDR" ] || [ "$SRC_IPCIDR" = "dhcp" ]; then
  CLONE_MODE="dhcp"
  CLONE_IP=""
  log "Clone net0: bridge=$SRC_BRIDGE ip=dhcp tag=${SRC_TAG:-none} (source ${SRC_IPCIDR:-no-ip}, host-managed=${SRC_HOSTMGD:-0}) — IP learned post-start"
else
  CLONE_MODE="static"
  SRC_IP=${SRC_IPCIDR%/*}
  SRC_PREFIX=${SRC_IPCIDR#*/}
  [ "$SRC_IP" = "$SRC_IPCIDR" ] && SRC_PREFIX="24"
  SRC_NET3=${SRC_IP%.*}
  SRC_LAST=${SRC_IP##*.}

  # Pick a FREE address near the source instead of guessing one. The previous
  # `SRC_LAST + (epoch % 9) + 1` took whatever it landed on: on a populated
  # subnet that can be another guest's address, and the orchestrator then waits
  # its full timeout for an API that answers with RST (ECONNREFUSED) — the
  # clone itself is fine, someone else owns the address.
  #
  # Two probes, both cheap and from the host (which sits in the same VLAN):
  # any address configured on a container of this node, and anything that
  # answers a single ping. A host that is up but drops ICMP would slip
  # through; that is still far better than not looking at all.
  _used_ips=$(for _id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
      pct config "$_id" 2>/dev/null | sed -n 's/^net[0-9]*:.*[,[:space:]]ip=\([0-9.]*\)\/.*/\1/p'
    done)
  CLONE_IP=""
  _try=1
  while [ "$_try" -le 30 ]; do
    _cand_last=$(( SRC_LAST + _try ))
    [ "$_cand_last" -gt 254 ] && _cand_last=$(( _cand_last - 200 ))
    _try=$(( _try + 1 ))
    [ "$_cand_last" -lt 2 ] && continue
    [ "$_cand_last" -eq "$SRC_LAST" ] && continue
    _cand="${SRC_NET3}.${_cand_last}"
    if printf '%s\n' "$_used_ips" | grep -qx "$_cand"; then
      log "Clone IP candidate $_cand is configured on another container — skipping"
      continue
    fi
    if ping -c1 -W1 "$_cand" >/dev/null 2>&1; then
      log "Clone IP candidate $_cand answers ping — skipping"
      continue
    fi
    CLONE_IP="$_cand"
    break
  done
  [ -n "$CLONE_IP" ] || fail "No free address found near ${SRC_NET3}.${SRC_LAST} for the clone"
  CLONE_LAST=${CLONE_IP##*.}
  log "Clone net0: bridge=$SRC_BRIDGE ip=${CLONE_IP}/${SRC_PREFIX} gw=${SRC_GW:-none} tag=${SRC_TAG:-none} (source was $SRC_IPCIDR)"
fi

pct set "$TARGET_VMID" --hostname "$NEW_HOSTNAME" >&2 || fail "pct set hostname failed"
if [ "$CLONE_MODE" = "static" ]; then
  _net0_args="name=eth0,bridge=${SRC_BRIDGE},ip=${CLONE_IP}/${SRC_PREFIX},host-managed=1,firewall=0"
  [ -n "$SRC_GW" ] && _net0_args="${_net0_args},gw=${SRC_GW}"
else
  # Preserve host-managed=1 if the source had it so PVE keeps doing the
  # leasing on the host side (proxvex base image carries no in-guest
  # DHCP client). Auto-generated hwaddr ensures the clone gets a
  # different DHCP lease than the source.
  _net0_args="name=eth0,bridge=${SRC_BRIDGE},ip=dhcp,firewall=0"
  [ "$SRC_HOSTMGD" = "1" ] && _net0_args="${_net0_args},host-managed=1"
fi
# The tag applies to both modes: without it the clone sits in the bridge
# default VLAN and is unreachable (static) or leases from the wrong network
# (dhcp).
[ -n "$SRC_TAG" ] && _net0_args="${_net0_args},tag=${SRC_TAG}"
pct set "$TARGET_VMID" --net0 "$_net0_args" >&2 \
  || fail "pct set --net0 ($CLONE_MODE) failed"
pct set "$TARGET_VMID" --onboot 0 >&2 || true

# Strip OIDC env so the clone backend boots without OIDC enforcement.
sed -i '/^lxc\.environment:[[:space:]]*OIDC_/d' "$TARGET_CONF"

# Inject PROXVEX_URL pointing at the ORIGINAL hub's URL. The clone's backend
# uses this when expanding template defaults for the new CT's Notes
# (proxvex:log-url marker, Links section). Without it the clone uses its own
# request-origin or hostname:port — and that URL points to the ephemeral clone
# IP which gets destroyed right after the upgrade, leaving the new CT with a
# broken log-viewer link.
#
# pct set has no flag for lxc.environment, so we append directly to the conf.
# Strip any prior PROXVEX_URL line first for idempotency.
DEPLOYER_BASE_URL="{{ deployer_base_url }}"
if [ -n "$DEPLOYER_BASE_URL" ] && [ "$DEPLOYER_BASE_URL" != "NOT_DEFINED" ]; then
  sed -i '/^lxc\.environment:[[:space:]]*PROXVEX_URL=/d' "$TARGET_CONF"
  echo "lxc.environment: PROXVEX_URL=$DEPLOYER_BASE_URL" >> "$TARGET_CONF"
  log "Set PROXVEX_URL=$DEPLOYER_BASE_URL on clone $TARGET_VMID (Notes will reference original hub)"
fi

# Strip SSL cert mountpoint so the clone backend falls back to HTTP-only.
# proxvex.mts checks /etc/ssl/addon/{fullchain,privkey}.pem at startup; if
# absent, only the HTTP server is started. Match any mp* that mounts into
# /etc/ssl/addon.
removed=""
while IFS= read -r line; do
  case "$line" in
    mp[0-9]*:*mp=/etc/ssl/addon*)
      mpkey=$(echo "$line" | cut -d: -f1)
      log "Stripping SSL-cert mountpoint $mpkey from clone $TARGET_VMID"
      pct set "$TARGET_VMID" --delete "$mpkey" >&2 || true
      removed="${removed}${mpkey} "
      ;;
  esac
done < "$TARGET_CONF"

# Override searchdomain (inherited from source can break DNS for clone).
SEARCHDOMAIN_VAL="{{ searchdomain }}"
[ "$SEARCHDOMAIN_VAL" = "NOT_DEFINED" ] && SEARCHDOMAIN_VAL=""
pct set "$TARGET_VMID" --searchdomain "$SEARCHDOMAIN_VAL" >&2 || true

# ─── Output ──────────────────────────────────────────────────────────────────
# previous_vm_id=$TARGET_VMID (deliberately, not $SOURCE_VMID) neutralizes
# the lxc-start.sh self-upgrade fast path: that path triggers only when
# PREV_VMID != VMID and source carries the deployer-instance marker. We are
# NOT replacing the source — the clone runs in parallel.
log "Clone ready: source=$SOURCE_VMID target=$TARGET_VMID hostname=$NEW_HOSTNAME ip=$CLONE_IP (stripped SSL: ${removed:-none})"
printf '[{"id":"vm_id","value":"%s"},{"id":"previous_vm_id","value":"%s"},{"id":"hostname","value":"%s"},{"id":"source_vm_id","value":"%s"},{"id":"clone_ip","value":"%s"}]' \
  "$TARGET_VMID" "$TARGET_VMID" "$NEW_HOSTNAME" "$SOURCE_VMID" "$CLONE_IP"
