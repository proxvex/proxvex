#!/bin/sh
# Configure OIDC for oci-lxc-deployer
#
# Writes OIDC environment variables to the LXC container config
# and reboots the container to apply them.
#
# Template variables:
#   vm_id              - Container VMID
#   hostname           - Application hostname
#   domain_suffix      - Domain suffix
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   oidc_required_role - Required Zitadel project role
#   oidc_callback_path - Callback path (from addon parameter)
#   http_port          - HTTP port

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
OIDC_REQUIRED_ROLE="{{ oidc_required_role }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
HTTP_PORT="{{ http_port }}"

# Guard against NOT_DEFINED
if [ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ]; then DOMAIN_SUFFIX=""; fi

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

# Build callback URL
CALLBACK_URL="http://${HOSTNAME}${DOMAIN_SUFFIX}:${HTTP_PORT}${OIDC_CALLBACK_PATH}"

echo "Configuring OIDC for oci-lxc-deployer (VM $VM_ID)" >&2
echo "  Issuer: $OIDC_ISSUER_URL" >&2
echo "  Callback: $CALLBACK_URL" >&2
if [ -n "$OIDC_REQUIRED_ROLE" ]; then
  echo "  Required role: $OIDC_REQUIRED_ROLE" >&2
fi

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
lxc.environment: OIDC_CALLBACK_URL=${CALLBACK_URL}
lxc.environment: OIDC_SESSION_SECRET=${OIDC_SESSION_SECRET}
EOF

if [ -n "$OIDC_REQUIRED_ROLE" ]; then
  echo "lxc.environment: OIDC_REQUIRED_ROLE=${OIDC_REQUIRED_ROLE}" >> "$CONF_FILE"
fi

echo "OIDC environment variables written to $CONF_FILE" >&2

# Reboot container to pick up new environment (delayed so script output completes first)
echo "Scheduling reboot for container $VM_ID..." >&2
nohup sh -c "sleep 5; pct reboot $VM_ID" >/dev/null 2>&1 &

echo '[]'
