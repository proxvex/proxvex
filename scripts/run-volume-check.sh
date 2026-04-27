#!/bin/sh
# Run the volume consistency check standalone on a PVE host.
#
# Concatenates the libraries the template engine would prepend (pve-common.sh,
# vol-common.sh) with host-check-volume-consistency.sh and pipes the combined
# script via stdin to ssh. Exit code is the check exit code.
#
# Usage:
#   ./scripts/run-volume-check.sh <pve-host> [ssh-port]
#
# Examples:
#   ./scripts/run-volume-check.sh ubuntupve 1222    # yellow nested-VM
#   ./scripts/run-volume-check.sh pve1.cluster      # production PVE host
set -eu

PVE_HOST="${1:?usage: $0 <pve-host> [ssh-port]}"
SSH_PORT="${2:-22}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/json/shared/scripts/library"
SCRIPT="$ROOT/json/shared/scripts/check/host-check-volume-consistency.sh"

cat "$LIB/pve-common.sh" "$LIB/vol-common.sh" "$SCRIPT" \
  | ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=10 \
        -p "$SSH_PORT" "root@$PVE_HOST" "sh -s"
