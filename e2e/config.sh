#!/bin/bash
# config.sh - Load E2E configuration from config.json
#
# Usage in scripts:
#   source "$(dirname "$0")/config.sh"
#   load_config "local-test"  # or load_config (uses default)
#
# This will export all configuration variables for use in the script.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"

# Check if jq is available
if ! command -v jq &>/dev/null; then
    echo "[ERROR] jq is required but not installed. Install with: brew install jq" >&2
    exit 1
fi

# Load configuration for a specific instance
# Usage: load_config [instance_name]
# If no instance_name provided, uses the "default" from config.json
load_config() {
    local instance="${1:-}"

    if [ ! -f "$CONFIG_FILE" ]; then
        echo "[ERROR] Config file not found: $CONFIG_FILE" >&2
        exit 1
    fi

    # Get instance: argument > E2E_INSTANCE env var > config.json default
    if [ -z "$instance" ]; then
        if [ -n "$E2E_INSTANCE" ]; then
            instance="$E2E_INSTANCE"
        else
            instance=$(jq -r '.default' "$CONFIG_FILE")
        fi
    fi

    # Check if instance exists
    if ! jq -e ".instances[\"$instance\"]" "$CONFIG_FILE" &>/dev/null; then
        echo "[ERROR] Instance '$instance' not found in config.json" >&2
        echo "Available instances:" >&2
        jq -r '.instances | keys[]' "$CONFIG_FILE" | sed 's/^/  - /' >&2
        exit 1
    fi

    # Export instance name
    export E2E_INSTANCE="$instance"

    # Load instance-specific settings
    # config.json supports ${VAR:-default} syntax in string values
    local config_pve_host
    config_pve_host=$(jq -r ".instances[\"$instance\"].pveHost" "$CONFIG_FILE")
    config_pve_host=$(eval echo "$config_pve_host")
    export PVE_HOST="$config_pve_host"
    export TEST_VMID=$(jq -r ".instances[\"$instance\"].vmId" "$CONFIG_FILE")
    export VM_NAME=$(jq -r ".instances[\"$instance\"].vmName" "$CONFIG_FILE")
    export PORT_OFFSET=$(jq -r ".instances[\"$instance\"].portOffset" "$CONFIG_FILE")
    export SUBNET=$(jq -r ".instances[\"$instance\"].subnet" "$CONFIG_FILE")

    # Optional WOL configuration (for waking sleeping hosts)
    export WOL_MAC=$(jq -r ".instances[\"$instance\"].wol.macAddress // empty" "$CONFIG_FILE")

    # Load defaults
    export VM_MEMORY=$(jq -r '.defaults.vmMemory' "$CONFIG_FILE")
    export VM_CORES=$(jq -r '.defaults.vmCores' "$CONFIG_FILE")
    export VM_DISK_SIZE=$(jq -r '.defaults.vmDiskSize' "$CONFIG_FILE")
    export VM_STORAGE=$(jq -r '.defaults.vmStorage' "$CONFIG_FILE")
    export VM_BRIDGE=$(jq -r ".instances[\"$instance\"].bridge" "$CONFIG_FILE")
    export SWAP_SIZE=$(jq -r '.defaults.swapSize' "$CONFIG_FILE")
    export NESTED_PASSWORD=$(jq -r '.defaults.nestedPassword' "$CONFIG_FILE")

    # Filesystem: instance-specific or default
    local instance_fs=$(jq -r ".instances[\"$instance\"].filesystem // empty" "$CONFIG_FILE")
    if [ -n "$instance_fs" ]; then
        export FILESYSTEM="$instance_fs"
    else
        export FILESYSTEM=$(jq -r '.defaults.filesystem' "$CONFIG_FILE")
    fi
    export OWNER=$(jq -r '.defaults.owner' "$CONFIG_FILE")
    export OCI_OWNER=$(jq -r '.defaults.ociOwner' "$CONFIG_FILE")
    export DEPLOYER_VMID=$(jq -r '.defaults.deployerVmid' "$CONFIG_FILE")
    export DEPLOYER_BRIDGE=$(jq -r '.defaults.deployerBridge' "$CONFIG_FILE")
    export DEPLOYER_STATIC_IP=$(jq -r '.defaults.deployerStaticIp' "$CONFIG_FILE")
    export DEPLOYER_GATEWAY=$(jq -r '.defaults.deployerGateway' "$CONFIG_FILE")

    # Load base ports and calculate with offset
    local base_pve_web=$(jq -r '.ports.pveWeb' "$CONFIG_FILE")
    local base_pve_ssh=$(jq -r '.ports.pveSsh' "$CONFIG_FILE")
    local base_deployer=$(jq -r '.ports.deployer' "$CONFIG_FILE")
    local base_deployer_https=$(jq -r '.ports.deployerHttps' "$CONFIG_FILE")

    export PORT_PVE_WEB=$((base_pve_web + PORT_OFFSET))
    export PORT_PVE_SSH=$((base_pve_ssh + PORT_OFFSET))
    export PORT_DEPLOYER=$((base_deployer + PORT_OFFSET))
    export PORT_DEPLOYER_HTTPS=$((base_deployer_https + PORT_OFFSET))

    # Calculated values
    export NESTED_STATIC_IP="${SUBNET}.10"
    export DEPLOYER_URL="http://${PVE_HOST}:${PORT_DEPLOYER}"
    export DEPLOYER_HTTPS_URL="https://${PVE_HOST}:${PORT_DEPLOYER_HTTPS}"
    export PVE_WEB_URL="https://${PVE_HOST}:${PORT_PVE_WEB}"

    # Store in file for other scripts
    echo "$NESTED_STATIC_IP" > "$SCRIPT_DIR/.nested-vm-ip"
    echo "$instance" > "$SCRIPT_DIR/.current-instance"
}

# Show current configuration
show_config() {
    echo "E2E Configuration:"
    echo "  Instance:        $E2E_INSTANCE"
    echo "  PVE Host:        $PVE_HOST"
    echo "  VM ID:           $TEST_VMID"
    echo "  VM Name:         $VM_NAME"
    echo "  Subnet:          $SUBNET.0/24"
    echo "  Bridge:          $VM_BRIDGE"
    echo "  Nested VM IP:    $NESTED_STATIC_IP"
    echo ""
    echo "Port Forwarding (offset: $PORT_OFFSET):"
    echo "  PVE Web:         $PVE_HOST:$PORT_PVE_WEB -> $NESTED_STATIC_IP:8006"
    echo "  PVE SSH:         $PVE_HOST:$PORT_PVE_SSH -> $NESTED_STATIC_IP:22"
    echo "  Deployer HTTP:   $PVE_HOST:$PORT_DEPLOYER -> deployer:3080"
    echo "  Deployer HTTPS:  $PVE_HOST:$PORT_DEPLOYER_HTTPS -> deployer:3443"
    echo ""
    echo "URLs:"
    echo "  PVE Web UI:      $PVE_WEB_URL"
    echo "  Deployer:        $DEPLOYER_URL"
}

# List all available instances
list_instances() {
    echo "Available E2E instances:"
    local default=$(jq -r '.default' "$CONFIG_FILE")
    jq -r '.instances | to_entries[] | "\(.key)|\(.value.description)|\(.value.pveHost)|\(.value.portOffset)"' "$CONFIG_FILE" | \
    while IFS='|' read -r name desc host offset; do
        local marker=""
        [ "$name" = "$default" ] && marker=" (default)"
        printf "  %-20s %s [%s, offset=%d]%s\n" "$name" "$desc" "$host" "$offset" "$marker"
    done
}
