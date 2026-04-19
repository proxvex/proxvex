#!/bin/bash
# Upload production/ folder to PVE host and re-run setup-nginx.sh.
#
# Usage (from dev machine):
#   ./production/upload-nginx-content.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PVE_HOST="${PVE_HOST:-pve1.cluster}"
SSH_OPTS="-o StrictHostKeyChecking=no"
REMOTE_DIR="/root/production"

echo "=== Uploading production/ to ${PVE_HOST}:${REMOTE_DIR} ==="
rsync -az --delete -e "ssh ${SSH_OPTS}" "$SCRIPT_DIR/" "root@${PVE_HOST}:${REMOTE_DIR}/"
echo "  Done."

echo ""
echo "=== Running setup-nginx.sh on ${PVE_HOST} ==="
ssh ${SSH_OPTS} "root@${PVE_HOST}" "bash ${REMOTE_DIR}/setup-nginx.sh"
