#!/bin/bash
# install-ci.sh - Install CI infrastructure on Proxmox hosts
#
# Creates two LXC containers directly from OCI images:
#   1. GitHub Actions runner on the runner host (e.g., pve1)
#   2. CI test-worker on the worker host (e.g., ubuntupve)
#
# Both containers use DHCP on vmbr0 and are reachable by hostname.
# An SSH key pair is auto-generated for inter-container communication.
#
# Prerequisites:
#   - SSH root access to both Proxmox hosts (from this machine)
#   - skopeo available on both hosts (Proxmox 8+ includes it, or: apt install skopeo)
#
# Usage:
#   ./install-ci.sh --runner-host pve1 --worker-host ubuntupve --github-token ghp_xxx
#
# The runner's pvetest CLI will be able to:
#   - SSH to the test-worker by hostname (DHCP, vmbr0)
#   - SSH to the worker-host for PVE management (snapshots, WOL)
#   - SSH to the nested VM for install tests

set -euo pipefail

# --- Defaults ---
RUNNER_HOST=""
WORKER_HOST=""
GITHUB_TOKEN=""
REPO_URL="https://github.com/proxvex/proxvex"
RUNNER_NAME=""
LABELS="self-hosted,linux,x64,pve1"
RUNNER_VMID=""
WORKER_VMID=""
STORAGE=""
BRIDGE="vmbr0"
RUNNER_MEMORY=512
WORKER_MEMORY=2048
RUNNER_DISK=4
WORKER_DISK=4
RUNNER_HOSTNAME="gh-runner"
WORKER_HOSTNAME="ci-test-worker"

# Images (built by runner-image-publish.yml)
RUNNER_IMAGE="ghcr.io/proxvex/github-actions-runner:latest"
WORKER_IMAGE="ghcr.io/proxvex/ci-test-worker:latest"

# pvetest infrastructure defaults
WOL_MAC=""
DEPLOYER_PORT="2080"
NESTED_SSH_PORT="2022"
NESTED_VMID="9001"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()   { echo -e "${YELLOW}[INFO]${NC} $*" >&2; }
ok()     { echo -e "${GREEN}[OK]${NC} $*" >&2; }
fail()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}" >&2
    echo -e "${BLUE}  $*${NC}" >&2
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n" >&2
}

# --- Parse arguments ---
while [ "$#" -gt 0 ]; do
    case "$1" in
        --runner-host)      RUNNER_HOST="$2"; shift 2 ;;
        --worker-host)      WORKER_HOST="$2"; shift 2 ;;
        --github-token)     GITHUB_TOKEN="$2"; shift 2 ;;
        --repo-url)         REPO_URL="$2"; shift 2 ;;
        --runner-name)      RUNNER_NAME="$2"; shift 2 ;;
        --labels)           LABELS="$2"; shift 2 ;;
        --runner-vmid)      RUNNER_VMID="$2"; shift 2 ;;
        --worker-vmid)      WORKER_VMID="$2"; shift 2 ;;
        --storage)          STORAGE="$2"; shift 2 ;;
        --bridge)           BRIDGE="$2"; shift 2 ;;
        --wol-mac)          WOL_MAC="$2"; shift 2 ;;
        --deployer-port)    DEPLOYER_PORT="$2"; shift 2 ;;
        --nested-ssh-port)  NESTED_SSH_PORT="$2"; shift 2 ;;
        --nested-vmid)      NESTED_VMID="$2"; shift 2 ;;
        --runner-hostname)  RUNNER_HOSTNAME="$2"; shift 2 ;;
        --worker-hostname)  WORKER_HOSTNAME="$2"; shift 2 ;;
        --help|-h)
            cat <<'USAGE'
Usage: install-ci.sh [options]

Required:
  --runner-host <host>       Proxmox host for GitHub runner (e.g., pve1)
  --worker-host <host>       Proxmox host for test-worker (e.g., ubuntupve)
  --github-token <token>     GitHub PAT with Actions read/write permission
  --wol-mac <mac>            MAC address of worker-host for WOL

