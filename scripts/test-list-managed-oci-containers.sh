#!/bin/sh
# Quick local test harness for json/shared/scripts/list-managed-oci-containers.py
# Creates a temporary Proxmox LXC config dir and runs the scanner against it.

set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/json/shared/scripts/list-managed-oci-containers.py"

if [ ! -f "$SCRIPT" ]; then
  echo "Error: script not found: $SCRIPT" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

LXC_DIR="$TMP_DIR/lxc"
mkdir -p "$LXC_DIR"

cat >"$LXC_DIR/101.conf" <<'EOF'
hostname: cont-101
description: <!-- proxvex:managed -->
 <!-- proxvex:oci-image docker://alpine:3.19 -->
 OCI image: docker://alpine:3.19
EOF

cat >"$LXC_DIR/102.conf" <<'EOF'
hostname: cont-102
description: <!-- proxvex:managed -->
LXC template: local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst
EOF

cat >"$LXC_DIR/103.conf" <<'EOF'
hostname: cont-103
description: <!-- proxvex:oci-image docker://debian:bookworm -->
EOF

cat >"$LXC_DIR/104.conf" <<'EOF'
hostname: cont-104
description: <!-- proxvex:managed -->
OCI image: ghcr.io/example/app:1.2.3
EOF

export LXC_MANAGER_PVE_LXC_DIR="$LXC_DIR"

echo "Running: $SCRIPT" >&2
python3 "$SCRIPT" | tee "$TMP_DIR/raw.json" >&2

echo "\nParsed containers:" >&2

# Pretty-print the resolved list to stdout
python3 -c 'import json; o=json.load(open("'$TMP_DIR'/raw.json")); v=o[0]["value"]; print(json.dumps(json.loads(v), indent=2, sort_keys=True))'
