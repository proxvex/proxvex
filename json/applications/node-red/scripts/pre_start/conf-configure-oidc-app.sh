#!/bin/sh
# Configure Node-RED settings.js with OIDC adminAuth (pre-start)
#
# Runs on PVE host before container start. Modifies settings.js directly
# in the shared volume. Only adds OIDC config if adminAuth is not already present.
#
# Template variables:
#   hostname           - Container hostname
#   shared_volpath     - Path to the shared volume mount point
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   oidc_callback_path - Callback path (from addon parameter)
#   ssl_mode           - SSL mode (proxy, native, certs, or empty)
#   https_port         - HTTPS port
#   domain_suffix      - Domain suffix
#   http_port          - HTTP port
#
# Output: JSON to stdout

HOSTNAME="{{ hostname }}"
SHARED_VOLPATH="{{ shared_volpath }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
SSL_MODE="{{ ssl_mode }}"
HTTPS_PORT="{{ https_port }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
HTTP_PORT="{{ http_port }}"

SETTINGS_FILE="${SHARED_VOLPATH}/volumes/${HOSTNAME}/data/settings.js"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "settings.js not found at $SETTINGS_FILE — skipping OIDC configuration" >&2
  echo '[]'
  exit 0
fi

# Check if adminAuth is already configured
if grep -q "adminAuth" "$SETTINGS_FILE"; then
  echo "adminAuth already configured in settings.js — skipping" >&2
  echo '[]'
  exit 0
fi

# Build callback URL
PROTOCOL="http"
PORT="$HTTP_PORT"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "NOT_DEFINED" ] && [ "$SSL_MODE" != "none" ]; then
  PROTOCOL="https"
  if [ -n "$HTTPS_PORT" ] && [ "$HTTPS_PORT" != "NOT_DEFINED" ]; then
    PORT="$HTTPS_PORT"
  fi
fi

if [ -n "$PORT" ] && [ "$PORT" != "NOT_DEFINED" ]; then
  CALLBACK_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}:${PORT}${OIDC_CALLBACK_PATH}"
else
  CALLBACK_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}${OIDC_CALLBACK_PATH}"
fi

echo "Configuring Node-RED OIDC in settings.js" >&2
echo "  Issuer: $OIDC_ISSUER_URL" >&2
echo "  Callback: $CALLBACK_URL" >&2

# Build the adminAuth block
ADMIN_AUTH_BLOCK='    // OIDC authentication — managed by oci-lxc-deployer
    adminAuth: {
        type: "strategy",
        strategy: {
            name: "openidconnect",
            label: "Sign in with Zitadel",
            strategy: require("passport-openidconnect").Strategy,
            options: {
                issuer: "OIDC_ISSUER_URL_PLACEHOLDER",
                authorizationURL: "OIDC_ISSUER_URL_PLACEHOLDER/oauth/v2/authorize",
                tokenURL: "OIDC_ISSUER_URL_PLACEHOLDER/oauth/v2/token",
                userInfoURL: "OIDC_ISSUER_URL_PLACEHOLDER/oidc/v1/userinfo",
                clientID: "OIDC_CLIENT_ID_PLACEHOLDER",
                clientSecret: "OIDC_CLIENT_SECRET_PLACEHOLDER",
                callbackURL: "OIDC_CALLBACK_URL_PLACEHOLDER",
                scope: "openid email profile",
                proxy: true,
                verify: function(issuer, profile, done) { done(null, profile); }
            }
        },
        users: function(user) {
            return Promise.resolve({ username: user, permissions: "*" });
        }
    },'

# Replace placeholders with actual values
ADMIN_AUTH_BLOCK=$(printf '%s' "$ADMIN_AUTH_BLOCK" | sed \
  -e "s|OIDC_ISSUER_URL_PLACEHOLDER|${OIDC_ISSUER_URL}|g" \
  -e "s|OIDC_CLIENT_ID_PLACEHOLDER|${OIDC_CLIENT_ID}|g" \
  -e "s|OIDC_CLIENT_SECRET_PLACEHOLDER|${OIDC_CLIENT_SECRET}|g" \
  -e "s|OIDC_CALLBACK_URL_PLACEHOLDER|${CALLBACK_URL}|g")

# Insert adminAuth block before the last closing brace of module.exports
# Strategy: find the last '}' in the file and insert before it
TMPFILE="${SETTINGS_FILE}.tmp"

# Use awk to insert the block before the last '}'
awk -v block="$ADMIN_AUTH_BLOCK" '
{
  lines[NR] = $0
}
END {
  # Find the last line containing only "}" or "};"
  last_brace = 0
  for (i = NR; i >= 1; i--) {
    if (lines[i] ~ /^[[:space:]]*\}[;]?[[:space:]]*$/) {
      last_brace = i
      break
    }
  }
  for (i = 1; i <= NR; i++) {
    if (i == last_brace) {
      print block
      print ""
    }
    print lines[i]
  }
}
' "$SETTINGS_FILE" > "$TMPFILE"

if [ -s "$TMPFILE" ]; then
  mv "$TMPFILE" "$SETTINGS_FILE"
  echo "adminAuth block added to settings.js" >&2
else
  rm -f "$TMPFILE"
  echo "ERROR: Failed to modify settings.js" >&2
  exit 1
fi

echo '[]'