Optional:
  --repo-url <url>           GitHub repo URL (default: proxvex/proxvex)
  --runner-name <name>       Runner display name (default: <runner-host>-proxvex)
  --labels <labels>          Runner labels (default: self-hosted,linux,x64,pve1)
  --runner-vmid <id>         VMID for runner (default: auto)
  --worker-vmid <id>         VMID for test-worker (default: auto)
  --storage <name>           Proxmox storage (default: auto-detect)
  --bridge <name>            Network bridge (default: vmbr0)
  --runner-hostname <name>   Runner LXC hostname (default: gh-runner)
  --worker-hostname <name>   Worker LXC hostname (default: ci-test-worker)
  --deployer-port <port>     Deployer API port on worker-host (default: 2080)
  --nested-ssh-port <port>   Nested VM SSH port on worker-host (default: 2022)
  --nested-vmid <id>         Nested VM ID (default: 9001)
USAGE
            exit 0 ;;
        *) fail "Unknown argument: $1" ;;
    esac
done

# Validate required args
[ -z "$RUNNER_HOST" ] && fail "--runner-host is required"
[ -z "$WORKER_HOST" ] && fail "--worker-host is required"
[ -z "$GITHUB_TOKEN" ] && fail "--github-token is required"
[ -z "$WOL_MAC" ] && fail "--wol-mac is required"
[ -z "$RUNNER_NAME" ] && RUNNER_NAME="${RUNNER_HOST}-proxvex"

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10"

# ============================================================
# Step 1: Generate SSH key pair
# ============================================================
header "Step 1: Generate SSH Key Pair"

SSH_KEY_DIR=$(mktemp -d)
trap 'rm -rf "$SSH_KEY_DIR"' EXIT

ssh-keygen -t ed25519 -f "$SSH_KEY_DIR/id_ed25519" -N "" -q
SSH_PRIVATE_KEY="$SSH_KEY_DIR/id_ed25519"
SSH_PUBLIC_KEY=$(cat "$SSH_KEY_DIR/id_ed25519.pub")
ok "SSH key pair generated in $SSH_KEY_DIR"

# ============================================================
# Helper: download OCI image via skopeo on a remote host
# ============================================================
download_oci_image() {
    local host="$1"
    local image="$2"
    local tarball="$3"

    info "Downloading $image on $host..."
    ssh $SSH_OPTS "root@$host" "
        command -v skopeo >/dev/null 2>&1 || { echo 'Installing skopeo...' >&2; apt-get update -qq && apt-get install -y -qq skopeo; }
        skopeo copy 'docker://$image' 'oci-archive:/var/lib/vz/template/cache/$tarball' --override-os linux --override-arch amd64 >&2
    " || fail "Failed to download $image on $host"
    ok "Image ready: $tarball"
}

# ============================================================
# Helper: auto-detect storage on a remote host
# ============================================================
detect_storage() {
    local host="$1"
    if [ -n "$STORAGE" ]; then
        echo "$STORAGE"
        return
    fi
    ssh $SSH_OPTS "root@$host" "
        # Prefer local-zfs
        if pvesm list local-zfs --content rootdir 2>/dev/null | grep -q .; then
            echo 'local-zfs'
        else
            pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && /active/ {print \$1; exit}'
        fi
    " || echo "local"
}

# ============================================================
# Helper: create LXC container from OCI template
# ============================================================
create_lxc() {
    local host="$1"
    local tarball="$2"
    local vmid="$3"
    local hostname="$4"
    local memory="$5"
    local disk="$6"
    local ostype="$7"
    local storage="$8"

    # Auto-select VMID if not provided
    if [ -z "$vmid" ]; then
        vmid=$(ssh $SSH_OPTS "root@$host" "pvesh get /cluster/nextid")
    fi

    info "Creating LXC $vmid ($hostname) on $host [storage=$storage, mem=${memory}MB, disk=${disk}GB]..."
    ssh $SSH_OPTS "root@$host" "
        # Remove existing container
        if pct status $vmid &>/dev/null; then
            echo 'Removing existing container $vmid...' >&2
            pct stop $vmid 2>/dev/null || true
            sleep 1
            pct destroy $vmid --force --purge 2>/dev/null || true
            sleep 1
        fi

        pct create $vmid 'local:vztmpl/$tarball' \
            --rootfs '$storage:$disk' \
            --hostname '$hostname' \
            --memory $memory \
            --net0 name=eth0,bridge=$BRIDGE,ip=dhcp \
            --ostype $ostype \
            --unprivileged 1 \
            --features nesting=1 \
            --arch amd64 >&2

        # Remove auto-created idmap (not needed for OCI containers)
        sed -i '/^lxc\\.idmap/d' /etc/pve/lxc/$vmid.conf 2>/dev/null || true
    " || fail "Failed to create container $vmid on $host"
    ok "Container $vmid created"
    echo "$vmid"
}

