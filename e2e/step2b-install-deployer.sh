#!/bin/bash
# step2b-install-deployer.sh - Install proxvex into the nested VM
#
# Prerequisites:
#   - step1-create-vm.sh has run ('baseline' snapshot exists)
#   - step2a-setup-mirrors.sh has run ('mirrors-ready' snapshot exists)
#     The 'mirrors-ready' snapshot is required — this script does NOT rebuild
#     the mirrors if it is missing, because re-pulling all images hits Docker
#     Hub rate limits on repeated runs.
#
# This script:
# 1. Verifies 'mirrors-ready' exists and rolls back to it
# 2. Builds the proxvex Docker image locally (node:24-slim based)
# 3. Converts the local Docker image to an OCI-archive tarball via skopeo
# 4. Uploads the tarball to /var/lib/vz/template/cache/ on the nested VM
# 5. Runs install-proxvex.sh --use-existing-image to create the deployer LXC
# 6. Wires up port forwarding on the nested VM
# 7. Creates the 'deployer-installed' snapshot for livetests to roll back to
#
# Usage:
#   ./step2b-install-deployer.sh [instance] [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

VERBOSE=false
INSTANCE_ARG=""
for arg in "$@"; do
    case "$arg" in
        --verbose|-v) VERBOSE=true ;;
        -*) ;;
        *) [ -z "$INSTANCE_ARG" ] && INSTANCE_ARG="$arg" ;;
    esac
done

load_config "$INSTANCE_ARG"
NESTED_IP="$NESTED_STATIC_IP"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_START=$(date +%s)
STEP_START=$SCRIPT_START

elapsed() { echo "$(( $(date +%s) - SCRIPT_START ))s"; }
step_elapsed() {
    local now=$(date +%s)
    local step=$((now - STEP_START))
    STEP_START=$now
    echo "${step}s"
}

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1 ${CYAN}($(step_elapsed))${NC}"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }
header() {
    STEP_START=$(date +%s)
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
}

nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

header "Step 2b: Install proxvex"
echo "Instance:      $E2E_INSTANCE"
echo "Connection:    $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22"
echo "Deployer VMID: $DEPLOYER_VMID"
echo "Deployer URL:  $DEPLOYER_URL"
echo ""

# Per-instance identifiers so two step2b runs for different instances can
# coexist on the same dev machine and the same outer PVE host. The Docker
# image tag also differs per instance, otherwise skopeo copy would race on
# `proxvex:local` in the shared daemon namespace.
DOCKER_TAG="proxvex:local-${E2E_INSTANCE}"
TMP_OCI_NAME="proxvex-${E2E_INSTANCE}-local.tar"
TMP_INSTALL_NAME="install-proxvex-${E2E_INSTANCE}.sh"
TMP_SCRIPTS_NAME="proxvex-scripts-${E2E_INSTANCE}.tar.gz"
LOCAL_SCRIPTS_TARBALL="/tmp/${TMP_SCRIPTS_NAME}"

# Step 1: Verify 'mirrors-ready' snapshot exists (hard requirement — see header).
if ! pve_ssh "qm listsnapshot $TEST_VMID 2>/dev/null | grep -q 'mirrors-ready'"; then
    error "'mirrors-ready' snapshot missing on VM $TEST_VMID — run ./step2a-setup-mirrors.sh $E2E_INSTANCE first"
fi

# Rollback to mirrors-ready for a clean, mirror-populated environment.
info "Rolling back to 'mirrors-ready' snapshot..."
pve_ssh "qm shutdown $TEST_VMID --timeout 30" 2>/dev/null || true
for i in $(seq 1 30); do
    pve_ssh "qm status $TEST_VMID 2>/dev/null" | grep -q stopped && break
    sleep 1
done
# Drop any existing deployer-installed snapshot — rollback requires it be absent.
pve_ssh "qm delsnapshot $TEST_VMID deployer-installed 2>/dev/null || true"
pve_ssh "qm rollback $TEST_VMID mirrors-ready"
pve_ssh "qm start $TEST_VMID"
success "Rolled back to 'mirrors-ready'"

