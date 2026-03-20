#!/bin/bash
# Destroy all production containers including volumes.
# Runs directly on pve1.cluster (no SSH).
#
# Finds containers by hostname (not by fixed VMID).
#
# Usage (on pve1.cluster):
#   ./production/destroy-all.sh          # destroy all
#   ./production/destroy-all.sh gitea    # destroy single app

set -e

# ZFS pool where volumes are stored
ZFS_POOL="rpool/data"

find_vmid() {
  local name="$1"
  pct list 2>/dev/null | awk -v n="$name" '$3 == n {print $1}'
}

destroy_container() {
  local name="$1"
  local vmid
  vmid=$(find_vmid "$name")

  if [ -z "$vmid" ]; then
    echo "  Container '$name' not found, skipping"
    return
  fi

  echo "=== Destroying $name (VM $vmid) ==="
  pct stop "$vmid" 2>/dev/null || true
  pct destroy "$vmid" --force --purge 2>/dev/null || true
  echo "  Container destroyed"

  # Destroy volume subvolumes
  for subvol in $(zfs list -H -o name -r "$ZFS_POOL" 2>/dev/null | grep "\-${name}-volumes"); do
    echo "  Destroying volume: $subvol"
    zfs destroy -r "$subvol" 2>/dev/null || true
  done
}

cleanup_postgres_db() {
  local db_name="$1"
  local pg_vmid
  pg_vmid=$(find_vmid "postgres")

  if [ -z "$pg_vmid" ]; then
    return
  fi

  echo "=== Cleaning up postgres database: $db_name ==="
  pct exec "$pg_vmid" -- psql -U postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db_name' AND pid<>pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS $db_name;" \
    -c "DROP USER IF EXISTS $db_name;" 2>/dev/null || true
}

# Reverse dependency order
case "${1:-all}" in
  gitea)
    cleanup_postgres_db gitea
    destroy_container gitea
    ;;
  zitadel)
    cleanup_postgres_db zitadel
    destroy_container zitadel
    ;;
  nginx)
    destroy_container nginx
    ;;
  postgres)
    destroy_container postgres
    ;;
  deployer)
    destroy_container oci-lxc-deployer
    ;;
  all)
    cleanup_postgres_db gitea
    destroy_container gitea
    cleanup_postgres_db zitadel
    destroy_container zitadel
    destroy_container nginx
    destroy_container postgres
    destroy_container oci-lxc-deployer
    ;;
  *) echo "Usage: $0 [deployer|postgres|nginx|zitadel|gitea|all]"; exit 1 ;;
esac

echo ""
echo "=== Done ==="
