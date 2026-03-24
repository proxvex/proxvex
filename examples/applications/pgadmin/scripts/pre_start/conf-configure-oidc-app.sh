#!/bin/sh
# Configure OIDC for pgAdmin (pre-start / reconfigure)
#
# Writes pgAdmin OAuth2 configuration as LXC environment variables.
# pgAdmin uses PGADMIN_CONFIG_ prefix for Python config overrides.
#
# Template variables:
#   vm_id              - Container VMID
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret

VM_ID="{{ vm_id }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: Config file not found: $CONF_FILE" >&2
  exit 1
fi

echo "Configuring OIDC for pgAdmin (VM $VM_ID, pre-start)" >&2
echo "  Issuer: $OIDC_ISSUER_URL" >&2

# Remove any existing OAuth2 environment entries
sed -i '/^lxc\.environment:\s*PGADMIN_CONFIG_AUTHENTICATION_SOURCES/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*PGADMIN_CONFIG_OAUTH2_/d' "$CONF_FILE"

# pgAdmin PGADMIN_CONFIG_ values are evaluated as Python code.
# String values MUST be quoted with single quotes inside double quotes.
# Python literals (True, lists) do NOT need quoting.
cat >> "$CONF_FILE" <<EOF
lxc.environment: PGADMIN_CONFIG_AUTHENTICATION_SOURCES=['oauth2','internal']
lxc.environment: PGADMIN_CONFIG_OAUTH2_NAME='Zitadel'
lxc.environment: PGADMIN_CONFIG_OAUTH2_DISPLAY_NAME='Login with Zitadel'
lxc.environment: PGADMIN_CONFIG_OAUTH2_CLIENT_ID='${OIDC_CLIENT_ID}'
lxc.environment: PGADMIN_CONFIG_OAUTH2_CLIENT_SECRET='${OIDC_CLIENT_SECRET}'
lxc.environment: PGADMIN_CONFIG_OAUTH2_TOKEN_URL='${OIDC_ISSUER_URL}/oauth/v2/token'
lxc.environment: PGADMIN_CONFIG_OAUTH2_AUTHORIZATION_URL='${OIDC_ISSUER_URL}/oauth/v2/authorize'
lxc.environment: PGADMIN_CONFIG_OAUTH2_USERINFO_ENDPOINT='${OIDC_ISSUER_URL}/oidc/v1/userinfo'
lxc.environment: PGADMIN_CONFIG_OAUTH2_AUTO_CREATE_USER=True
EOF

echo "pgAdmin OAuth2/OIDC configured via Zitadel" >&2
echo '[]'