# Step 2: Wait for SSH
info "Waiting for SSH connection to nested VM..."
SSH_READY=false
for i in $(seq 1 60); do
    if nested_ssh "echo ok" &>/dev/null; then SSH_READY=true; break; fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for SSH... %ds" "$i"
    sleep 1
done
echo ""
[ "$SSH_READY" = "true" ] || error "Cannot connect to $NESTED_IP via SSH after 60s"
success "SSH connection verified"

# Ensure the ghcr.io mirror's alias IP (10.0.0.2) is back after reboot and the
# mirror container is running. On older mirrors-ready snapshots the IP was only
# added at runtime (non-persistent), so `qm rollback + qm start` above loses
# it and the ghcr-mirror container can't re-bind. Use a systemd oneshot unit
# (rather than /etc/network/interfaces.d/, which ifupdown2 rejects for
# colon-aliased stanzas) so the IP comes up on every boot of the snapshot.
nested_ssh "cat > /etc/systemd/system/vmbr1-ghcr-alias.service <<'EOF'
[Unit]
Description=Secondary IP 10.0.0.2 on vmbr1 for ghcr.io pull-through mirror
After=networking.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip addr add 10.0.0.2/24 dev vmbr1
ExecStartPost=/bin/docker start ghcr-mirror
ExecStop=/sbin/ip addr del 10.0.0.2/24 dev vmbr1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vmbr1-ghcr-alias.service
"
# Run once now so the current boot has the IP + mirror container before we
# snapshot deployer-installed.
nested_ssh "ip addr show vmbr1 | grep -q '10.0.0.2/' || ip addr add 10.0.0.2/24 dev vmbr1"
nested_ssh "docker ps -q -f name='^ghcr-mirror$' | grep -q . || docker start ghcr-mirror >/dev/null 2>&1 || true"

# Purge the obsolete ifupdown-style stanza written by earlier step2b runs — it
# confuses ifupdown2 ("cannot find interfaces: vmbr1:ghcr") on boot.
nested_ssh "rm -f /etc/network/interfaces.d/vmbr1-ghcr-mirror"

# Step 3: Build proxvex Docker image locally
header "Building local proxvex Docker image"
cd "$PROJECT_ROOT"

command -v docker >/dev/null || error "docker not found on local host (required for build)"
command -v skopeo >/dev/null || error "skopeo not found on local host (install via brew/apt)"
command -v pnpm   >/dev/null || error "pnpm not found on local host"

info "Building backend + CLI + frontend..."
pnpm run build >&2 || error "pnpm run build failed"

info "Creating npm pack tarball..."
rm -f docker/proxvex*.tgz
TARBALL_RAW=$(npm pack --pack-destination docker/ 2>&1 | grep -o 'proxvex-.*\.tgz' | tail -n1)
[ -n "$TARBALL_RAW" ] || error "npm pack did not produce a tarball"
mv "docker/$TARBALL_RAW" docker/proxvex.tgz
success "Packed: docker/proxvex.tgz"

info "Building Docker image ${DOCKER_TAG} (linux/amd64)..."
# Force linux/amd64: the Proxmox host is x86_64, but Apple-Silicon Macs would
# otherwise produce arm64 binaries and the container fails to start with
# "Exec format error" when LXC tries to run /usr/local/bin/entrypoint-wrapper.sh.
docker build --platform linux/amd64 -t "$DOCKER_TAG" -f docker/Dockerfile.npm-pack . >&2 \
    || error "docker build failed"
success "Docker image ${DOCKER_TAG} built"

# Step 4: Convert local Docker image to an OCI-archive tarball (pct create
# accepts the oci-archive format directly — same path the production flow
# takes via host-get-oci-image.py).
OCI_TARBALL="$PROJECT_ROOT/docker/proxvex-${E2E_INSTANCE}-local.oci.tar"
info "Exporting via skopeo to $OCI_TARBALL..."
rm -f "$OCI_TARBALL"
skopeo copy \
    "docker-daemon:${DOCKER_TAG}" \
    "oci-archive:${OCI_TARBALL}:latest" >&2 \
    || error "skopeo copy failed"
