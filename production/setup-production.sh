#!/bin/bash
# Master orchestrator for production environment setup.
# Follows the deployment flow from docs/deployment-flow.md.
#
# Prerequisites:
#   - Deployer installed manually:
#     ./install-proxvex.sh --vm-id-start 500 --hostname proxvex \
#       --static-ip 192.168.4.51/24 --nameserver 192.168.4.1 --gateway 192.168.4.1 \
#       --deployer-url https://proxvex
#   - SSH access to router (root@router-kg) and PVE host (root@pve1.cluster)
#
# Usage: ./production/setup-production.sh --help
#
# CF_TOKEN (Cloudflare API token) is only needed by step 6 (ACME + Cloudflare).
# SMTP_PASSWORD (mail provider password) is only needed by step 6 (OIDC stack).
# If unset and step 6 is about to run, the script prompts interactively.
# You can still pass them via env var if you prefer: CF_TOKEN=xxx SMTP_PASSWORD=yyy $0

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Shared helpers: read_zitadel_admin_pat, init_admin_pat, auth_curl.
# init_admin_pat is invoked in pre-flight after PVE_HOST is resolved.
. "$SCRIPT_DIR/_lib.sh"

# --- Production Configuration ---
export DEPLOYER_HOST="${DEPLOYER_HOST:-proxvex}"
export DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-$DEPLOYER_HOST}"
export PVE_HOST="${PVE_HOST:-pve1.cluster}"   # default for apps without explicit override
ROUTER_HOST="${ROUTER_HOST:-router-kg}"

# --- App → Host mapping ----------------------------------------------------
# Move an application to another PVE host by adding an entry below.
# Apps not listed go to $PVE_HOST (the default). The deploy step looks up
# the target via host_for_app(); the SSH-config + authorized_keys handshake
# is established for every host referenced here, before any deploy runs.
#
# Format: one "<app>=<host>" per line. Implemented as a plain string list
# rather than an associative array so the script also runs under macOS bash
# 3.2 (no `declare -A`).
APP_HOST_MAP="
github-runner=ubuntupve
ghcr-registry-mirror=ubuntupve
docker-mirror-test=ubuntupve
"

host_for_app() {
  local app="$1" line app_name app_host
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    app_name="${line%%=*}"
    app_host="${line#*=}"
    if [ "$app_name" = "$app" ]; then
      echo "$app_host"
      return 0
    fi
  done <<EOF
$APP_HOST_MAP
EOF
  echo "$PVE_HOST"
}

# All distinct hosts currently in use (default + every override).
unique_hosts() {
  {
    echo "$PVE_HOST"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "${line#*=}"
    done <<EOF
$APP_HOST_MAP
EOF
  } | awk '!seen[$0]++'
}

# Installer defaults (used by --bootstrap step 0)
DEPLOYER_VMID_START="${DEPLOYER_VMID_START:-500}"
DEPLOYER_STATIC_IP="${DEPLOYER_STATIC_IP:-192.168.4.51/24}"
DEPLOYER_GATEWAY="${DEPLOYER_GATEWAY:-192.168.4.1}"
DEPLOYER_NAMESERVER="${DEPLOYER_NAMESERVER:-192.168.4.1}"
INSTALLER_URL="${INSTALLER_URL:-https://raw.githubusercontent.com/proxvex/proxvex/main/install-proxvex.sh}"

