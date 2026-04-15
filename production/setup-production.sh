#!/bin/bash
# Master orchestrator for production environment setup.
# Follows the deployment flow from docs/deployment-flow.md.
#
# Prerequisites:
#   - Deployer installed manually:
#     ./install-oci-lxc-deployer.sh --vm-id-start 500 --hostname old-prod-hub \
#       --static-ip 192.168.4.51/24 --nameserver 192.168.4.1 --gateway 192.168.4.1 \
#       --deployer-url https://old-prod-hub
#   - SSH access to router (root@router-kg) and PVE host (root@pve1.cluster)
#
# Usage: ./production/setup-production.sh --help
#
# CF_TOKEN (Cloudflare API token) is only needed by step 6 (ACME + Cloudflare).
# If unset and step 6 is about to run, the script prompts interactively.
# You can still pass it via env var if you prefer: CF_TOKEN=xxx $0

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Production Configuration ---
export DEPLOYER_HOST="${DEPLOYER_HOST:-old-prod-hub}"
export DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-$DEPLOYER_HOST}"
export PVE_HOST="${PVE_HOST:-pve1.cluster}"
ROUTER_HOST="${ROUTER_HOST:-router-kg}"

# Secrets
CF_TOKEN="${CF_TOKEN:-}"

# --- Step catalog (keep in sync with banner calls below) ---
print_steps() {
  cat <<'STEPS'
  Steps:
    1   DNS + NAT on router
    2   Verify deployer is reachable
    3   Copy production files to PVE host
    4   Set project defaults (v1)
    5   Deploy docker-registry-mirror
    6   ACME + Production stack (Cloudflare)   [needs CF_TOKEN]
    7   Deploy postgres
    8   Deploy nginx + configure vhosts
    9   Update project defaults (v2 — with OIDC issuer)
    10  Deploy zitadel
    11  Reconfigure deployer with OIDC
    12  Deploy gitea
    13  Deploy eclipse-mosquitto
STEPS
}

usage() {
  cat <<EOF
Usage: $0 [options]

Orchestrates the full production environment setup.

Options:
  --all                 Run all steps (1..99)
  --from-step N         Start at step N (default: 1)
  --to-step M           Stop after step M (default: 99)
  --step N              Run only step N (shorthand for --from-step N --to-step N)
  --retry N             Destroy step N's container (pct stop + pct destroy
                        --purge --force) and then re-run step N. Only allowed
                        for stateless, dependency-free steps:
                          5  docker-registry-mirror
                          8  nginx
                          13 eclipse-mosquitto
  -h, --help            Show this help and exit

Without arguments, this help is shown and nothing is executed.

EOF
  print_steps
  cat <<EOF

Environment:
  DEPLOYER_HOST   default: old-prod-hub
  PVE_HOST        default: pve1.cluster
  ROUTER_HOST     default: router-kg
  CF_TOKEN        Cloudflare API token (prompted in step 6 if unset)
EOF
}

# --- Parse arguments ---
if [ $# -eq 0 ]; then
  usage
  exit 0
fi

START_STEP=1
END_STEP=99
RUN=0
RETRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --all) RUN=1; shift ;;
    --from-step) START_STEP="$2"; RUN=1; shift 2 ;;
    --from-step=*) START_STEP="${1#*=}"; RUN=1; shift ;;
    --to-step)   END_STEP="$2";   RUN=1; shift 2 ;;
    --to-step=*) END_STEP="${1#*=}"; RUN=1; shift ;;
    --step) START_STEP="$2"; END_STEP="$2"; RUN=1; shift 2 ;;
    --step=*) START_STEP="${1#*=}"; END_STEP="${1#*=}"; RUN=1; shift ;;
    --retry)   RETRY=1; START_STEP="$2"; END_STEP="$2"; RUN=1; shift 2 ;;
    --retry=*) RETRY=1; START_STEP="${1#*=}"; END_STEP="${1#*=}"; RUN=1; shift ;;
    *) echo "Unknown argument: $1" >&2; echo "" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$RUN" -ne 1 ]; then
  usage
  exit 0
fi

# Map step → container hostname (only stateless, dependency-free steps)
retry_hostname_for_step() {
  case "$1" in
    5)  echo "docker-registry-mirror" ;;
    8)  echo "nginx" ;;
    13) echo "eclipse-mosquitto" ;;
    *)  echo "" ;;
  esac
}

# Early validation of --retry step (full destroy runs after pve_ssh is defined)
if [ "$RETRY" -eq 1 ] && [ -z "$(retry_hostname_for_step "$START_STEP")" ]; then
  echo "ERROR: --retry not allowed for step ${START_STEP}: not retry-safe (state or dependencies)." >&2
  echo "       Retry-safe steps: 5 (docker-registry-mirror), 8 (nginx), 13 (eclipse-mosquitto)." >&2
  exit 1
