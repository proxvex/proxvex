#!/bin/sh
# Install the on_start_container dispatcher inside the LXC container.
#
# This script creates:
# 1. /etc/lxc-oci-deployer/on_start.d/ directory for drop-in scripts
# 2. /etc/lxc-oci-deployer/on_start_container dispatcher script
#
# The dispatcher is called by the Proxmox hookscript on container
# post-start and executes all *.sh scripts in on_start.d/.
#
# Output: errors to stderr only

DISPATCHER_DIR="/etc/lxc-oci-deployer"
DROPIN_DIR="${DISPATCHER_DIR}/on_start.d"
DISPATCHER="${DISPATCHER_DIR}/on_start_container"

# Create directories
mkdir -p "$DROPIN_DIR"
echo "Created ${DROPIN_DIR}" >&2

# Create dispatcher script
cat > "$DISPATCHER" << 'DISPEOF'
#!/bin/sh
# on_start_container - runs all drop-in scripts on container start
# Called by Proxmox hookscript via: pct exec <CTID> -- /etc/lxc-oci-deployer/on_start_container [UID] [GID]

APP_UID="${1:-0}"
APP_GID="${2:-0}"
DROPIN_DIR="/etc/lxc-oci-deployer/on_start.d"

for script in "$DROPIN_DIR"/*.sh; do
  [ -x "$script" ] || continue
  echo "Running: $script" >&2
  "$script" "$APP_UID" "$APP_GID" 2>&1 | while IFS= read -r line; do echo "  $line" >&2; done
done
DISPEOF
chmod +x "$DISPATCHER"

echo "Installed dispatcher: ${DISPATCHER}" >&2
echo "on_start_container dispatcher installed successfully" >&2
