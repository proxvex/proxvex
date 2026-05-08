#!/bin/sh
# Set project-specific defaults (Video 2: production setup).
# Adds oidc_issuer_url for public OIDC via nginx (auth.ohnewarum.de).
# Overwrites the v1 template.
#
# Usage: ./production/project.sh

set -e

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-proxvex}"

# Find the *running* container with this hostname — name-only matching across
# /rpool/data/ would match leftover subvols from previously-replaced containers
# (silent data corruption: project params landed on the wrong volume).
VMID=$(pct list 2>/dev/null \
  | awk -v h="$DEPLOYER_HOSTNAME" 'NR>1 && $2=="running" && $NF==h {print $1; exit}')

if [ -z "$VMID" ]; then
  echo "ERROR: No running container with hostname '$DEPLOYER_HOSTNAME' found"
  echo "  Set DEPLOYER_HOSTNAME to match the deployer container hostname."
  exit 1
fi

# Resolve the /config mountpoint volume directly from this VMID's pct config.
CONFIG_VOLID=$(pct config "$VMID" 2>/dev/null \
  | awk '/^mp[0-9]+:.*[ ,]mp=\/config([, ]|$)/ {
      sub(/^mp[0-9]+:[[:space:]]+/, "");
      split($0, a, ",");
      print a[1];
      exit
    }')

if [ -z "$CONFIG_VOLID" ]; then
  echo "ERROR: VMID $VMID has no mountpoint at /config"
  exit 1
fi

CONFIG_VOL=$(pvesm path "$CONFIG_VOLID" 2>/dev/null || true)
if [ -z "$CONFIG_VOL" ] || [ ! -d "$CONFIG_VOL" ]; then
  echo "ERROR: Could not resolve config volume path (volid=$CONFIG_VOLID, path=$CONFIG_VOL)"
  exit 1
fi

echo "Using config volume of running VMID $VMID: $CONFIG_VOL"

SHARED_VOL="${CONFIG_VOL}/shared/templates"

echo "=== Setting project defaults ==="

mkdir -p "${SHARED_VOL}/create_ct"
cat > "${SHARED_VOL}/create_ct/050-set-project-parameters.json" << 'EOF'
{
  "name": "Set Project Parameters",
  "description": "Project-specific defaults for ohnewarum.de",
  "commands": [
    {
      "properties": [
        { "id": "vm_id_start", "default": "500" },
        { "id": "oidc_issuer_url", "default": "https://auth.ohnewarum.de" },
        { "id": "alpine_mirror", "default": "https://mirror1.hs-esslingen.de/Mirrors/alpine/" },
        { "id": "debian_mirror", "default": "http://mirror.23m.com/debian/" },
        { "id": "docker_registry_mirror", "default": "https://docker-registry-mirror" },
        { "id": "ghcr_registry_mirror", "default": "https://zot-mirror" }
      ]
    }
  ]
}
EOF

# Ownership vom config-Verzeichnis übernehmen (hat korrekte Container-UID)
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "  Template written to ${SHARED_VOL}/create_ct/050-set-project-parameters.json"
echo "=== Project defaults configured ==="