success "OCI-archive: $(ls -l "$OCI_TARBALL" | awk '{print $5}') bytes"

# Step 5: Upload tarball to the nested VM (via PVE host) into /tmp.
# install-proxvex.sh --tarball will stage it into the Proxmox template cache.
REMOTE_TARBALL="/tmp/${TMP_OCI_NAME}"
info "Uploading $OCI_TARBALL → $NESTED_IP:$REMOTE_TARBALL ..."
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$OCI_TARBALL" "root@$PVE_HOST:/tmp/${TMP_OCI_NAME}" \
    || error "scp to PVE host failed"
pve_ssh "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/${TMP_OCI_NAME} root@$NESTED_IP:${REMOTE_TARBALL}" \
    || error "scp from PVE host to nested VM failed"
pve_ssh "rm -f /tmp/${TMP_OCI_NAME}" || true
success "Tarball uploaded to $REMOTE_TARBALL (install-proxvex.sh will stage to cache)"

# Step 6: Copy local install-proxvex.sh + shared scripts to the nested VM
# (install-proxvex.sh's LOCAL_SCRIPT_PATH bypasses GitHub so the local fix
# under test is what runs). All hop paths carry $E2E_INSTANCE.
LOCAL_SCRIPT_PATH="/tmp/proxvex-scripts-${E2E_INSTANCE}"
header "Copying install script + shared scripts to nested VM"
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$PROJECT_ROOT/install-proxvex.sh" "root@$PVE_HOST:/tmp/${TMP_INSTALL_NAME}" \
    || error "Failed to copy install-proxvex.sh to PVE host"
pve_ssh "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/${TMP_INSTALL_NAME} root@$NESTED_IP:/tmp/${TMP_INSTALL_NAME}" \
    || error "Failed to copy install-proxvex.sh to nested VM"

tar -czf "$LOCAL_SCRIPTS_TARBALL" -C "$PROJECT_ROOT" json/shared/scripts \
    || error "Failed to create scripts tarball"
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$LOCAL_SCRIPTS_TARBALL" "root@$PVE_HOST:/tmp/${TMP_SCRIPTS_NAME}" \
    || error "Failed to copy scripts tarball to PVE host"
pve_ssh "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/${TMP_SCRIPTS_NAME} root@$NESTED_IP:/tmp/${TMP_SCRIPTS_NAME}" \
    || error "Failed to copy scripts tarball to nested VM"
nested_ssh "mkdir -p $LOCAL_SCRIPT_PATH && tar -xzf /tmp/${TMP_SCRIPTS_NAME} -C $LOCAL_SCRIPT_PATH" \
    || error "Failed to extract shared scripts on nested VM"
rm -f "$LOCAL_SCRIPTS_TARBALL"
success "install-proxvex.sh + shared scripts in place"

# Step 7: Run install-proxvex.sh with the local OCI template
header "Running install-proxvex.sh --use-existing-image"
nested_ssh "chmod +x /tmp/${TMP_INSTALL_NAME} && \
    OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH \
    /tmp/${TMP_INSTALL_NAME} \
        --use-existing-image $REMOTE_TEMPLATE \
        --vm-id $DEPLOYER_VMID \
        --bridge $DEPLOYER_BRIDGE \
        --static-ip $DEPLOYER_STATIC_IP \
        --gateway $DEPLOYER_GATEWAY \
        --nameserver $DEPLOYER_GATEWAY \
        --deployer-url $DEPLOYER_URL" \
    || error "install-proxvex.sh failed"
success "install-proxvex.sh completed"