# Secrets
CF_TOKEN="${CF_TOKEN:-}"
SMTP_PASSWORD="${SMTP_PASSWORD:-}"

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
    14  Deploy github-runner (target: $(host_for_app github-runner))
    15  Deploy node-red
    16  Deploy modbus2mqtt
    17  Deploy ghcr-registry-mirror (target: $(host_for_app ghcr-registry-mirror)) [test/CI infra; optional]
    18  Deploy docker-mirror-test (target: $(host_for_app docker-mirror-test)) [test infra; parallel to step 5]
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
  --bootstrap           From-zero setup: runs production/destroy.sh (tabula rasa,
                        prompts for DESTROY confirmation), then installs the
                        deployer on the PVE host (step 0), then runs steps 1..13.
                        Mutually exclusive with --all/--from-step/--to-step/
                        --step/--retry.
  --json-dev-sync       Before running, copy the local json/ tree (relative to
                        this script) into the deployer container and POST
                        /api/reload so the deployer picks up template/script
                        changes without rebuilding the release. Useful for
                        iteration on template fixes with --retry.
  --force-docker-registry-mirror
                        In step 5, if a 'docker-registry-mirror' container
                        already exists on the PVE host, destroy it before
                        re-deploying. Without this flag the step is skipped
                        with a warning to preserve cached images and avoid
                        Docker Hub pull rate limits.
  --force-nginx         In step 8, if an 'nginx' container already exists on
                        the PVE host, destroy it before re-deploying. Without
                        this flag the deploy is skipped with a warning to
                        avoid hitting Let's Encrypt rate limits via acme.sh.
                        setup-nginx.sh (vhost config) still runs — it is
                        idempotent.
  --force-docker-mirror-test
                        In step 18, if a 'docker-mirror-test' container
                        already exists on ubuntupve, destroy it before
                        re-deploying. Without this flag the step is skipped
                        with a warning to preserve the cached image volume
                        (loss of cache will trigger Docker Hub rate limits on
                        the next step2a pre-pull — restore via
                        production/reseed-docker-mirror-test.sh).
  -h, --help            Show this help and exit

Without arguments, this help is shown and nothing is executed.

EOF
  print_steps
  cat <<EOF

Environment:
  DEPLOYER_HOST        default: proxvex
  PVE_HOST             default: pve1.cluster
  ROUTER_HOST          default: router-kg
  CF_TOKEN             Cloudflare API token (prompted in step 6 if unset)
  DEPLOYER_VMID_START  default: 500           (--bootstrap installer only)
  DEPLOYER_STATIC_IP   default: 192.168.4.51/24
  DEPLOYER_GATEWAY     default: 192.168.4.1
  DEPLOYER_NAMESERVER  default: 192.168.4.1
  INSTALLER_URL        default: github raw install-proxvex.sh
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
BOOTSTRAP=0
JSON_DEV_SYNC=0
FORCE_DRM=0
FORCE_NGINX=0
FORCE_DRM_TEST=0
SCOPE_FLAGS=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --all) RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift ;;
    --from-step) START_STEP="$2"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift 2 ;;
    --from-step=*) START_STEP="${1#*=}"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift ;;
    --to-step)   END_STEP="$2";   RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift 2 ;;
    --to-step=*) END_STEP="${1#*=}"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift ;;
    --step) START_STEP="$2"; END_STEP="$2"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift 2 ;;
    --step=*) START_STEP="${1#*=}"; END_STEP="${1#*=}"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift ;;
    --retry)   RETRY=1; START_STEP="$2"; END_STEP="$2"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift 2 ;;
    --retry=*) RETRY=1; START_STEP="${1#*=}"; END_STEP="${1#*=}"; RUN=1; SCOPE_FLAGS=$((SCOPE_FLAGS + 1)); shift ;;
    --bootstrap) BOOTSTRAP=1; RUN=1; shift ;;
    --json-dev-sync) JSON_DEV_SYNC=1; shift ;;
    --force-docker-registry-mirror) FORCE_DRM=1; shift ;;
    --force-nginx) FORCE_NGINX=1; shift ;;
    --force-docker-mirror-test) FORCE_DRM_TEST=1; shift ;;
    *) echo "Unknown argument: $1" >&2; echo "" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$BOOTSTRAP" -eq 1 ] && [ "$SCOPE_FLAGS" -gt 0 ]; then
  echo "ERROR: --bootstrap is mutually exclusive with --all/--from-step/--to-step/--step/--retry." >&2
  exit 1
fi

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