fi

# --- Helper functions ---
banner() {
  local step_num="$1"
  local step_name="$2"
  echo ""
  echo "================================================================"
  echo "  Step $step_num: $step_name"
  echo "================================================================"
}

should_run() {
  [ "$1" -ge "$START_STEP" ] && [ "$1" -le "$END_STEP" ]
}

pve_ssh() {
  ssh -o StrictHostKeyChecking=no "root@${PVE_HOST}" "$@"
}

router_ssh() {
  ssh -o StrictHostKeyChecking=no "root@${ROUTER_HOST}" "$@"
}

# --- Handle --retry N: destroy step N's container, then fall through to run step N ---
if [ "$RETRY" -eq 1 ]; then
  retry_host=$(retry_hostname_for_step "$START_STEP")
  echo ""
  echo "================================================================"
  echo "  --retry: destroying step ${START_STEP} container (${retry_host})"
  echo "================================================================"
  retry_vmid=$(pve_ssh "pct list | awk -v h='$retry_host' '\$NF==h{print \$1}'" 2>/dev/null || true)
  if [ -z "$retry_vmid" ]; then
    echo "  no container named '${retry_host}' — nothing to destroy"
  else
    echo "  destroying VM ${retry_vmid} (${retry_host})"
    pve_ssh "pct stop $retry_vmid 2>/dev/null; pct destroy $retry_vmid --purge --force" || {
      echo "ERROR: failed to destroy VM $retry_vmid ($retry_host)" >&2
      exit 1
    }
  fi
fi

# --- Pre-flight checks ---
echo "=== Pre-flight checks ==="

echo "  Checking SSH to PVE host (${PVE_HOST})..."
if ! pve_ssh true 2>/dev/null; then
  echo "ERROR: Cannot SSH to root@${PVE_HOST}"
  exit 1
fi
echo "  OK"

echo "  Checking SSH to router (${ROUTER_HOST})..."
if ! router_ssh true 2>/dev/null; then
  echo "WARNING: Cannot SSH to root@${ROUTER_HOST} — step 1 (DNS) will fail"
fi

echo "  Deployer hostname: ${DEPLOYER_HOST}"
echo "  Starting from step: ${START_STEP}"
echo ""

# ================================================================
# Step 1: DNS on router
# ================================================================
if should_run 1; then
  banner 1 "DNS + NAT on router"
  scp -o StrictHostKeyChecking=no "$SCRIPT_DIR/dns.sh" "root@${ROUTER_HOST}:dns.sh"
  router_ssh "sh dns.sh"
fi

# ================================================================
# Step 2: Verify deployer is reachable (HTTP after fresh install)
# ================================================================
if should_run 2; then
  banner 2 "Verify deployer is reachable"
  if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
    echo "  Deployer reachable at https://${DEPLOYER_HOST}:3443"
  elif curl -sf --connect-timeout 3 "http://${DEPLOYER_HOST}:3080/api/applications" >/dev/null 2>&1; then
    echo "  Deployer reachable at http://${DEPLOYER_HOST}:3080"
  else
    echo "ERROR: Deployer not reachable at ${DEPLOYER_HOST}:3080 (HTTP) or :3443 (HTTPS)"
    echo "  Install it first:"
    echo "    ./install-oci-lxc-deployer.sh --vm-id-start 500 --hostname ${DEPLOYER_HOST} \\"
    echo "      --static-ip 192.168.4.51/24 --nameserver 192.168.4.1 --gateway 192.168.4.1 \\"
    echo "      --deployer-url https://${DEPLOYER_HOST}"
    exit 1
  fi
fi

