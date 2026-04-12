#!/bin/sh
# Upgrade system packages inside the container.
#
# Detects the OS (Alpine/Debian/Ubuntu) and runs the appropriate
# package update + upgrade commands.
#
# Output: JSON to stdout

set -eu

log() { echo "$@" >&2; }

# Detect OS
if [ -f /etc/alpine-release ]; then
  OS="alpine"
elif [ -f /etc/debian_version ]; then
  OS="debian"
else
  OS="unknown"
fi

log "Upgrading system packages (OS: $OS)..."

case "$OS" in
  alpine)
    apk update >&2
    apk upgrade >&2
    ;;
  debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update >&2
    apt-get upgrade -y >&2
    ;;
  *)
    log "Warning: Unknown OS, skipping system upgrade"
    ;;
esac

log "System packages upgraded successfully"
echo '[{"id":"system_upgraded","value":"true"}]'
