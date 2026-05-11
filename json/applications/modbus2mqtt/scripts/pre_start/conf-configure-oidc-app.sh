#!/bin/sh
# Configure OIDC for modbus2mqtt (pre-start / reconfigure)
#
# Writes OIDC environment variables to the LXC container config.
# No reboot needed since this runs before container start.
#
# Template variables:
#   vm_id              - Container VMID
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   oidc_required_role - Required Zitadel project role
#   oidc_redirect_uri  - Full OIDC callback URL (required)

VM_ID="{{ vm_id }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
OIDC_REQUIRED_ROLE="{{ oidc_required_role }}"
OIDC_REDIRECT_URI="{{ oidc_redirect_uri }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

if [ "$OIDC_REDIRECT_URI" = "NOT_DEFINED" ] || [ -z "$OIDC_REDIRECT_URI" ]; then
  echo "ERROR: oidc_redirect_uri is required" >&2
  exit 1
fi

echo "Configuring OIDC for modbus2mqtt (VM $VM_ID, pre-start)" >&2
echo "  Issuer: $OIDC_ISSUER_URL" >&2
echo "  Callback: $OIDC_REDIRECT_URI" >&2

# Generate a stable OIDC_SESSION_SECRET
OIDC_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || od -An -tx1 -N32 /dev/urandom | tr -d ' \n')

# Remove any existing OIDC/SESSION environment entries
sed -i '/^lxc\.environment:\s*OIDC_/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*OIDC_SESSION_SECRET/d' "$CONF_FILE"

# Append OIDC environment variables
cat >> "$CONF_FILE" <<EOF
lxc.environment: OIDC_ENABLED=true
lxc.environment: OIDC_ISSUER_URL=${OIDC_ISSUER_URL}
lxc.environment: OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
lxc.environment: OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
lxc.environment: OIDC_CALLBACK_URL=${OIDC_REDIRECT_URI}
lxc.environment: OIDC_SESSION_SECRET=${OIDC_SESSION_SECRET}
EOF

if [ -n "$OIDC_REQUIRED_ROLE" ] && [ "$OIDC_REQUIRED_ROLE" != "NOT_DEFINED" ]; then
  echo "lxc.environment: OIDC_REQUIRED_ROLE=${OIDC_REQUIRED_ROLE}" >> "$CONF_FILE"
fi

echo "OIDC environment variables written to $CONF_FILE" >&2
echo '[]'
