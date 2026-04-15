#!/bin/sh
# Show Zitadel admin credentials prominently for first-time login.
#
# Background:
#   The docker-compose template appends the literal suffix '!Aa1' to the
#   stack-provided ZITADEL_ADMIN_PASSWORD, so the actual password is
#   "<stack value>!Aa1". Without this template, that suffix is invisible to
#   the user and the first login fails because the user typed only the
#   stack value.
#
# This template prints the full computed credentials once at the end of the
# deploy. It's purely informational — output goes to stderr so it shows in
# the deploy log without polluting the JSON outputs on stdout.
set -eu

ZITADEL_EXTERNALDOMAIN="{{ ZITADEL_EXTERNALDOMAIN }}"
ZITADEL_ADMIN_PASSWORD="{{ ZITADEL_ADMIN_PASSWORD }}"

# Default-org slug is "zitadel" (FIRSTINSTANCE_ORG_NAME default, lowercased).
# Primary domain follows pattern <org-slug>.<externaldomain>.
ORG_PRIMARY_DOMAIN="zitadel.${ZITADEL_EXTERNALDOMAIN}"
LOGIN_NAME="admin@${ORG_PRIMARY_DOMAIN}"
FULL_PASSWORD="${ZITADEL_ADMIN_PASSWORD}!Aa1"

cat >&2 <<EOF

================================================================
  Zitadel admin login (first-time setup)
================================================================
  URL:      https://${ZITADEL_EXTERNALDOMAIN}/
  Login:    ${LOGIN_NAME}
  Password: ${FULL_PASSWORD}

  Note: the password is the oidc-stack value plus the literal suffix
  '!Aa1' (appended by the compose template to satisfy Zitadel's
  password complexity policy). Save it now and change it after the
  first login.
================================================================

EOF

cat <<EOF
[{"id":"admin_loginname","value":"${LOGIN_NAME}"}]
EOF
