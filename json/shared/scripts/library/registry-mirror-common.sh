# registry-mirror-common.sh — Shared functions for Docker Registry Mirror trust
#
# Functions:
#   mirror_detect          - Detect local registry mirror, sets MIRROR_IP
#   mirror_setup_hosts     - Add /etc/hosts entries for Docker Hub → mirror
#   mirror_trust_insecure  - Set insecure-registries in daemon.json (dev/test)
#
# For production HTTPS mirrors no per-call CA install is needed: the deployer
# CA is already in the container's system trust store (pushed by template
# 108-host-push-ca-to-container) and Docker daemon falls back to it.
#
# Usage:
#   mirror_detect || exit 0
#   mirror_setup_hosts
#   mirror_trust_insecure   # only for HTTP-only mirrors

MIRROR_HOST="docker-registry-mirror"
MIRROR_IP=""
MIRROR_MARKER="# proxvex: registry mirror"
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
    # Create new entry. registry-mirrors is also set to the HTTP endpoint:
    # Docker only uses the insecure HTTP path when there's an explicit
    # registry-mirrors entry — without it the daemon still attempts HTTPS
    # against registry-1.docker.io (insecure-registries on its own permits
    # HTTP but doesn't make Docker prefer it).
    printf '{\n  "insecure-registries": ["registry-1.docker.io", "index.docker.io", "ghcr.io"],\n  "registry-mirrors": ["http://registry-1.docker.io"]\n}\n' > "$_daemon_json"
    _needs_restart=true
  fi

  echo "Set insecure-registries for registry mirror" >&2

  # Restart Docker if running. After restart, wait for the daemon to be
  # ready AND for the new insecure-registries config to take effect (rc-service
  # returns before the daemon has finished initializing — the next test
  # command can otherwise hit the daemon during its old-config tail and
  # docker errors with `server gave HTTP response to HTTPS client`).
  if [ "$_needs_restart" = true ]; then
    if command -v rc-service > /dev/null 2>&1; then
      rc-service docker restart >&2 2>&1 || true
    elif command -v systemctl > /dev/null 2>&1; then
      systemctl restart docker >&2 2>&1 || true
    fi
    # Poll until docker info reports our insecure-registries list — that
    # confirms the daemon picked up the new daemon.json.
    _i=0
    while [ "$_i" -lt 30 ]; do
      if docker info 2>/dev/null | grep -q "registry-1.docker.io"; then
        echo "Docker daemon picked up insecure-registries config" >&2
        return
      fi
      sleep 1
      _i=$(( _i + 1 ))
    done
    echo "Warning: docker did not report insecure-registries after 30s" >&2
  fi
}
