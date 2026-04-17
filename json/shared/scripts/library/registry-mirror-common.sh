# registry-mirror-common.sh — Shared functions for Docker Registry Mirror trust
#
# Functions:
#   mirror_detect          - Detect local registry mirror, sets MIRROR_IP
#   mirror_setup_hosts     - Add /etc/hosts entries for Docker Hub → mirror
#   mirror_trust_ca        - Install CA cert from deployer (production)
#   mirror_trust_insecure  - Set insecure-registries in daemon.json (dev/test)
#
# Usage:
#   mirror_detect || exit 0
#   mirror_setup_hosts
#   mirror_trust_ca "$DEPLOYER_URL" "$VE_CONTEXT"   # OR
#   mirror_trust_insecure

MIRROR_HOST="docker-registry-mirror"
MIRROR_IP=""
MIRROR_MARKER="# oci-lxc-deployer: registry mirror"
MIRROR_REGISTRIES="registry-1.docker.io index.docker.io"

# Detect local registry mirror. Sets MIRROR_IP. Returns 1 if not found.
mirror_detect() {
  # Resolve mirror hostname — try getent (reliable), fall back to nslookup
  if command -v getent >/dev/null 2>&1; then
    MIRROR_IP=$(getent hosts "$MIRROR_HOST" 2>/dev/null | awk '{print $1; exit}')
  else
    # nslookup output varies (BusyBox vs GNU) — extract last IPv4 address
    MIRROR_IP=$(nslookup "$MIRROR_HOST" 2>/dev/null | awk '/^Address/ {a=$NF} END {print a}' | sed 's/[:#].*//')
  fi
  if [ -z "$MIRROR_IP" ]; then
    echo "No registry mirror found (${MIRROR_HOST} not resolvable), skipping" >&2
    return 1
  fi
  # Verify it's a private IP
  case "$MIRROR_IP" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*)
      echo "Registry mirror detected at ${MIRROR_IP}" >&2
      return 0
      ;;
    *)
      echo "${MIRROR_HOST} resolves to ${MIRROR_IP} (not local), skipping" >&2
      MIRROR_IP=""
      return 1
      ;;
  esac
}

# Add /etc/hosts entries: registry-1.docker.io + index.docker.io → MIRROR_IP
mirror_setup_hosts() {
  if [ -z "$MIRROR_IP" ]; then return; fi
  if grep -q "$MIRROR_MARKER" /etc/hosts 2>/dev/null; then return; fi
  echo "${MIRROR_IP} ${MIRROR_REGISTRIES}  ${MIRROR_MARKER}" >> /etc/hosts
  echo "Added /etc/hosts: ${MIRROR_IP} -> ${MIRROR_REGISTRIES}" >&2
}

# Install CA cert from deployer for Docker trust (production mode)
# Args: $1 = deployer_url, $2 = ve_context
mirror_trust_ca() {
  _deployer_url="$1"
  _ve_context="$2"
  if [ -z "$_deployer_url" ] || [ -z "$_ve_context" ]; then
    echo "Warning: No deployer URL for CA download" >&2
    return
  fi

  if ! command -v curl > /dev/null 2>&1; then
    apk add --no-cache curl >&2 2>&1 || apt-get install -y -qq curl >&2 2>&1
  fi

  _ca_url="${_deployer_url}/api/${_ve_context}/ve/certificates/ca/download"
  for _reg in $MIRROR_REGISTRIES; do
    _cert_dir="/etc/docker/certs.d/${_reg}"
    mkdir -p "$_cert_dir"
    if curl -fsSL -k -o "${_cert_dir}/ca.crt" "$_ca_url" 2>/dev/null; then
      echo "CA certificate installed at ${_cert_dir}/ca.crt" >&2
    else
      echo "Warning: Could not download CA from ${_ca_url}" >&2
    fi
  done
}

# Set insecure-registries in Docker daemon.json (dev/test mode)
mirror_trust_insecure() {
  _daemon_json="/etc/docker/daemon.json"
  _needs_restart=false

  # Read or create daemon.json
  if [ -f "$_daemon_json" ]; then
    _content=$(cat "$_daemon_json")
  else
    _content="{}"
  fi

  # Check if already configured
  if echo "$_content" | grep -q "registry-1.docker.io"; then
    echo "insecure-registries already configured" >&2
    return
  fi

  # Add insecure-registries (simple JSON manipulation with sed)
  if echo "$_content" | grep -q "insecure-registries"; then
    # Append to existing array — not needed for fresh installs
    echo "Warning: insecure-registries exists but missing mirror entry" >&2
  else
    # Create new entry
    printf '{\n  "insecure-registries": ["registry-1.docker.io", "index.docker.io", "ghcr.io"]\n}\n' > "$_daemon_json"
    _needs_restart=true
  fi

  echo "Set insecure-registries for registry mirror" >&2

  # Restart Docker if running
  if [ "$_needs_restart" = true ]; then
    if command -v rc-service > /dev/null 2>&1; then
      rc-service docker restart >&2 2>&1 || true
    elif command -v systemctl > /dev/null 2>&1; then
      systemctl restart docker >&2 2>&1 || true
    fi
  fi
}
