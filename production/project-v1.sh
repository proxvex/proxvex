#!/bin/sh
# Set project-specific defaults (Video 1: basic setup).
# Sets vm_id_start and package mirrors. No OIDC issuer URL yet —
# addon-oidc defaults to internal Zitadel URL (zitadel:1443).
#
# Usage: ./production/project-v1.sh

set -e

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-oci-lxc-deployer}"

# Auto-detect config volume path on PVE host
_safe_host=$(echo "$DEPLOYER_HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CONFIG_VOL=$(find /rpool/data/ -maxdepth 1 -name "*-${_safe_host}-config" -type d 2>/dev/null | head -1)

if [ -z "$CONFIG_VOL" ] || [ ! -d "$CONFIG_VOL" ]; then
  echo "ERROR: Cannot find config volume for hostname '$DEPLOYER_HOSTNAME'"
  echo "  Expected pattern: /rpool/data/*-${_safe_host}-config"
  echo "  Set DEPLOYER_HOSTNAME to match the deployer container hostname."
  exit 1
fi

SHARED_VOL="${CONFIG_VOL}/shared/templates"

echo "=== Setting project defaults (v1) ==="

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults for ohnewarum.de (v1, no OIDC issuer)",
  "commands": [
    {
      "properties": [
        { "id": "vm_id_start", "default": "500" },
        { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" },
        { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" }
      ]
    }
  ]
}
EOF

# Ownership vom config-Verzeichnis übernehmen (hat korrekte Container-UID)
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "  Template written to ${SHARED_VOL}/create_ct/050-set-project-parameters.json"
echo "=== Project defaults (v1) configured ==="
