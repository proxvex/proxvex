#!/bin/sh
# Register the oci-lxc-deployer hookscript on the Proxmox VE host.
#
# This script:
# 1. Creates/updates the generic hookscript at /var/lib/vz/snippets/
# 2. Registers it with the container via pct set --hookscript
#
# The hookscript calls /etc/lxc-oci-deployer/on_start_container inside
# the container on post-start, which runs all scripts in on_start.d/.
#
# Version management:
# - The hookscript has a VERSION and CHECKSUM header
# - Only updates if installed version is older
# - Skips update if admin has modified the script (checksum mismatch)
#
# Requires:
#   - vm_id: Container ID
#
# Output: JSON to stdout

VMID="{{ vm_id }}"
HOOK_PATH="/var/lib/vz/snippets/lxc-oci-deployer-hook.sh"
NEW_VERSION=2

# The hookscript body (everything below the header)
HOOK_BODY='
vmid=$1
phase=$2

case $phase in
  post-start)
    # Wait for container to be fully ready
    sleep 2
    # Read application UID/GID from container config (lxc.init.uid/gid)
    CONF_FILE="/etc/pve/lxc/${vmid}.conf"
    APP_UID=$(awk -F"[: ]+" "/^lxc\\.init\\.uid:/{print \$2}" "$CONF_FILE" 2>/dev/null)
    APP_GID=$(awk -F"[: ]+" "/^lxc\\.init\\.gid:/{print \$2}" "$CONF_FILE" 2>/dev/null)
    pct exec "$vmid" -- /etc/lxc-oci-deployer/on_start_container "${APP_UID:-0}" "${APP_GID:-0}" 2>/dev/null || true
    ;;
esac

exit 0
'

# Compute checksum of the body
NEW_CHECKSUM=$(printf '%s' "$HOOK_BODY" | md5sum | cut -d' ' -f1)

write_hookscript() {
  echo "Creating hookscript at $HOOK_PATH (v${NEW_VERSION})" >&2
  mkdir -p "$(dirname "$HOOK_PATH")"
  cat > "$HOOK_PATH" << HOOKEOF
#!/bin/sh
# oci-lxc-deployer hookscript
# OCI_LXC_DEPLOYER_HOOK_VERSION=${NEW_VERSION}
# OCI_LXC_DEPLOYER_HOOK_CHECKSUM=${NEW_CHECKSUM}
# --- DO NOT MODIFY ABOVE THIS LINE ---
${HOOK_BODY}
HOOKEOF
  chmod +x "$HOOK_PATH"
}

if [ -f "$HOOK_PATH" ]; then
  # Extract current version
  CURRENT_VERSION=$(grep '^# OCI_LXC_DEPLOYER_HOOK_VERSION=' "$HOOK_PATH" | cut -d= -f2)
  CURRENT_VERSION="${CURRENT_VERSION:-0}"

  if [ "$CURRENT_VERSION" -ge "$NEW_VERSION" ] 2>/dev/null; then
    echo "Hookscript already up to date (v${CURRENT_VERSION})" >&2
  else
    # Check if admin modified the script
    STORED_CHECKSUM=$(grep '^# OCI_LXC_DEPLOYER_HOOK_CHECKSUM=' "$HOOK_PATH" | cut -d= -f2)
    # Extract body: everything after the separator line
    ACTUAL_BODY=$(sed '1,/^# --- DO NOT MODIFY ABOVE THIS LINE ---$/d' "$HOOK_PATH")
    ACTUAL_CHECKSUM=$(printf '%s' "$ACTUAL_BODY" | md5sum | cut -d' ' -f1)

    if [ -z "$STORED_CHECKSUM" ]; then
      # No checksum header found - old format, safe to update
      echo "Updating hookscript from old format to v${NEW_VERSION}" >&2
      write_hookscript
    elif [ "$ACTUAL_CHECKSUM" = "$STORED_CHECKSUM" ]; then
      echo "Updating hookscript from v${CURRENT_VERSION} to v${NEW_VERSION}" >&2
      write_hookscript
    else
      echo "Warning: Hookscript was modified by admin, skipping update (v${CURRENT_VERSION} -> v${NEW_VERSION})" >&2
    fi
  fi
else
  write_hookscript
fi

# Register hookscript with container (idempotent)
CURRENT_HOOK=$(pct config "$VMID" 2>/dev/null | grep '^hookscript:' | awk '{print $2}')
TARGET_HOOK="local:snippets/lxc-oci-deployer-hook.sh"

if [ "$CURRENT_HOOK" = "$TARGET_HOOK" ]; then
  echo "Hookscript already registered for container $VMID" >&2
else
  echo "Registering hookscript for container $VMID" >&2
  pct set "$VMID" --hookscript "$TARGET_HOOK" >&2
fi

echo "Hookscript registration completed" >&2