# Run a command on a specific PVE host (for apps deployed to non-default hosts).
pve_ssh_at() {
  local host="$1"; shift
  ssh -o StrictHostKeyChecking=no "root@${host}" "$@"
}

router_ssh() {
  ssh -o StrictHostKeyChecking=no "root@${ROUTER_HOST}" "$@"
}

# Print VMID(s) of LXC containers with the given hostname on the PVE host.
# Empty output = no container with that hostname exists.
container_vmid_for_hostname() {
  pve_ssh "pct list | awk -v h='$1' '\$NF==h{print \$1}'" 2>/dev/null || true
}

# If a container with $hostname exists and $force_flag != 1, print a boxed
# warning and return 0 (caller should skip the deploy). If $force_flag == 1,
# destroy the existing container(s) and return 1 (caller should deploy).
# If no container exists, return 1 (caller should deploy).
handle_existing_container() {
  local step_num="$1"
  local hostname="$2"
  local force_flag="$3"
  local force_flag_name="$4"
  local rate_limit_hint="$5"
  local existing
  existing=$(container_vmid_for_hostname "$hostname")
  if [ -z "$existing" ]; then
    return 1
  fi
  if [ "$force_flag" -eq 1 ]; then
    echo "  ${force_flag_name}: destroying existing container(s) [${existing}]..."
    for vmid in $existing; do
      pve_ssh "pct stop ${vmid} 2>/dev/null; pct destroy ${vmid} --purge --force" || {
        echo "ERROR: failed to destroy VM ${vmid} (${hostname})" >&2
        exit 1
      }
    done
    return 1
  fi
  echo ""
  echo "  ============================================================"
  echo "  Container '${hostname}' already exists on ${PVE_HOST} (VMID: ${existing})."
  echo "  Skipping step ${step_num} to avoid ${rate_limit_hint}."
  echo "  Force redeploy with: $0 ${force_flag_name} --step ${step_num}"
  echo "  ============================================================"
  echo ""
  return 0
}

