#!/bin/sh
# Configure OIDC for modbus2mqtt (pre-start / reconfigure)
#
# Writes OIDC environment variables to the LXC container config.
# Picks http:// + http_port OR https:// + https_port for the callback URL
# based on whether conf-enable-ssl-app.sh has already marked SSL as active.
# No reboot needed since this runs before container start.
#
# Template variables:
#   vm_id              - Container VMID
#   hostname           - Container hostname
#   domain_suffix      - Domain suffix
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   oidc_required_role - Required Zitadel project role
#   oidc_callback_path - Callback path (from addon parameter)
#   http_port          - HTTP port
#   https_port         - HTTPS port (used when SSL addon is active)

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
OIDC_REQUIRED_ROLE="{{ oidc_required_role }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
HTTP_PORT="{{ http_port }}"
HTTPS_PORT="{{ https_port }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

# Resolve NOT_DEFINED values
[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=""
[ "$HTTP_PORT" = "NOT_DEFINED" ] && HTTP_PORT="3000"
[ "$HTTPS_PORT" = "NOT_DEFINED" ] && HTTPS_PORT="3443"
[ "$OIDC_CALLBACK_PATH" = "NOT_DEFINED" ] && OIDC_CALLBACK_PATH="/api/auth/callback"

# Use hostname from existing container config if available (reconfigure preserves it)
CONF_HOSTNAME=$(awk -F': ' '/^hostname:/ { print $2; exit }' "$CONF_FILE")
if [ -n "$CONF_HOSTNAME" ]; then
  HOSTNAME="$CONF_HOSTNAME"
fi

# Detect SSL mode by looking for the marker written by conf-enable-ssl-app.sh
if grep -q '^lxc\.environment:[[:space:]]*MODBUS2MQTT_HTTPS_PORT=' "$CONF_FILE"; then
  PROTOCOL="https"
  PORT="$HTTPS_PORT"
else
  PROTOCOL="http"
  PORT="$HTTP_PORT"
fi

CALLBACK_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}:${PORT}${OIDC_CALLBACK_PATH}"

echo "Configuring OIDC for modbus2mqtt (VM $VM_ID, pre-start)" >&2
echo "  Issuer:   $OIDC_ISSUER_URL" >&2
echo "  Callback: $CALLBACK_URL" >&2

# Generate a stable OIDC_SESSION_SECRET
OIDC_SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || od -An -tx1 -N32 /dev/urandom | tr -d ' \n')

# Remove any existing OIDC env entries
sed -i '/^lxc\.environment:[[:space:]]*OIDC_/d' "$CONF_FILE"

# Append OIDC environment variables
cat >> "$CONF_FILE" <<EOF
lxc.environment: OIDC_ENABLED=true
lxc.environment: OIDC_ISSUER_URL=${OIDC_ISSUER_URL}
lxc.environment: OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
lxc.environment: OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
lxc.environment: OIDC_CALLBACK_URL=${CALLBACK_URL}
lxc.environment: OIDC_SESSION_SECRET=${OIDC_SESSION_SECRET}
EOF

if [ -n "$OIDC_REQUIRED_ROLE" ] && [ "$OIDC_REQUIRED_ROLE" != "NOT_DEFINED" ]; then
  echo "lxc.environment: OIDC_REQUIRED_ROLE=${OIDC_REQUIRED_ROLE}" >> "$CONF_FILE"
fi

echo "OIDC environment variables written to $CONF_FILE" >&2
echo '[]'
