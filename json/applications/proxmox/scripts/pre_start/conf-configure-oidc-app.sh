#!/bin/sh
# Proxmox override: Configure PVE OIDC realm via pveum CLI
#
# Creates or modifies an OpenID Connect realm in Proxmox VE.
# The realm appears on the PVE login page as an authentication option.
#
# Template variables:
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret

REALM="oidc-zitadel"
ISSUER="{{ oidc_issuer_url }}"
CLIENT_ID="{{ oidc_client_id }}"
CLIENT_SECRET="{{ oidc_client_secret }}"

if [ -z "$ISSUER" ] || [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "Missing OIDC credentials, skipping realm configuration" >&2
  echo '[]'
  exit 0
fi

echo "Configuring PVE OIDC realm '$REALM'..." >&2

# Check if realm already exists
if pveum realm list --output-format json 2>/dev/null | grep -q "\"$REALM\""; then
  pveum realm modify "$REALM" \
    --issuer-url "$ISSUER" \
    --client-id "$CLIENT_ID" \
    --client-key "$CLIENT_SECRET" \
    --username-claim preferred_username \
    --autocreate 1 >&2
  echo "Modified OIDC realm $REALM" >&2
else
  pveum realm add "$REALM" --type openid \
    --issuer-url "$ISSUER" \
    --client-id "$CLIENT_ID" \
    --client-key "$CLIENT_SECRET" \
    --username-claim preferred_username \
    --autocreate 1 >&2
  echo "Created OIDC realm $REALM" >&2
fi

echo '[]'
