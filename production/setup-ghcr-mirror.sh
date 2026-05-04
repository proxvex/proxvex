#!/bin/sh
# Site customization: install the GHCR Registry Mirror application as a local
# override on the production deployer Hub, then deploy it to the configured
# host (defaults to ubuntupve via host_for_app in setup-production.sh).
#
# Why local override (vs. shipping the app under json/applications/):
#   The application's properties (vm_id, static_ip, gateway, etc.) are
#   site-specific. Putting the file in the deployer's /config volume keeps it
#   out of the repository and out of the OCI image — same pattern as
#   project.sh, which writes /config/shared/templates/050-set-project-parameters.json.
#
# Why the mirror exists at all:
#   Test/CI hosts run a nested Proxmox VM whose dnsmasq DNS-redirects
#   ghcr.io to a local mirror so that LXCs inside it (notably docker-compose
#   apps like zitadel) can pull images without double-NAT TLS issues. The
#   inner Docker daemons must reach a registry that serves valid TLS — that
#   is this mirror. Production apps do NOT use the mirror (no DNS forward in
#   production); `latest` keeps fetching directly from ghcr.io.
#
# Usage: ./production/setup-ghcr-mirror.sh
#   DEPLOYER_HOSTNAME (env)  hostname of the deployer LXC (default: proxvex)
#   GHCR_MIRROR_HOST  (env)  PVE host to deploy on (default: ubuntupve)

set -e

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-proxvex}"
GHCR_MIRROR_HOST="${GHCR_MIRROR_HOST:-ubuntupve}"

# Locate the running deployer container and its /config mountpoint.
# Same logic as production/project.sh:14-42 — find by hostname=running, then
# resolve the mp= /config volume directly from pct config.
VMID=$(pct list 2>/dev/null \
  | awk -v h="$DEPLOYER_HOSTNAME" 'NR>1 && $2=="running" && $NF==h {print $1; exit}')

if [ -z "$VMID" ]; then
  echo "ERROR: No running container with hostname '$DEPLOYER_HOSTNAME' found"
  echo "  Set DEPLOYER_HOSTNAME to match the deployer container hostname."
  exit 1
fi

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

# 1. Write the application override into /config/applications/.
#    The deployer's local layer (CMD --local /config in Dockerfile.npm-pack:87)
#    discovers it via path.join(localPath, "applications", appName, "application.json")
#    in application-persistence-handler.mts:258, taking precedence over json/.
APP_DIR="${CONFIG_VOL}/applications/ghcr-registry-mirror"
mkdir -p "$APP_DIR"

cat > "${APP_DIR}/application.json" <<'EOF'
{
  "name": "GHCR Registry Mirror",
  "description": "Pull-through cache for ghcr.io. Site infrastructure for test/CI hosts; production apps do not consume it.",
  "extends": "docker-registry-mirror",
  "icon": "icon.svg",
  "properties": [
    { "id": "hostname", "default": "ghcr-mirror" },
    { "id": "vm_id", "default": "601" },
    { "id": "static_ip", "default": "192.168.4.48/24" },
    { "id": "gateway", "default": "192.168.4.1" },
    { "id": "bridge", "default": "vmbr0" },
    { "id": "nameserver", "default": "192.168.4.1" },
    { "id": "memory", "default": "1024" },
    { "id": "rootfs_storage", "default": "local-zfs" },
    { "id": "disk_size", "default": "5" },
    { "id": "envs", "default": "REGISTRY_HTTP_ADDR=:443\nREGISTRY_HTTP_TLS_CERTIFICATE=/etc/ssl/addon/fullchain.pem\nREGISTRY_HTTP_TLS_KEY=/etc/ssl/addon/privkey.pem\nREGISTRY_PROXY_REMOTEURL=https://ghcr.io\nREGISTRY_PROXY_USERNAME={{ DOCKER_HUB_USERNAME }}\nREGISTRY_PROXY_PASSWORD={{ DOCKER_HUB_PASSWORD }}" },
    { "id": "ssl_additional_san", "value": "DNS:ghcr.io" }
  ],
  "tags": ["infrastructure"]
}
EOF

# Same chown pattern as project.sh:69 — match the existing /config ownership
# so the deployer process inside the container can read the file.
chown -R --reference="${CONFIG_VOL}" "${CONFIG_VOL}"

echo "App definition written to ${APP_DIR}/application.json"

# 2. Reload the deployer so it picks up the new application.
#    Try HTTPS first (production deployer post-Step 6) and fall back to HTTP
#    (which is what's available right after Step 5 / before ACME).
if curl -sk --connect-timeout 5 -X POST "https://${DEPLOYER_HOSTNAME}:3443/api/reload" -o /dev/null; then
  echo "Deployer reloaded via HTTPS"
elif curl -sf --connect-timeout 5 -X POST "http://${DEPLOYER_HOSTNAME}:3080/api/reload" -o /dev/null; then
  echo "Deployer reloaded via HTTP"
else
  echo "WARN: deployer reload call failed — continuing; deploy.sh will fail clearly if reload was needed"
fi

# 3. Deploy via the standard production deploy.sh wrapper. Same pattern as
#    setup-production.sh Step 5 (docker-registry-mirror) and Step 14
#    (github-runner): deploy.sh translates --host into --ve for the CLI.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/deploy.sh" --host "$GHCR_MIRROR_HOST" ghcr-registry-mirror

echo ""
echo "GHCR Registry Mirror deployed:"
echo "  Host:     $GHCR_MIRROR_HOST"
echo "  Hostname: ghcr-mirror"
echo "  Address:  192.168.4.48 (per app default; override in /config/stacks if needed)"
echo "  Test:     curl --resolve ghcr.io:443:192.168.4.48 https://ghcr.io/v2/"