# ============================================================
# Helper: write lxc.init_cmd and env vars to container config
# ============================================================
configure_lxc() {
    local host="$1"
    local vmid="$2"
    shift 2
    # remaining args: KEY=VALUE pairs for lxc.environment

    local config_lines="lxc.init.cmd: /entrypoint.sh"
    for env in "$@"; do
        config_lines="${config_lines}
lxc.environment: ${env}"
    done

    ssh $SSH_OPTS "root@$host" "cat >> /etc/pve/lxc/$vmid.conf << 'CFGEOF'
$config_lines
CFGEOF" || fail "Failed to configure container $vmid"
    ok "Environment configured ($# variables)"
}

# ============================================================
# Helper: start container and wait for it to be running
# ============================================================
start_lxc() {
    local host="$1"
    local vmid="$2"

    info "Starting container $vmid..."
    ssh $SSH_OPTS "root@$host" "pct start $vmid" || fail "Failed to start container $vmid"

    # Wait for running status
    local i
    for i in $(seq 1 30); do
        ssh $SSH_OPTS "root@$host" "pct status $vmid 2>/dev/null | grep -q running" 2>/dev/null && break
        sleep 1
    done
    ssh $SSH_OPTS "root@$host" "pct status $vmid 2>/dev/null | grep -q running" 2>/dev/null \
        || fail "Container $vmid not running after 30s"
    ok "Container $vmid is running"
}

# ============================================================
# Helper: push SSH key into running container
# ============================================================
push_ssh_key() {
    local host="$1"
    local vmid="$2"
    local key_file="$3"
    local dest_path="$4"

    info "Pushing SSH key to container $vmid:$dest_path..."
    # Copy key to Proxmox host, then pct push into container
    scp $SSH_OPTS "$key_file" "root@$host:/tmp/_ci_key_$$" || fail "Failed to copy key to $host"
    ssh $SSH_OPTS "root@$host" "
        pct exec $vmid -- mkdir -p \$(dirname $dest_path)
        pct exec $vmid -- chmod 700 \$(dirname $dest_path)
        pct push $vmid /tmp/_ci_key_$$ $dest_path --perms 0600
        rm -f /tmp/_ci_key_$$
    " || fail "Failed to push key to container $vmid"
    ok "SSH key installed at $dest_path"
}

# ============================================================
# Step 2: Install GitHub Runner on $RUNNER_HOST
# ============================================================
header "Step 2: Install GitHub Runner on $RUNNER_HOST"

RUNNER_TARBALL="github-actions-runner-latest.tar"
download_oci_image "$RUNNER_HOST" "$RUNNER_IMAGE" "$RUNNER_TARBALL"

RUNNER_STORAGE=$(detect_storage "$RUNNER_HOST")
info "Using storage: $RUNNER_STORAGE"

RUNNER_VMID=$(create_lxc "$RUNNER_HOST" "$RUNNER_TARBALL" "$RUNNER_VMID" \
    "$RUNNER_HOSTNAME" "$RUNNER_MEMORY" "$RUNNER_DISK" "ubuntu" "$RUNNER_STORAGE")

configure_lxc "$RUNNER_HOST" "$RUNNER_VMID" \
    "REPO_URL=$REPO_URL" \
    "ACCESS_TOKEN=$GITHUB_TOKEN" \
    "RUNNER_NAME=$RUNNER_NAME" \
    "LABELS=$LABELS" \
    "PVETEST_HOST=$WORKER_HOST" \
    "PVETEST_WORKER_HOST=$WORKER_HOSTNAME" \
    "PVETEST_WORKER_PORT=22" \
    "PVETEST_WORKER_USER=root" \
    "PVETEST_WOL_MAC=$WOL_MAC" \
    "PVETEST_DEPLOYER_PORT=$DEPLOYER_PORT" \
    "PVETEST_NESTED_SSH_PORT=$NESTED_SSH_PORT" \
    "PVETEST_NESTED_VMID=$NESTED_VMID"

