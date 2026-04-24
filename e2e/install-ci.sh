#!/bin/bash
# install-ci.sh - Install the GitHub Actions runner LXC on a Proxmox host
#
# Creates one LXC container directly from the github-actions-runner OCI image
# (built by .github/workflows/runner-image-publish.yml). The container uses
# DHCP on vmbr0 and is reachable by hostname.
#
# An SSH key pair is auto-generated: the private key goes into the runner LXC,
# the public key is appended to the Proxmox host's /root/.ssh/authorized_keys
# so the runner can SSH to the host for qm commands against the nested VM.
#
# The livetest workflow invoked by the runner calls e2e/step2b-install-deployer.sh
# directly (no pvetest worker-delegation). The former ci-test-worker LXC is no
# longer created here — it was only needed in the pve1-split mode where the
# runner sat on a different host than the test-worker.
#
# Prerequisites:
#   - SSH root access to the Proxmox host (from this machine)
#   - skopeo available on the host (Proxmox 8+ includes it, or: apt install skopeo)
#
# Usage:
#   ./install-ci.sh --runner-host ubuntupve --github-token ghp_xxx

set -euo pipefail

# --- Defaults ---
RUNNER_HOST=""
GITHUB_TOKEN=""
REPO_URL="https://github.com/proxvex/proxvex"
RUNNER_NAME=""
LABELS="self-hosted,linux,x64"
RUNNER_VMID=""
STORAGE=""
BRIDGE="vmbr0"
RUNNER_MEMORY=2048
RUNNER_DISK=8
RUNNER_HOSTNAME="gh-runner"

# Image (built by runner-image-publish.yml)
RUNNER_IMAGE="ghcr.io/proxvex/github-actions-runner:latest"

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
        --github-token)     GITHUB_TOKEN="$2"; shift 2 ;;
        --repo-url)         REPO_URL="$2"; shift 2 ;;
        --runner-name)      RUNNER_NAME="$2"; shift 2 ;;
        --labels)           LABELS="$2"; shift 2 ;;
        --runner-vmid)      RUNNER_VMID="$2"; shift 2 ;;
        --storage)          STORAGE="$2"; shift 2 ;;
        --bridge)           BRIDGE="$2"; shift 2 ;;
        --runner-hostname)  RUNNER_HOSTNAME="$2"; shift 2 ;;
        --help|-h)
            cat <<'USAGE'
Usage: install-ci.sh [options]

Required:
  --runner-host <host>       Proxmox host for the runner (e.g., ubuntupve)
  --github-token <token>     GitHub PAT with Actions + Administration read/write

Optional:
  --repo-url <url>           GitHub repo URL (default: https://github.com/proxvex/proxvex)
  --runner-name <name>       Runner display name (default: <runner-host>-proxvex)
  --labels <labels>          Runner labels (default: self-hosted,linux,x64)
  --runner-vmid <id>         VMID for runner (default: auto)
  --storage <name>           Proxmox storage (default: auto-detect)
  --bridge <name>            Network bridge (default: vmbr0)
  --runner-hostname <name>   Runner LXC hostname (default: gh-runner)
USAGE
            exit 0 ;;
        *) fail "Unknown argument: $1" ;;
    esac
done

# Validate required args
[ -z "$RUNNER_HOST" ] && fail "--runner-host is required"
[ -z "$GITHUB_TOKEN" ] && fail "--github-token is required"
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
    "LABELS=$LABELS"

start_lxc "$RUNNER_HOST" "$RUNNER_VMID"
sleep 2
push_ssh_key "$RUNNER_HOST" "$RUNNER_VMID" "$SSH_PRIVATE_KEY" "/root/.ssh/id_ed25519"

# ============================================================
# Step 3: Authorize runner SSH key on the Proxmox host
# (so the runner can SSH to $RUNNER_HOST for qm commands against the nested VM)
# ============================================================
header "Step 3: Authorize runner SSH key on $RUNNER_HOST"

info "Adding runner public key to $RUNNER_HOST root authorized_keys..."
ssh $SSH_OPTS "root@$RUNNER_HOST" "
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    if ! grep -qF '$SSH_PUBLIC_KEY' /root/.ssh/authorized_keys 2>/dev/null; then
        echo '$SSH_PUBLIC_KEY' >> /root/.ssh/authorized_keys
        chmod 600 /root/.ssh/authorized_keys
    fi
"
ok "Runner authorized on $RUNNER_HOST"

echo ""
info "NOTE: the runner also needs SSH to the nested VM for pct commands."
info "e2e/step1-create-vm.sh already installs the dev SSH public key there;"
info "if the runner needs access too, append its pubkey before taking 'baseline':"
echo ""
echo "  ssh -p <nested-ssh-port> root@$RUNNER_HOST \"mkdir -p /root/.ssh && echo '$SSH_PUBLIC_KEY' >> /root/.ssh/authorized_keys\""

# ============================================================
# Summary
# ============================================================
header "Installation Complete"

echo "GitHub Runner:"
echo "  Host:     $RUNNER_HOST"
echo "  VMID:     $RUNNER_VMID"
echo "  Hostname: $RUNNER_HOSTNAME"
echo "  Image:    $RUNNER_IMAGE"
echo "  Labels:   $LABELS"
echo ""
echo "Container uses DHCP on $BRIDGE. The runner SSHs to $RUNNER_HOST"
echo "directly for qm commands (key was added to /root/.ssh/authorized_keys)."
echo ""
echo "Verify:"
echo "  ssh root@$RUNNER_HOST 'pct status $RUNNER_VMID'"
echo "  gh api /repos/${REPO_URL##*/}/actions/runners | jq '.runners[]|{name,status,labels:[.labels[].name]}'"
echo ""
echo "Logs:"
echo "  ssh root@$RUNNER_HOST 'pct exec $RUNNER_VMID -- cat /var/log/lxc/*.log 2>/dev/null || pct console $RUNNER_VMID'"
