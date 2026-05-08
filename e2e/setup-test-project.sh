#!/bin/bash
# setup-test-project.sh — Configure project-level defaults inside the
# test deployer (Hub LXC at VMID 300 in the nested VM).
#
# Mirrors the role of production/project.sh on pve1 but targets the
# nested-VM Hub via the outer-host SSH port-forward + pct exec. Run
# once after step2b-install-deployer.sh, and again whenever the project
# defaults change.
#
# What the defaults wire up:
#   - docker_registry_mirror = https://docker-mirror-test
#       → post-start-dockerd.sh adds /etc/docker/daemon.json
#         registry-mirrors entry, every docker-compose-based app
#         pulls Docker Hub images via 192.168.4.49.
#   - ghcr_registry_mirror = https://zot-mirror
#       → post-start-dockerd.sh adds /etc/hosts: ghcr.io -> 192.168.4.50.
#         Both mirrors live on ubuntupve, both serve TLS via the proxvex
#         CA already trusted by every test LXC (baseline-installed).
#
# Usage:
#   ./e2e/setup-test-project.sh [instance]   # green | yellow | github-action
#
# Idempotent: writes the same template file each call. The deployer
# reload picks it up; existing apps inherit the defaults at the next
# reconfigure / install.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"
load_config "${1:-}"

# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()    { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-proxvex}"

# Locate the deployer LXC inside the nested VM. config.json's
# defaults.deployerVmid is the canonical pin (300), but we resolve by
# hostname too as a sanity check — guards against a re-renumbered Hub.
info "Locating deployer LXC '${DEPLOYER_HOSTNAME}' inside nested VM..."
deployer_vmid=$(nested_ssh "pct list 2>/dev/null | awk -v h='${DEPLOYER_HOSTNAME}' 'NR>1 && \$2==\"running\" && \$NF==h{print \$1; exit}'" \
    | tr -d '[:space:]')
if [ -z "$deployer_vmid" ]; then
    error "no running container '${DEPLOYER_HOSTNAME}' in nested VM. Run step2b-install-deployer.sh first."
fi
if [ -n "${DEPLOYER_VMID:-}" ] && [ "$deployer_vmid" != "$DEPLOYER_VMID" ]; then
    info "deployerVmid=${DEPLOYER_VMID} in config but actual VMID is ${deployer_vmid} — using actual"
fi
success "Deployer VMID: ${deployer_vmid}"

# Write the project-defaults template into the deployer's /config volume.
# Same shape as production/project.sh's 050-set-project-parameters.json.
# The here-doc body is plain JSON — no template variables — so we use
# `<<JSON` (unquoted) only because there are no `$`s to expand inside.
info "Writing project defaults to deployer..."
nested_ssh "pct exec ${deployer_vmid} -- mkdir -p /config/shared/templates/create_ct" \
    || error "failed to mkdir /config/shared/templates/create_ct in deployer"

nested_ssh "pct exec ${deployer_vmid} -- sh -c 'cat > /config/shared/templates/create_ct/050-set-project-parameters.json' <<'JSON'
{
  \"name\": \"Set Project Parameters (test)\",
  \"description\": \"Project defaults for the ${E2E_INSTANCE} test deployer.\",
  \"commands\": [
    {
      \"properties\": [
        { \"id\": \"vm_id_start\", \"default\": \"301\" },
        { \"id\": \"docker_registry_mirror\", \"default\": \"https://docker-mirror-test\" },
        { \"id\": \"ghcr_registry_mirror\", \"default\": \"https://zot-mirror\" }
      ]
    }
  ]
}
JSON" || error "failed to write project defaults to deployer"

# Match /config volume ownership so the deployer process (running as
# uid 1001 inside the LXC) can read the file. Same pattern as
# production/project.sh:69.
nested_ssh "pct exec ${deployer_vmid} -- sh -c 'chown -R \$(stat -c %u:%g /config) /config/shared'" \
    || info "chown failed (non-fatal — deployer may run as root)"

success "Project defaults written"

# Trigger a deployer reload so the template lands in PersistenceManager
# without a container restart. The Hub API is reachable via the
# port-forward on $PVE_HOST:$PORT_DEPLOYER (HTTP) or :$PORT_DEPLOYER_HTTPS.
info "Reloading deployer (Hub) via port-forward..."
reload_code=$(curl -sk --max-time 10 -X POST \
    "https://${PVE_HOST}:${PORT_DEPLOYER_HTTPS}/api/reload" \
    -o /tmp/test-reload.json -w '%{http_code}' 2>/dev/null || echo "000")
if [ "$reload_code" != "200" ]; then
    reload_code=$(curl -s --max-time 10 -X POST \
        "http://${PVE_HOST}:${PORT_DEPLOYER}/api/reload" \
        -o /tmp/test-reload.json -w '%{http_code}' 2>/dev/null || echo "000")
fi
if [ "$reload_code" = "200" ]; then
    success "Deployer reloaded — defaults active for next install/reconfigure"
else
    info "Deployer /api/reload returned HTTP ${reload_code}; defaults will pick up at the next deployer restart"
fi

echo ""
echo "Project defaults set for instance '${E2E_INSTANCE}':"
echo "  docker_registry_mirror = https://docker-mirror-test"
echo "  ghcr_registry_mirror   = https://zot-mirror"
echo "  vm_id_start            = 301"
echo ""
echo "Every new docker-compose-based app deployed via this Hub will pick up"
echo "these via 307-post-start-dockerd.json — registry-mirrors for Docker Hub,"
echo "/etc/hosts redirect for ghcr.io. No per-app config required."
