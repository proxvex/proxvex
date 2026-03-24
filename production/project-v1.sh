#!/bin/sh
# Set project-specific defaults (Video 1: basic setup).
# Sets vm_id_start and package mirrors. No OIDC issuer URL yet —
# addon-oidc defaults to internal Zitadel URL (zitadel:1443).
#
# Usage: ./production/project-v1.sh

set -e

CONFIG_VOL="/rpool/data/subvol-999999-oci-lxc-deployer-volumes/volumes/oci-lxc-deployer/config"
SHARED_VOL="${CONFIG_VOL}/shared/templates"

echo "=== Setting project defaults (v1) ==="

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults for ohnewarum.de",
  "commands": [
    { "properties": { "id": "vm_id_start", "default": "500" } },
    { "properties": { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" } },
    { "properties": { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" } }
  ]
}
EOF

# Ownership vom config-Verzeichnis übernehmen (hat korrekte Container-UID)
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "  Template written to ${SHARED_VOL}/create_ct/050-set-project-parameters.json"
echo "=== Project defaults (v1) configured ==="