start_lxc "$RUNNER_HOST" "$RUNNER_VMID"
sleep 2
push_ssh_key "$RUNNER_HOST" "$RUNNER_VMID" "$SSH_PRIVATE_KEY" "/root/.ssh/id_ed25519"

# ============================================================
# Step 3: Install Test Worker on $WORKER_HOST
# ============================================================
header "Step 3: Install Test Worker on $WORKER_HOST"

WORKER_TARBALL="ci-test-worker-latest.tar"
download_oci_image "$WORKER_HOST" "$WORKER_IMAGE" "$WORKER_TARBALL"

WORKER_STORAGE=$(detect_storage "$WORKER_HOST")
info "Using storage: $WORKER_STORAGE"

WORKER_VMID=$(create_lxc "$WORKER_HOST" "$WORKER_TARBALL" "$WORKER_VMID" \
    "$WORKER_HOSTNAME" "$WORKER_MEMORY" "$WORKER_DISK" "alpine" "$WORKER_STORAGE")

configure_lxc "$WORKER_HOST" "$WORKER_VMID" \
    "SSH_PUBLIC_KEY=$SSH_PUBLIC_KEY"

start_lxc "$WORKER_HOST" "$WORKER_VMID"
sleep 2
push_ssh_key "$WORKER_HOST" "$WORKER_VMID" "$SSH_PRIVATE_KEY" "/root/.ssh/id_ed25519"

# ============================================================
# Step 4: Add SSH public key to worker-host authorized_keys
# (so the runner can SSH to ubuntupve for PVE management)
# ============================================================
header "Step 4: Authorize runner SSH key on $WORKER_HOST"

info "Adding runner public key to $WORKER_HOST root authorized_keys..."
ssh $SSH_OPTS "root@$WORKER_HOST" "
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    # Avoid duplicates
    if ! grep -qF '$SSH_PUBLIC_KEY' /root/.ssh/authorized_keys 2>/dev/null; then
        echo '$SSH_PUBLIC_KEY' >> /root/.ssh/authorized_keys
        chmod 600 /root/.ssh/authorized_keys
    fi
"
ok "Runner authorized on $WORKER_HOST"

echo ""
info "NOTE: For install-test, also add this key to the nested VM's authorized_keys"
info "(before creating the baseline snapshot):"
echo ""
echo "  ssh -p $NESTED_SSH_PORT root@$WORKER_HOST \"mkdir -p /root/.ssh && echo '$SSH_PUBLIC_KEY' >> /root/.ssh/authorized_keys\""

# ============================================================
# Summary
# ============================================================
header "Installation Complete"

echo "GitHub Runner:"
echo "  Host:     $RUNNER_HOST"
echo "  VMID:     $RUNNER_VMID"
echo "  Hostname: $RUNNER_HOSTNAME"
echo "  Image:    $RUNNER_IMAGE"
echo ""
echo "Test Worker:"
echo "  Host:     $WORKER_HOST"
echo "  VMID:     $WORKER_VMID"
echo "  Hostname: $WORKER_HOSTNAME"
echo "  Image:    $WORKER_IMAGE"
echo ""
echo "Both containers use DHCP on $BRIDGE."
echo "The runner connects to the test-worker at $WORKER_HOSTNAME:22."
echo ""
echo "Verify:"
echo "  ssh root@$RUNNER_HOST 'pct status $RUNNER_VMID'"
echo "  ssh root@$WORKER_HOST 'pct status $WORKER_VMID'"
echo ""
echo "Logs:"
echo "  ssh root@$RUNNER_HOST 'pct exec $RUNNER_VMID -- cat /var/log/lxc/*.log 2>/dev/null || pct console $RUNNER_VMID'"
echo "  ssh root@$WORKER_HOST 'pct exec $WORKER_VMID -- cat /var/log/lxc/*.log 2>/dev/null || pct console $WORKER_VMID'"
