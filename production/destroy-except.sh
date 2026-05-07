#!/bin/bash
# Destroy all LXC containers on this PVE host except the three production
# survivors. Runs directly on the PVE host (no SSH).
#
# Keep-list (hardcoded): proxvex, docker-registry-mirror, nginx.
# These three preserve the deployer state, the cached registry images and
# the nginx vhost / acme.sh CA so a fresh production rebuild does not have
# to redo TLS issuance.
#
# Pre-flight: aborts if any of the three is missing — the goal is to keep
# them, so their absence means something is already off and the operator
# should investigate before wiping anything else.
#
# Two phases:
#   1. Locked containers (lock entry in pct config) — pct unlock + force
#      destroy first, since a stuck lock blocks normal stop/destroy.
#   2. Everything else — pct stop + pct destroy --purge --force.
#
# Usage (on pve1.cluster):
#   ./production/destroy-except.sh           # ask for confirmation, then run
#   ./production/destroy-except.sh -y        # skip confirmation

set -eu

KEEP_HOSTS="proxvex docker-registry-mirror nginx"

ASSUME_YES=0
case "${1:-}" in
  -y|--yes) ASSUME_YES=1 ;;
  -h|--help)
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if ! command -v pct >/dev/null 2>&1; then
  echo "ERROR: pct not found. Run this on a Proxmox host." >&2
  exit 1
fi

# Read hostname from pct config (authoritative). Unlike `pct list`'s last
# column, this is unaffected by an optional Lock column shifting fields.
ct_hostname() {
  pct config "$1" 2>/dev/null | awk '/^hostname:/ {print $2; exit}'
}

ct_is_locked() {
  pct config "$1" 2>/dev/null | grep -q '^lock:'
}

is_kept() {
  local hostname="$1"
  for k in $KEEP_HOSTS; do
    [ "$hostname" = "$k" ] && return 0
  done
  return 1
}

ALL_VMIDS=$(pct list 2>/dev/null | awk 'NR>1 {print $1}')

# Pre-flight: every keep-host must be present. If one is missing, the
# operator should investigate before wiping anything — the whole point of
# this script is to preserve those three.
MISSING=""
for host in $KEEP_HOSTS; do
  found=0
  for vmid in $ALL_VMIDS; do
    if [ "$(ct_hostname "$vmid")" = "$host" ]; then
      found=1
      break
    fi
  done
  if [ "$found" -eq 0 ]; then
    MISSING="${MISSING}${host} "
  fi
done
if [ -n "$MISSING" ]; then
  echo "ERROR: keep-list hostname(s) not found on $(hostname): ${MISSING%% }" >&2
  echo "  Expected all of: $KEEP_HOSTS" >&2
  echo "  Aborting — investigate first; nothing has been touched." >&2
  exit 1
fi

# Build the candidate list (VMID + hostname, tab-separated, header stripped,
# keep-hosts filtered out). We resolve the hostname via pct config.

LOCKED_LIST=""
NORMAL_LIST=""
for vmid in $ALL_VMIDS; do
  hostname=$(ct_hostname "$vmid")
  [ -z "$hostname" ] && hostname="(unknown)"
  if is_kept "$hostname"; then
    continue
  fi
  if ct_is_locked "$vmid"; then
    LOCKED_LIST="${LOCKED_LIST}${vmid}	${hostname}
"
  else
    NORMAL_LIST="${NORMAL_LIST}${vmid}	${hostname}
"
  fi
done

if [ -z "$LOCKED_LIST" ] && [ -z "$NORMAL_LIST" ]; then
  echo "No containers to destroy (keep-list: $KEEP_HOSTS)."
  exit 0
fi

echo "Containers on $(hostname):"
echo "  Keep-list: $KEEP_HOSTS"
echo ""
if [ -n "$LOCKED_LIST" ]; then
  echo "  Phase 1 — locked, will be force-destroyed:"
  printf '%s' "$LOCKED_LIST" | awk -F'\t' 'NF==2 { printf "    VMID %-5s  %s\n", $1, $2 }'
  echo ""
fi
if [ -n "$NORMAL_LIST" ]; then
  echo "  Phase 2 — will be stopped and destroyed:"
  printf '%s' "$NORMAL_LIST" | awk -F'\t' 'NF==2 { printf "    VMID %-5s  %s\n", $1, $2 }'
  echo ""
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Type DESTROY to confirm: '
  read -r answer
  if [ "$answer" != "DESTROY" ]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""

# Phase 1 — locked containers first. A lock blocks `pct stop`/`destroy`, so
# unlock unconditionally, then force-destroy. We don't try stop here since
# the container is usually already in a broken/locked state.
if [ -n "$LOCKED_LIST" ]; then
  echo "=== Phase 1: locked containers ==="
  printf '%s' "$LOCKED_LIST" | while IFS='	' read -r vmid hostname; do
    [ -z "$vmid" ] && continue
    echo "  VMID $vmid ($hostname)"
    pct unlock "$vmid" 2>/dev/null || true
    if pct destroy "$vmid" --purge --force; then
      echo "    destroyed"
    else
      echo "    WARN: destroy returned non-zero — check manually" >&2
    fi
  done
  echo ""
fi

# Phase 2 — normal containers. Try stop first, then destroy.
if [ -n "$NORMAL_LIST" ]; then
  echo "=== Phase 2: remaining containers ==="
  printf '%s' "$NORMAL_LIST" | while IFS='	' read -r vmid hostname; do
    [ -z "$vmid" ] && continue
    echo "  VMID $vmid ($hostname)"
    pct stop "$vmid" 2>/dev/null || true
    if pct destroy "$vmid" --purge --force; then
      echo "    destroyed"
    else
      echo "    WARN: destroy returned non-zero — check manually" >&2
    fi
  done
  echo ""
fi

echo "Done. Surviving containers:"
pct list