# ================================================================
# Step 3: Copy production files to PVE host
# ================================================================
if should_run 3; then
  banner 3 "Copy production files to PVE host"
  pve_ssh "mkdir -p production"
  scp -o StrictHostKeyChecking=no "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR"/*.json "$SCRIPT_DIR"/*.html "root@${PVE_HOST}:production/"
  echo "  Files copied to root@${PVE_HOST}:production/"
fi

# ================================================================
# Step 4: Set project defaults (v1 — without OIDC issuer)
# ================================================================
if should_run 4; then
  banner 4 "Set project defaults (v1)"
  pve_ssh "DEPLOYER_HOSTNAME=${DEPLOYER_HOST} sh production/project-v1.sh"
fi

# ================================================================
# Step 5: Deploy docker-registry-mirror
# ================================================================
if should_run 5; then
  banner 5 "Deploy docker-registry-mirror"
  "$SCRIPT_DIR/deploy.sh" docker-registry-mirror
fi

# ================================================================
# Step 6: ACME + Production stack with Cloudflare credentials
# ================================================================
if should_run 6; then
  banner 6 "ACME + Production stack (Cloudflare)"

  # Skip prompt if the cloudflare_production stack already exists in the
  # deployer — setup-acme.sh only creates it with CF_TOKEN, so its presence
  # means the token is already stored securely in the backend.
  if [ -z "$CF_TOKEN" ]; then
    if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/stacks?stacktype=cloudflare" 2>/dev/null \
         | grep -q 'cloudflare_production' \
       || curl -sf --connect-timeout 3 "http://${DEPLOYER_HOST}:3080/api/stacks?stacktype=cloudflare" 2>/dev/null \
         | grep -q 'cloudflare_production'; then
      echo "  cloudflare_production stack already exists in deployer — reusing stored secret."
      CF_TOKEN="__already_stored__"
    fi
  fi

  if [ -z "$CF_TOKEN" ]; then
    echo "  CF_TOKEN not set — prompting now (input hidden)."
    echo "  Create at https://dash.cloudflare.com/profile/api-tokens"
    printf "  CF_TOKEN: "
    stty -echo
    read -r CF_TOKEN
    stty echo
    echo ""
    if [ -z "$CF_TOKEN" ]; then
      echo "ERROR: empty CF_TOKEN — aborting."
      exit 1
    fi
  fi

  if [ "$CF_TOKEN" = "__already_stored__" ]; then
    echo "  Skipping setup-acme.sh (stack already configured)."
  else
    CF_TOKEN="$CF_TOKEN" "$SCRIPT_DIR/setup-acme.sh"
  fi
  unset CF_TOKEN
fi

# ================================================================
# Step 7: Deploy postgres
# ================================================================
if should_run 7; then
  banner 7 "Deploy postgres"
  "$SCRIPT_DIR/deploy.sh" postgres
fi

# ================================================================
# Step 8: Deploy nginx + configure vhosts
# ================================================================
if should_run 8; then
  banner 8 "Deploy nginx + configure vhosts"
  "$SCRIPT_DIR/deploy.sh" nginx
  echo ""
  echo "  Configuring nginx vhosts on PVE host..."
  pve_ssh "sh production/setup-nginx.sh"
fi

# ================================================================
# Step 9: Update project defaults with OIDC issuer URL
# ================================================================
if should_run 9; then
  banner 9 "Update project defaults (v2 — with OIDC issuer)"
  pve_ssh "DEPLOYER_HOSTNAME=${DEPLOYER_HOST} sh production/project.sh"
fi

# ================================================================
# Step 10: Deploy zitadel
#   Zitadel auto-creates OIDC credentials for the deployer
#   in /bootstrap/deployer-oidc.json (post-setup-deployer-in-zitadel.sh)
# ================================================================
if should_run 10; then
  banner 10 "Deploy zitadel"
  "$SCRIPT_DIR/deploy.sh" zitadel.json
fi

# ================================================================
# Step 11: Reconfigure deployer with OIDC (+ native HTTPS)
#   Uses pre-provisioned credentials from Zitadel bootstrap.
# ================================================================
if should_run 11; then
  banner 11 "Reconfigure deployer with OIDC"
  "$SCRIPT_DIR/setup-deployer-oidc.sh"
fi

# ================================================================
# Step 12: Deploy gitea
# ================================================================
if should_run 12; then
  banner 12 "Deploy gitea"
  "$SCRIPT_DIR/deploy.sh" gitea.json
fi

# ================================================================
# Step 13: Deploy eclipse-mosquitto
# ================================================================
if should_run 13; then
  banner 13 "Deploy eclipse-mosquitto"
  "$SCRIPT_DIR/deploy.sh" eclipse-mosquitto
fi

# ================================================================
# Done
# ================================================================
echo ""
echo "================================================================"
echo "  Production setup complete!"
echo "================================================================"
echo ""
echo "  Deployer:    https://${DEPLOYER_HOST}:3443 (OIDC login)"
echo "  Postgres:    192.168.4.40"
echo "  Nginx:       192.168.4.41 (ohnewarum.de, auth, git, nebenkosten)"
echo "  Zitadel:     192.168.4.42 (auth.ohnewarum.de)"
echo "  Gitea:       192.168.4.43 (git.ohnewarum.de)"
echo "  Mosquitto:   192.168.4.44 (mqtt.ohnewarum.de)"
echo "  Registry:    192.168.4.45 (docker-registry-mirror)"
echo ""
