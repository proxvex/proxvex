#!/bin/sh
# Configure OIDC for GPTWOL (pre-start / reconfigure)
#
# Writes OIDC environment variables to the LXC container config.
# GPTWOL supports OIDC natively via environment variables.
#
# Template variables:
#   vm_id              - Container VMID
#   hostname           - Container hostname
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   oidc_callback_path - Callback path (from addon parameter)
#   http_port          - HTTP port
#   domain_suffix      - Domain suffix

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
HTTP_PORT="{{ http_port }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

CALLBACK_URL="http://${HOSTNAME}${DOMAIN_SUFFIX}:${HTTP_PORT}${OIDC_CALLBACK_PATH}"

echo "Configuring OIDC for GPTWOL (VM $VM_ID, pre-start)" >&2
echo "  Issuer: $OIDC_ISSUER_URL" >&2
echo "  Callback: $CALLBACK_URL" >&2

# Remove any existing OIDC environment entries
sed -i '/^lxc\.environment:\s*OIDC_/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*ENABLE_LOGIN/d' "$CONF_FILE"

# Append OIDC environment variables
cat >> "$CONF_FILE" <<EOF
lxc.environment: OIDC_ENABLED=true
lxc.environment: OIDC_ISSUER=${OIDC_ISSUER_URL}
lxc.environment: OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
lxc.environment: OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
lxc.environment: OIDC_REDIRECT_URI=${CALLBACK_URL}
lxc.environment: ENABLE_LOGIN=true
EOF

echo "OIDC environment variables written to $CONF_FILE" >&2
echo '[]'
