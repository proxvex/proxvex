#!/bin/sh
# Set project-specific defaults (Video 2: production setup).
# Adds oidc_issuer_url for public OIDC via nginx (auth.ohnewarum.de).
# Overwrites the v1 template.
#
# Usage: ./production/project.sh

set -e

CONFIG_VOL="/rpool/data/subvol-999999-oci-lxc-deployer-volumes/volumes/oci-lxc-deployer/config"
SHARED_VOL="${CONFIG_VOL}/shared/templates"

echo "=== Setting project defaults ==="

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults for ohnewarum.de",
  "commands": [
    { "properties": { "id": "vm_id_start", "default": "500" } },
    { "properties": { "id": "oidc_issuer_url", "default": "https://auth.ohnewarum.de" } },
    { "properties": { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" } },
    { "properties": { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" } }
  ]
}
EOF

# Ownership vom config-Verzeichnis übernehmen (hat korrekte Container-UID)
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "  Template written to ${SHARED_VOL}/create_ct/050-set-project-parameters.json"
echo "=== Project defaults configured ==="