# --- Handle --json-dev-sync: push local json/ into deployer + reload ---
# Runs before --retry destroy so the deployer has the updated template/script
# logic when the subsequent redeploy happens.
if [ "$JSON_DEV_SYNC" -eq 1 ]; then
  # /api/reload below requires the Zitadel admin PAT once OIDC is enabled
  # (post-Step 11). init_admin_pat runs again later in pre-flight; this call
  # is idempotent and just makes the PAT available before --json-dev-sync's
  # curl POSTs.
  init_admin_pat "$PVE_HOST"
  JSON_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/json"
  if [ ! -d "$JSON_SRC" ]; then
    echo "ERROR: --json-dev-sync: json directory not found at $JSON_SRC" >&2
    exit 1
  fi
  echo ""
  echo "================================================================"
  echo "  --json-dev-sync: pushing ${JSON_SRC} into deployer + reload"
  echo "================================================================"
  # macOS metadata regenerates constantly — strip it locally before each sync
  # so we never tar it into the container.
  find "$JSON_SRC" -name '.DS_Store' -delete 2>/dev/null || true
  find "$JSON_SRC" -name '._*' -delete 2>/dev/null || true

  deployer_vmid=$(pve_ssh "pct list | awk -v h='$DEPLOYER_HOST' '\$2==\"running\" && \$NF==h{print \$1}'" 2>/dev/null || true)
  if [ -z "$deployer_vmid" ]; then
    echo "ERROR: deployer container '$DEPLOYER_HOST' not found on $PVE_HOST" >&2
    exit 1
  fi
  echo "  Deployer VMID: $deployer_vmid"

  # Build archive locally, then ship it via scp + pct push (pct exec does
  # not reliably pipe stdin through, so we cannot stream tar into it).
  # COPYFILE_DISABLE=1 tells macOS BSD tar NOT to embed AppleDouble (._*)
  # metadata into the archive — those entries are synthesized by tar at
  # stream time and would bypass --exclude. Also strip .DS_Store for safety.
  LOCAL_TARBALL=$(mktemp -t json-dev-sync.XXXXXX.tar.gz)
  trap 'rm -f "$LOCAL_TARBALL"' EXIT
  ( cd "$(dirname "$JSON_SRC")" && \
    COPYFILE_DISABLE=1 tar czf "$LOCAL_TARBALL" \
      --exclude='.DS_Store' \
      --exclude='._*' \
      json ) || {
    echo "ERROR: failed to build local json tarball" >&2
    exit 1
  }

  # Copy to PVE host.
  REMOTE_TARBALL="/tmp/json-dev-sync-$$.tar.gz"
  scp -q -o StrictHostKeyChecking=no "$LOCAL_TARBALL" "root@${PVE_HOST}:${REMOTE_TARBALL}" || {
    echo "ERROR: scp of tarball to ${PVE_HOST} failed" >&2
    exit 1
  }

  # Push into the container, wipe stale json/, untar, clean up.
  pve_ssh "set -e
    pct push $deployer_vmid '$REMOTE_TARBALL' '$REMOTE_TARBALL'
    pct exec $deployer_vmid -- rm -rf /usr/local/lib/node_modules/proxvex/json || true
    pct exec $deployer_vmid -- tar xzf '$REMOTE_TARBALL' -C /usr/local/lib/node_modules/proxvex/
    pct exec $deployer_vmid -- rm -f '$REMOTE_TARBALL'
    rm -f '$REMOTE_TARBALL'
  " || {
    echo "ERROR: json sync into deployer failed" >&2
    exit 1
  }
  echo "  json/ synced into deployer container"

  # Reload the deployer's PersistenceManager. Try HTTPS first, fall back to HTTP.
  # auth_curl injects the Zitadel admin PAT as Bearer when set (post-OIDC).
  reload_code=$(auth_curl -sk --max-time 10 -X POST \
    "https://${DEPLOYER_HOST}:3443/api/reload" \
    -o /tmp/reload-resp.json -w '%{http_code}' 2>/dev/null || echo "000")
  reload_url="https://${DEPLOYER_HOST}:3443/api/reload"
  if [ "$reload_code" != "200" ]; then
    reload_code=$(auth_curl -s --max-time 10 -X POST \
      "http://${DEPLOYER_HOST}:3080/api/reload" \
      -o /tmp/reload-resp.json -w '%{http_code}' 2>/dev/null || echo "000")
    reload_url="http://${DEPLOYER_HOST}:3080/api/reload"
  fi
  if [ "$reload_code" = "200" ]; then
    echo "  Deployer reloaded successfully ($reload_url)"
  else
    echo "ERROR: /api/reload failed — HTTP $reload_code at $reload_url" >&2
    echo "  Response body:" >&2
    cat /tmp/reload-resp.json 2>/dev/null >&2
    echo "" >&2
    exit 1
  fi
fi

