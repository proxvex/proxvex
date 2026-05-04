#!/bin/sh
# Strip ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_* env vars from the compose
# when SMTP_PASSWORD is empty.
#
# Why: Zitadel's 03_default_instance migration calls
# prepareAddAndActivateSMTPConfig, which rejects blank/partial SMTP config
# with `InvalidArgument` and leaves the instance in a failed state on first
# boot. The only way Zitadel skips SMTP setup is when the ENV vars are not
# present at all. Since docker-compose supports only value substitution (not
# line-removal) and the deployer's compose scanner needs these keys to
# discover the parameters, we strip them from the rendered compose here.
#
# Decodes the compose base64, removes the SMTP block by sed when
# SMTP_PASSWORD is empty, and re-emits it as a compose_file output.
set -eu

COMPOSE_B64="{{ compose_file }}"
SMTP_PASSWORD="{{ SMTP_PASSWORD }}"
[ "$SMTP_PASSWORD" = "NOT_DEFINED" ] && SMTP_PASSWORD=""

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
printf '%s' "$COMPOSE_B64" | base64 -d > "$TMPFILE"

if [ -n "$SMTP_PASSWORD" ]; then
  echo "SMTP_PASSWORD set — keeping SMTP config in compose" >&2
  echo "[{\"id\":\"compose_file\",\"value\":\"${COMPOSE_B64}\"}]"
  exit 0
fi

REMOVED=$(grep -c "ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_" "$TMPFILE" 2>/dev/null || echo 0)
if [ "$REMOVED" -gt 0 ]; then
  sed -i '/ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_/d' "$TMPFILE"
  echo "SMTP_PASSWORD empty — stripped ${REMOVED} SMTP ENV lines from compose" >&2
fi

COMPOSE_NEW_B64=$(base64 < "$TMPFILE" | tr -d '\n')
echo "[{\"id\":\"compose_file\",\"value\":\"${COMPOSE_NEW_B64}\"}]"
