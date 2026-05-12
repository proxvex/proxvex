#!/bin/sh
# Configure Node-RED settings.js with OIDC adminAuth (pre-start)
#
# Runs on PVE host before container start. Modifies settings.js directly
# in the data volume. Only adds OIDC config if adminAuth is not already present.
#
# Template variables:
#   vm_id              - Container VMID (used to resolve the data volume)
#   hostname           - Container hostname
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   oidc_redirect_uri  - Full OIDC redirect URI
#
# Output: JSON to stdout

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
OIDC_REDIRECT_URI="{{ oidc_redirect_uri }}"

# resolve_host_volume (from auto-injected ve-global.sh) mounts the dedicated
# subvol-<vmid>-<hostname>-data managed volume on the host and returns its
# path. Earlier versions of this script used "${shared_volpath}/volumes/..."
# but shared_volpath is only emitted by 121-conf-mount-zfs-pool-on-host, which
# node-red does not invoke — the file lookup silently failed and the script
# exited 0 without injecting adminAuth.
DATA_DIR=$(resolve_host_volume "$HOSTNAME" "data" "$VM_ID") || {
  echo "ERROR: could not resolve node-red data volume for vmid=$VM_ID host=$HOSTNAME" >&2
  exit 1
}
SETTINGS_FILE="${DATA_DIR}/settings.js"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "settings.js not found at $SETTINGS_FILE — skipping OIDC configuration" >&2
  echo '[]'
  exit 0
fi

# Check if adminAuth is already configured. Strip line comments first so that
# a comment like "// adminAuth is injected at deploy time" does not count as
# an existing configuration and cause us to skip the injection.
if sed 's|//.*||' "$SETTINGS_FILE" | grep -q "adminAuth"; then
  echo "adminAuth already configured in settings.js — skipping" >&2
  echo '[]'
  exit 0
fi

if [ "$OIDC_REDIRECT_URI" = "NOT_DEFINED" ] || [ -z "$OIDC_REDIRECT_URI" ]; then
  echo "ERROR: oidc_redirect_uri is required" >&2
  exit 1
fi
CALLBACK_URL="$OIDC_REDIRECT_URI"

echo "Configuring Node-RED OIDC in settings.js" >&2
echo "  Issuer: $OIDC_ISSUER_URL" >&2
echo "  Callback: $CALLBACK_URL" >&2

# Build the adminAuth block
ADMIN_AUTH_BLOCK='    // OIDC authentication — managed by proxvex
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