# --- Handle --retry N: refresh PVE scripts, destroy step N's container, run step N ---
if [ "$RETRY" -eq 1 ]; then
  retry_host=$(retry_hostname_for_step "$START_STEP")

  # Re-copy production/*.sh|*.json|*.html to the PVE host first. Without this,
  # changes to setup-nginx.sh (or any other PVE-side script) wouldn't take
  # effect on retry — the host would keep running the stale version from the
  # last full Step 3. Cheap and idempotent, so we just always do it.
  echo ""
  echo "================================================================"
  echo "  --retry: refreshing production scripts on ${PVE_HOST}"
  echo "================================================================"
  pve_ssh "mkdir -p production"
  scp -q -o StrictHostKeyChecking=no \
    "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR"/*.json "$SCRIPT_DIR"/*.html \
    "root@${PVE_HOST}:production/" || {
    echo "ERROR: failed to refresh production scripts on ${PVE_HOST}" >&2
    exit 1
  }
  echo "  production/ refreshed on ${PVE_HOST}"

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

# Note: the Zitadel admin PAT (created during Step 10 at FirstInstance init,
# json/applications/zitadel/Zitadel.docker-compose.yml:44, persists in
# /bootstrap/admin-client.pat) is the bearer for the deployer API once OIDC
# is enforced (post-Step 11). It does NOT exist before Step 10, so we don't
# call init_admin_pat globally here. Each entry-point script that talks to
# the deployer (deploy.sh, setup-ghcr-mirror.sh, setup-pve-host.sh, plus
# the --json-dev-sync block below) calls init_admin_pat itself when its
# code path actually runs — only then is Zitadel guaranteed to be up.

# ================================================================
# Step 0 (only with --bootstrap): tabula rasa + install deployer
# ================================================================
if [ "$BOOTSTRAP" -eq 1 ]; then
  banner 0 "Bootstrap: destroy.sh + install deployer on ${PVE_HOST}"

  echo "  Running production/destroy.sh (will prompt for confirmation)..."
  "$SCRIPT_DIR/destroy.sh"

  echo ""
  echo "  Installing deployer on ${PVE_HOST}..."
  echo "    hostname:     ${DEPLOYER_HOST}"
  echo "    vm-id-start:  ${DEPLOYER_VMID_START}"
  echo "    static-ip:    ${DEPLOYER_STATIC_IP}"
  echo "    gateway:      ${DEPLOYER_GATEWAY}"
  echo "    nameserver:   ${DEPLOYER_NAMESERVER}"
  pve_ssh "curl -fsSL '${INSTALLER_URL}' | sh -s -- \
    --hostname '${DEPLOYER_HOST}' \
    --vm-id-start '${DEPLOYER_VMID_START}' \
    --static-ip '${DEPLOYER_STATIC_IP}' \
    --gateway '${DEPLOYER_GATEWAY}' \
    --nameserver '${DEPLOYER_NAMESERVER}'" || {
    echo "ERROR: deployer installer failed on ${PVE_HOST}" >&2
    exit 1
  }
  echo "  Deployer installed. Proceeding with full setup (steps 1..99)."
fi
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
    echo "    ./install-proxvex.sh --vm-id-start 500 --hostname ${DEPLOYER_HOST} \\"
    echo "      --static-ip 192.168.4.51/24 --nameserver 192.168.4.1 --gateway 192.168.4.1 \\"
    echo "      --deployer-url https://${DEPLOYER_HOST}"
    exit 1
  fi
fi

# ================================================================
# Step 3: Register all PVE hosts + copy production files
# ================================================================
if should_run 3; then
  banner 3 "Register PVE hosts + copy production files"

  for host in $(unique_hosts); do
    echo ""
    echo "  --- Host: ${host} ---"

    # Register host with deployer (idempotent: skips key/registration if present).
    # Pass DEPLOYER_PVE_HOST so setup-pve-host.sh can `ssh root@<pve> pct exec`
    # to read the deployer's pubkey when this script runs from a control
    # machine without direct SSH access to the deployer LXC.
    DEPLOYER_HOST="$DEPLOYER_HOST" \
    DEPLOYER_PVE_HOST="$PVE_HOST" \
      "$SCRIPT_DIR/setup-pve-host.sh" "$host"

    # Copy production scripts so the deployer-side setup helpers (project-v1.sh,
    # setup-nginx.sh, etc.) are available wherever they may be invoked.
    pve_ssh_at "$host" "mkdir -p production"
    scp -o StrictHostKeyChecking=no \
      "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR"/*.json "$SCRIPT_DIR"/*.html \
      "root@${host}:production/"
    echo "  Files copied to root@${host}:production/"
  done
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
  if ! handle_existing_container 5 "docker-registry-mirror" \
        "$FORCE_DRM" "--force-docker-registry-mirror" \
        "Docker Hub pull rate limits (cached images would be lost)"; then
    "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app docker-registry-mirror)" docker-registry-mirror
  fi
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

  # SMTP_PASSWORD for the OIDC stack (Zitadel mail notifications)
  if [ -z "$SMTP_PASSWORD" ]; then
    if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/stacks?stacktype=oidc" 2>/dev/null \
         | grep -q 'oidc_production' \
       || curl -sf --connect-timeout 3 "http://${DEPLOYER_HOST}:3080/api/stacks?stacktype=oidc" 2>/dev/null \
         | grep -q 'oidc_production'; then
      echo "  oidc_production stack already exists in deployer — reusing stored secret."
      SMTP_PASSWORD="__already_stored__"
    fi
  fi

  if [ -z "$SMTP_PASSWORD" ]; then
    echo "  SMTP_PASSWORD not set — prompting now (input hidden)."
    echo "  Password for the SMTP account (e.g. mailbox.org app password)"
    printf "  SMTP_PASSWORD: "
    stty -echo
    read -r SMTP_PASSWORD
    stty echo
    echo ""
    if [ -z "$SMTP_PASSWORD" ]; then
      echo "ERROR: empty SMTP_PASSWORD — aborting."
      exit 1
    fi
  fi

  # Validate a freshly provided CF_TOKEN before storing it. The stored token
  # cannot be validated from here (it's encrypted in the deployer), so we just
  # print a hint — if it's stale, post-configure-mail-dns.py skips on 401/403.
  if [ "$CF_TOKEN" != "__already_stored__" ]; then
    echo "  Validating CF_TOKEN against Cloudflare API..."
    cf_verify_code=$(curl -s -o /tmp/cf-verify.json -w '%{http_code}' \
      -H "Authorization: Bearer $CF_TOKEN" \
      "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null || echo "000")
    if [ "$cf_verify_code" != "200" ]; then
      echo "ERROR: CF_TOKEN failed Cloudflare verify (HTTP $cf_verify_code):" >&2
      cat /tmp/cf-verify.json >&2 2>/dev/null || true
      echo "" >&2
      echo "  Create a fresh token at https://dash.cloudflare.com/profile/api-tokens" >&2
      echo "  with Zone:Read + Zone:DNS:Edit on the relevant zone." >&2
      exit 1
    fi
    echo "  CF_TOKEN is valid."
  else
    echo "  Note: reusing stored CF_TOKEN — if stale, mail DNS step will skip with warning."
  fi

  if [ "$CF_TOKEN" = "__already_stored__" ] && [ "$SMTP_PASSWORD" = "__already_stored__" ]; then
    echo "  Skipping setup-acme.sh (stacks already configured)."
  else
    CF_TOKEN="$CF_TOKEN" SMTP_PASSWORD="$SMTP_PASSWORD" "$SCRIPT_DIR/setup-acme.sh"
  fi
  unset CF_TOKEN SMTP_PASSWORD
fi

# ================================================================
# Step 7: Deploy postgres
# ================================================================
if should_run 7; then
  banner 7 "Deploy postgres"
  "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app postgres)" postgres
fi

# ================================================================
# Step 8: Deploy nginx + configure vhosts
# ================================================================
if should_run 8; then
  banner 8 "Deploy nginx + configure vhosts"
  if ! handle_existing_container 8 "nginx" \
        "$FORCE_NGINX" "--force-nginx" \
        "Let's Encrypt rate limits via acme.sh"; then
    "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app nginx)" nginx
    echo ""
    echo "  Configuring nginx vhosts on PVE host (idempotent)..."
    pve_ssh_at "$(host_for_app nginx)" "sh production/setup-nginx.sh"
  fi

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

  # Idempotency guard: if postgres has zitadel events but no zitadel
  # container exists, FirstInstance won't re-run on a fresh container —
  # login-client.pat will never be created and zitadel-login will hang
  # forever. Detect and fail with a clear repair recipe before we
  # waste cycles building containers.
  zitadel_host=$(host_for_app zitadel)
  zitadel_existing=$(pve_ssh_at "$zitadel_host" \
    "pct list | awk '\$NF==\"zitadel\"{print \$1}'" 2>/dev/null || true)
  pg_host=$(host_for_app postgres)
  pg_vmid=$(pve_ssh_at "$pg_host" \
    "pct list | awk '\$NF==\"postgres\"{print \$1; exit}'" 2>/dev/null || true)
  if [ -z "$zitadel_existing" ] && [ -n "$pg_vmid" ]; then
    pg_events=$(pve_ssh_at "$pg_host" \
      "pct exec $pg_vmid -- su postgres -c \"psql -d zitadel -tAc 'SELECT COUNT(*) FROM eventstore.events2'\" 2>/dev/null" \
      | tr -d '[:space:]' || true)
    if echo "${pg_events:-}" | grep -qE '^[0-9]+$' && [ "${pg_events:-0}" -gt 0 ]; then
      echo "" >&2
      echo "ERROR: zitadel DB has ${pg_events} events but no zitadel container exists." >&2
      echo "  FirstInstance migration will be skipped and login-client.pat won't be" >&2
      echo "  written, leaving zitadel-login hanging forever." >&2
      echo "" >&2
      echo "Fix:" >&2
      echo "  ssh root@${pg_host} \"pct exec ${pg_vmid} -- su postgres -c 'psql -c \\\"DROP DATABASE zitadel WITH (FORCE); CREATE DATABASE zitadel OWNER zitadel;\\\"'\"" >&2
      echo "  $0 --step 10" >&2
      exit 1
    fi
  fi

  "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app zitadel)" zitadel.json
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
  "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app gitea)" gitea.json
fi

# ================================================================
# Step 13: Deploy eclipse-mosquitto
# ================================================================
if should_run 13; then
  banner 13 "Deploy eclipse-mosquitto"
  "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app eclipse-mosquitto)" eclipse-mosquitto
fi

# ================================================================
# Step 14: Deploy github-runner (default target: ubuntupve, see APP_HOST)
# ================================================================
if should_run 14; then
  banner 14 "Deploy github-runner ($(host_for_app github-runner))"
  if [ ! -f "$SCRIPT_DIR/github-runner.json" ]; then
    echo "  WARN: $SCRIPT_DIR/github-runner.json not found — skipping."
    echo "        Create it with REPO_URL/ACCESS_TOKEN/RUNNER_NAME/LABELS, e.g.:"
    cat <<'EX'
        {
          "application": "github-runner",
          "params": [
            { "name": "REPO_URL", "value": "https://github.com/proxvex/proxvex" },
            { "name": "ACCESS_TOKEN", "value": "<fine-grained PAT>" },
            { "name": "RUNNER_NAME", "value": "proxvex-runner" },
            { "name": "LABELS", "value": "self-hosted,linux,x64,ubuntupve" },
            { "name": "oci_image_tag", "value": "latest" }
          ]
        }
EX
  else
    "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app github-runner)" github-runner.json
  fi
fi

# ================================================================
# Step 15: Deploy node-red
#   Uploads settings.js (required) and flows.json (optional). MQTT broker
#   node in flows.json connects to eclipse-mosquitto via mTLS using the
#   shared addon-ssl certs in /certs/.
# ================================================================
if should_run 15; then
  banner 15 "Deploy node-red"
  for f in node-red-settings.js; do
    [ -f "$SCRIPT_DIR/$f" ] || {
      echo "ERROR: $SCRIPT_DIR/$f missing — required for node-red deploy" >&2
      exit 1
    }
  done
  "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app node-red)" node-red.json
fi

# ================================================================
# Step 16: Deploy modbus2mqtt
#   Uploads the modbus2mqtt config via the application's REST API after
#   start. MQTT broker connection (mTLS to eclipse-mosquitto) is embedded
#   in the YAML.
# ================================================================
if should_run 16; then
  banner 16 "Deploy modbus2mqtt"
  [ -f "$SCRIPT_DIR/modbus2mqtt-config.yaml" ] || {
    echo "ERROR: $SCRIPT_DIR/modbus2mqtt-config.yaml missing — required for modbus2mqtt deploy" >&2
    exit 1
  }
  "$SCRIPT_DIR/deploy.sh" --host "$(host_for_app modbus2mqtt)" modbus2mqtt.json
fi

# ================================================================
# Step 17: Deploy ghcr-registry-mirror on the test/CI host (optional)
#   Site customization: the application definition is installed into the
#   deployer's /config volume (not shipped under json/applications/), so it
#   only exists on hosts where this step runs. Used by livetest/github-action
#   nested VMs that DNS-redirect ghcr.io to this mirror to avoid double-NAT
#   TLS issues when docker-compose apps pull images.
#
#   Production apps do NOT use this mirror — they keep pulling latest
#   directly from ghcr.io.
# ================================================================
if should_run 17; then
  banner 17 "Deploy ghcr-registry-mirror ($(host_for_app ghcr-registry-mirror))"
  pve_ssh "sh production/setup-ghcr-mirror.sh"
fi

# ================================================================
# Step 18: Deploy docker-mirror-test on the test/CI host (parallel to step 5)
#   The prod docker-registry-mirror on pve1 (step 5, 192.168.4.45) stays.
#   This second instance lives on ubuntupve (192.168.4.49) so the entire
#   test/CI path (nested-VM + mirror) sits on a single physical host —
#   tests no longer depend on pve1 being up or on inter-host routing.
#
#   Clients (nested-VM docker daemon + skopeo) reach this mirror by hostname
#   `docker-mirror-test` configured via /etc/docker/daemon.json
#   ("registry-mirrors") and /etc/containers/registries.conf — wired up
#   by e2e/step2a-setup-mirrors.sh. The cert SAN therefore only needs the
#   container hostname (default), not DNS:registry-1.docker.io.
#
#   Idempotency: skip if container exists. --force-docker-mirror-test
#   destroys + redeploys (purges the cache volume — restore via
#   production/reseed-docker-mirror-test.sh to avoid rate-limit storms on
#   the next step2a pre-pull).
# ================================================================
if should_run 18; then
  drmt_target=$(host_for_app docker-mirror-test)
  banner 18 "Deploy docker-mirror-test (${drmt_target})"
  drmt_existing=$(pve_ssh_at "$drmt_target" \
    "pct list | awk '\$NF==\"docker-mirror-test\"{print \$1}'" 2>/dev/null || true)
  if [ -n "$drmt_existing" ] && [ "$FORCE_DRM_TEST" -ne 1 ]; then
    echo ""
    echo "  ============================================================"
    echo "  Container 'docker-mirror-test' already exists on ${drmt_target}"
    echo "  (VMID: ${drmt_existing}). Skipping step 18 to preserve the"
    echo "  cached image volume."
    echo "  Force redeploy: $0 --force-docker-mirror-test --step 18"
    echo "  Then reseed:    $SCRIPT_DIR/reseed-docker-mirror-test.sh"
    echo "  ============================================================"
    echo ""
  else
    if [ -n "$drmt_existing" ]; then
      echo "  --force-docker-mirror-test: destroying existing container(s) [${drmt_existing}]..."
      for vmid in $drmt_existing; do
        pve_ssh_at "$drmt_target" "pct stop ${vmid} 2>/dev/null; pct destroy ${vmid} --purge --force" || {
          echo "ERROR: failed to destroy VM ${vmid} (docker-mirror-test) on ${drmt_target}" >&2
          exit 1
        }
      done
    fi
    "$SCRIPT_DIR/deploy.sh" --host "$drmt_target" docker-mirror-test.json
  fi
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
echo "  Registry:    192.168.4.45 (docker-registry-mirror, pve1)"
echo "  Node-RED:    192.168.4.46 (node-red.local)"
echo "  Modbus2MQTT: 192.168.4.47 (modbus2mqtt.local)"
echo "  GHCR Mirror: 192.168.4.48 (ghcr-mirror, ubuntupve, test infra)"
echo "  Test Mirror: 192.168.4.49 (docker-mirror-test, ubuntupve, test infra)"
echo ""