# Step 8: Port forwarding on nested VM → deployer container
DEPLOYER_IP="${DEPLOYER_STATIC_IP%/*}"
header "Configuring port forwarding on nested VM"
nested_ssh "
  iptables -t nat -D PREROUTING -p tcp --dport 3080 -j DNAT --to-destination $DEPLOYER_IP:3080 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3080 -j ACCEPT 2>/dev/null || true
  iptables -t nat -D PREROUTING -p tcp --dport 3443 -j DNAT --to-destination $DEPLOYER_IP:3443 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3443 -j ACCEPT 2>/dev/null || true
  iptables -t nat -A PREROUTING -p tcp --dport 3080 -j DNAT --to-destination $DEPLOYER_IP:3080
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3080 -j ACCEPT
  iptables -t nat -A PREROUTING -p tcp --dport 3443 -j DNAT --to-destination $DEPLOYER_IP:3443
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3443 -j ACCEPT
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
"
success "Nested VM :3080 → $DEPLOYER_IP:3080, :3443 → $DEPLOYER_IP:3443 (persisted)"

# Make the deployer hostname resolvable from sibling LXC containers.
# The deployer generates its base URL as http://$(hostname):3080 which becomes
# http://proxvex:3080 — other LXCs use this URL to fetch the CA cert (via
# `Trust Deployer CA`). Without a DNS entry, those containers get
# "Could not download CA certificate". Add it to dnsmasq and reload.
nested_ssh "
  cfg=/etc/dnsmasq.d/proxvex-deployer.conf
  {
    # Sibling LXCs use 'http://proxvex:3080' as deployer URL.
    # Use host-record (not address=) so the entry beats DHCP-derived
    # hostname leases from previous test containers — `address=/proxvex/…`
    # gets shadowed by stale DHCP leases for any container that briefly
    # ran with hostname 'proxvex'.
    echo 'host-record=proxvex,$DEPLOYER_IP'
    # 'docker-registry-mirror' is what registry-mirror-common.sh's mirror_detect
    # looks for. Point it at 10.0.0.1 (the dockerhub-mirror) so the trust-CA
    # post_start script enters its mirror branch and configures Docker.
    echo 'host-record=docker-registry-mirror,10.0.0.1'
  } > \$cfg
  # Full restart — SIGHUP/reload doesn't always pick up new files under
  # /etc/dnsmasq.d/ on this Proxmox install.
  systemctl restart dnsmasq 2>/dev/null || true
"
success "dnsmasq: proxvex → $DEPLOYER_IP"

# Step 9: Verify API before snapshotting
info "Verifying deployer API..."
api_ok=false
for i in $(seq 1 60); do
    if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    if nested_ssh "curl -sk --connect-timeout 1 https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
    sleep 1
done
echo ""
[ "$api_ok" = "true" ] || error "Deployer API not reachable after 60s"
success "Deployer API is responding"

# Step 10: Snapshot — clean shutdown, then qm snapshot deployer-installed
header "Creating 'deployer-installed' snapshot"
info "Stopping nested VM $TEST_VMID..."
pve_ssh "qm shutdown $TEST_VMID --timeout 60"
for i in $(seq 1 60); do
    pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null && break
    sleep 1
done
pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null \
    || error "VM $TEST_VMID did not shut down cleanly — cannot create reliable snapshot"

pve_ssh "qm delsnapshot $TEST_VMID deployer-installed 2>/dev/null || true"
pve_ssh "qm snapshot $TEST_VMID deployer-installed --description 'Nested VM with proxvex installed (step2b)'"
success "Snapshot 'deployer-installed' created"

pve_ssh "qm start $TEST_VMID"
info "Waiting for deployer API after restart..."
api_ok=false
for i in $(seq 1 60); do
    if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    if nested_ssh "curl -sk --connect-timeout 1 https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
    sleep 1
done
echo ""
[ "$api_ok" = "true" ] || error "Deployer API not reachable after VM restart"
success "Deployer API is ready"

TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Step 2b complete in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Instance:        $E2E_INSTANCE"
echo "Deployer HTTP:   $DEPLOYER_URL"
echo "Deployer HTTPS:  $DEPLOYER_HTTPS_URL"
echo "Deployer VMID:   $DEPLOYER_VMID"
echo ""
echo "Quick redeploy (same mirrors): ./step2b-install-deployer.sh $E2E_INSTANCE"
