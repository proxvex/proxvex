#!/bin/bash
# Tabula rasa: back up the router, then destroy every LXC on the PVE host and
# wipe container logs. No hostname filter, no exceptions — every pct container
# is stopped and purged.
#
# Usage: ./production/destroy.sh [--yes]
#
# After this, run ./production/setup-production.sh --all to rebuild.

set -e

PVE_HOST="${PVE_HOST:-pve1.cluster}"
ROUTER_HOST="${ROUTER_HOST:-router-kg}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
SSH_OPTS="-o StrictHostKeyChecking=no"
SSH_CMD="ssh $SSH_OPTS root@${PVE_HOST}"
ROUTER_SSH="ssh $SSH_OPTS root@${ROUTER_HOST}"

if [ "${1:-}" != "--yes" ]; then
  echo "This will destroy EVERY LXC on ${PVE_HOST} and wipe /var/log/lxc."
  echo "A sysupgrade backup of ${ROUTER_HOST} is taken first."
  echo "There is no undo."
  printf "Type 'DESTROY' to continue: "
  read -r confirm
  [ "$confirm" = "DESTROY" ] || { echo "Aborted."; exit 1; }
fi

echo "=== Backing up ${ROUTER_HOST} to ${BACKUP_DIR} ==="
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
REMOTE_BACKUP="/tmp/router-kg-backup-${TS}.tar.gz"
$ROUTER_SSH "umask 077; sysupgrade -b '$REMOTE_BACKUP'" || {
  echo "ERROR: router backup failed — aborting destroy." >&2
  exit 1
}
scp $SSH_OPTS "root@${ROUTER_HOST}:${REMOTE_BACKUP}" "$BACKUP_DIR/" || {
  echo "ERROR: failed to download router backup — aborting destroy." >&2
  exit 1
}
$ROUTER_SSH "uci export uhttpd; echo '---FIREWALL---'; uci export firewall; echo '---DHCP---'; uci export dhcp" \
  > "$BACKUP_DIR/router-kg-uci-${TS}.txt"
echo "  Router backup saved: $BACKUP_DIR/router-kg-backup-${TS}.tar.gz"
echo "  UCI dump saved:      $BACKUP_DIR/router-kg-uci-${TS}.txt"

echo "=== Removing dns.sh entries from ${ROUTER_HOST} (marker: managed='prod-setup') ==="
$ROUTER_SSH '
  set -e
  TAG="prod-setup"

  purge() {
    cfg="$1"  # dhcp or firewall
    svc="$2"  # dnsmasq or firewall
    sections=$(uci show "$cfg" 2>/dev/null | grep "\.managed='"'"'$TAG'"'"'$" | cut -d. -f1-2 | sort -u)
    if [ -z "$sections" ]; then
      echo "  $cfg: no tagged entries found."
      return
    fi
    for section in $sections; do
      uci delete "$section" && echo "  Deleted $section"
    done
    uci commit "$cfg"
    /etc/init.d/"$svc" restart
  }

  purge dhcp     dnsmasq
  purge firewall firewall
' || {
  echo "ERROR: router cleanup failed — aborting before PVE destruction." >&2
  exit 1
}

echo "=== Destroying all LXCs on ${PVE_HOST} ==="
$SSH_CMD '
  set -e
  vmids=$(pct list | awk "NR>1{print \$1}")
  if [ -z "$vmids" ]; then
    echo "  No containers found."
  else
    for vmid in $vmids; do
      echo "  Destroying VM $vmid"
      pct stop "$vmid" 2>/dev/null || true
      pct destroy "$vmid" --purge --force || echo "  WARNING: pct destroy $vmid failed"
    done
  fi

  echo "=== Destroying ZFS subvolumes in rpool/data ==="
  for ds in $(zfs list -H -o name -r rpool/data | tail -n +2 | sort -r); do
    # Skip the pool dataset itself
    [ "$ds" = "rpool/data" ] && continue
    echo "  Destroying $ds"
    zfs destroy -f "$ds" 2>/dev/null || echo "  WARNING: zfs destroy $ds failed"
  done
  echo "  Remaining datasets:"
  zfs list -H -o name -r rpool/data 2>/dev/null || true

  echo "=== Removing deployer CA from system trust store ==="
  rm -f /usr/local/share/ca-certificates/oci-lxc-deployer-ca.crt 2>/dev/null || true
  rm -f /usr/share/ca-certificates/oci-lxc-deployer-ca.crt 2>/dev/null || true
  sed -i "/oci-lxc-deployer-ca.crt/d" /etc/ca-certificates.conf 2>/dev/null || true
  update-ca-certificates >/dev/null 2>&1 || true
  echo "  CA certificate removed from trust store"

  echo "=== Removing registry mirror /etc/hosts entries ==="
  sed -i "/oci-lxc-deployer: registry mirror/d" /etc/hosts 2>/dev/null || true

  echo "=== Wiping /var/log/lxc ==="
  rm -rf /var/log/lxc/* 2>/dev/null || true
  ls -la /var/log/lxc 2>/dev/null || true
'

echo ""
echo "Done. Next: ./production/setup-production.sh --all"
