#!/bin/bash
set -e

PVE_HOST="pve1.cluster"
PORT_PVE_SSH=22

SSH_CMD="ssh -o StrictHostKeyChecking=no -p $PORT_PVE_SSH root@$PVE_HOST"

cleanup_postgres_db() {
  local db_name="$1"
  local pg_vmid=500
  echo "=== Cleaning up postgres database: $db_name ==="
  $SSH_CMD "pct exec $pg_vmid -- psql -U postgres -c \
    \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db_name' AND pid<>pg_backend_pid();\" \
    -c \"DROP DATABASE IF EXISTS $db_name;\" \
    -c \"DROP USER IF EXISTS $db_name;\"" || true
}

destroy_vm() {
  local vmid="$1"
  local name="$2"
  echo "=== Destroying $name (VM $vmid) ==="
  $SSH_CMD "pct stop $vmid 2>/dev/null; pct destroy $vmid --force --purge" || true
}

# Reverse dependency order: gitea → zitadel → nginx → postgres
case "${1:-all}" in
  gitea)
    cleanup_postgres_db gitea
    destroy_vm 503 gitea
    ;;
  zitadel)
    cleanup_postgres_db zitadel
    destroy_vm 502 zitadel
    ;;
  nginx)
    destroy_vm 501 nginx
    ;;
  postgres)
    destroy_vm 500 postgres
    ;;
  all)
    cleanup_postgres_db gitea
    destroy_vm 503 gitea
    cleanup_postgres_db zitadel
    destroy_vm 502 zitadel
    destroy_vm 501 nginx
    destroy_vm 500 postgres
    ;;
  *) echo "Usage: $0 [postgres|nginx|zitadel|gitea|all]"; exit 1 ;;
esac
