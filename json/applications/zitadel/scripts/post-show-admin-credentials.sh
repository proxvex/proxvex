#!/bin/sh
# Show Zitadel admin credentials via completion info.
#
# Emits completion_header, completion_details, and completion_url outputs
# so the CLI and frontend display the admin login credentials after a
# successful deployment.
set -eu

ZITADEL_EXTERNALDOMAIN="{{ ZITADEL_EXTERNALDOMAIN }}"
ZITADEL_ADMIN_PASSWORD="{{ ZITADEL_ADMIN_PASSWORD }}"

# Default-org slug is "zitadel" (FIRSTINSTANCE_ORG_NAME default, lowercased).
# Primary domain follows pattern <org-slug>.<externaldomain>.
ORG_PRIMARY_DOMAIN="zitadel.${ZITADEL_EXTERNALDOMAIN}"
LOGIN_NAME="admin@${ORG_PRIMARY_DOMAIN}"
FULL_PASSWORD="${ZITADEL_ADMIN_PASSWORD}!Aa1"

DETAILS="Login:    ${LOGIN_NAME}
Password: ${FULL_PASSWORD}

Note: the password is the oidc-stack value plus '!Aa1'
(Zitadel password complexity policy). Change it after first login."

# Escape newlines for JSON value
DETAILS_JSON=$(printf '%s' "$DETAILS" | sed ':a;N;$!ba;s/\n/\\n/g')

cat <<EOF
[
  {"id":"admin_loginname","value":"${LOGIN_NAME}"},
  {"id":"completion_header","value":"Zitadel installed successfully"},
  {"id":"completion_details","value":"${DETAILS_JSON}"},
  {"id":"completion_url","value":"https://${ZITADEL_EXTERNALDOMAIN}/"}
]
EOF
