#!/bin/sh
# Load required kernel modules on the Proxmox host
#
# An unprivileged LXC container cannot load kernel modules itself (module
# autoloading is refused from inside a user namespace), so anything the app
# needs from the kernel has to be loaded on the host before the container
# starts.
#
# Parameters:
#   kernel_modules - space- or newline-separated module list.
#                    Empty / NOT_DEFINED → the Docker default set:
#                    overlay, ip_tables, ip6_tables, bridge, br_netfilter
#
# Explicitly requested modules are also persisted in
# /etc/modules-load.d/proxvex.conf so they come back after a host reboot.
# The Docker default set is loaded temporarily (until reboot), as before.
#
# Output: JSON to stdout (errors to stderr)

KERNEL_MODULES="{{ kernel_modules }}"
PERSIST_FILE="/etc/modules-load.d/proxvex.conf"

if [ -z "$KERNEL_MODULES" ] || [ "$KERNEL_MODULES" = "NOT_DEFINED" ]; then
  MODULES="overlay ip_tables ip6_tables bridge br_netfilter"
  PERSIST=false
else
  MODULES=$(printf '%s\n' "$KERNEL_MODULES" | tr ',\n' '  ')
  PERSIST=true
fi

load_module() {
  MODULE_NAME="$1"
  if lsmod | grep -q "^${MODULE_NAME} "; then
    echo "Kernel module '$MODULE_NAME' is already loaded" >&2
    return 0
  fi
  if [ -d "/sys/module/${MODULE_NAME}" ]; then
    echo "Kernel module '$MODULE_NAME' is built-in" >&2
    return 0
  fi

  echo "Loading kernel module '$MODULE_NAME'..." >&2
  if modprobe "$MODULE_NAME" >&2; then
    echo "Successfully loaded kernel module '$MODULE_NAME'" >&2
    return 0
  else
    echo "Warning: Failed to load kernel module '$MODULE_NAME'" >&2
    return 1
  fi
}

persist_module() {
  MODULE_NAME="$1"
  if [ -f "$PERSIST_FILE" ] && grep -qx "$MODULE_NAME" "$PERSIST_FILE"; then
    return 0
  fi
  if [ ! -f "$PERSIST_FILE" ]; then
    echo "# Kernel modules required by proxvex-managed containers" > "$PERSIST_FILE"
  fi
  echo "$MODULE_NAME" >> "$PERSIST_FILE"
  echo "Persisted kernel module '$MODULE_NAME' in $PERSIST_FILE" >&2
}

echo "Loading required kernel modules: $MODULES" >&2

FAILED_MODULES=""
for mod in $MODULES; do
  if load_module "$mod"; then
    [ "$PERSIST" = "true" ] && persist_module "$mod"
  else
    FAILED_MODULES="${FAILED_MODULES} ${mod}"
  fi
done

if [ -n "$FAILED_MODULES" ]; then
  echo "Error: Failed to load the following kernel modules:$FAILED_MODULES" >&2
  echo "Please check if the modules are available in your kernel" >&2
  exit 1
fi

echo "All required kernel modules loaded successfully" >&2
echo '[{"id": "kernel_modules_loaded", "value": "true"}]'
