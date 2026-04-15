#!/bin/sh
# Create Cloudflare MX + SPF TXT records for the mail domain.
#
# Idempotent: only creates records if they don't already exist with the
# desired value. Designed to run non-interactively from a post_start template
# during a Zitadel deploy.
#
# Inputs (template variables):
#   smtp_own_domain   - bool gate; when "true" the script runs, else skips
#   smtp_mail_domain  - apex domain (e.g. example.com)
#   smtp_mx_target    - MX hostname (e.g. mxext1.mailbox.org)
#   smtp_spf_value    - TXT value (e.g. "v=spf1 include:mailbox.org ~all")
#   CF_TOKEN          - Cloudflare API token with Zone:DNS:Edit on the zone
#
# Output: JSON on stdout, log lines on stderr.
set -eu

SMTP_OWN_DOMAIN="{{ smtp_own_domain }}"
MAIL_DOMAIN="{{ smtp_mail_domain }}"
MX_TARGET="{{ smtp_mx_target }}"
SPF_VALUE="{{ smtp_spf_value }}"
CF_TOKEN="{{ CF_TOKEN }}"

# Normalize NOT_DEFINED sentinels from the template engine
[ "$SMTP_OWN_DOMAIN" = "NOT_DEFINED" ] && SMTP_OWN_DOMAIN=""
[ "$MAIL_DOMAIN" = "NOT_DEFINED" ] && MAIL_DOMAIN=""
[ "$MX_TARGET" = "NOT_DEFINED" ] && MX_TARGET=""
[ "$SPF_VALUE" = "NOT_DEFINED" ] && SPF_VALUE=""
[ "$CF_TOKEN" = "NOT_DEFINED" ] && CF_TOKEN=""

log() { echo "$@" >&2; }

# Gate: only run when own-domain mode is on AND the required inputs are present.
if [ "$SMTP_OWN_DOMAIN" != "true" ]; then
  log "smtp_own_domain is not true — skipping mail DNS setup."
  echo '[]'
  exit 0
fi

if [ -z "$MAIL_DOMAIN" ] || [ -z "$MX_TARGET" ] || [ -z "$CF_TOKEN" ]; then
  log "ERROR: smtp_own_domain is true but mail_domain, mx_target or CF_TOKEN is empty."
  log "       Set all three in the app parameters / cloudflare stack."
  exit 1
fi

CF_API="https://api.cloudflare.com/client/v4"
AUTH_HEADER="Authorization: Bearer $CF_TOKEN"
JSON_HEADER="Content-Type: application/json"

# --- Resolve zone id from mail domain ---
log "Looking up Cloudflare zone for $MAIL_DOMAIN..."
ZONE_RESP=$(curl -sf -H "$AUTH_HEADER" "$CF_API/zones?name=$MAIL_DOMAIN") || {
  log "ERROR: Cloudflare API zone lookup failed"
  exit 1
}
ZONE_ID=$(echo "$ZONE_RESP" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -1)
if [ -z "$ZONE_ID" ]; then
  log "ERROR: No Cloudflare zone found for '$MAIL_DOMAIN'."
  log "       Response: $ZONE_RESP"
  exit 1
fi
log "  Zone id: $ZONE_ID"

# --- Helper: upsert a DNS record (create if absent, update if different) ---
#   $1 = type (MX, TXT)
#   $2 = name
#   $3 = content
#   $4 = priority (optional, MX only)
upsert_record() {
  _type="$1"
  _name="$2"
  _content="$3"
  _priority="${4:-}"

  _existing=$(curl -sf -H "$AUTH_HEADER" \
    "$CF_API/zones/$ZONE_ID/dns_records?type=$_type&name=$_name") || {
    log "ERROR: record lookup failed for $_type $_name"
    return 1
  }

  _record_id=$(echo "$_existing" | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -1)

  _payload="{\"type\":\"$_type\",\"name\":\"$_name\",\"content\":\"$_content\",\"ttl\":300"
  if [ -n "$_priority" ]; then
    _payload="$_payload,\"priority\":$_priority"
  fi
  _payload="$_payload}"

  if [ -n "$_record_id" ]; then
    log "  Updating $_type $_name (id=$_record_id)"
    curl -sf -X PUT -H "$AUTH_HEADER" -H "$JSON_HEADER" \
      -d "$_payload" \
      "$CF_API/zones/$ZONE_ID/dns_records/$_record_id" >/dev/null || {
      log "ERROR: update failed"
      return 1
    }
  else
    log "  Creating $_type $_name"
    curl -sf -X POST -H "$AUTH_HEADER" -H "$JSON_HEADER" \
      -d "$_payload" \
      "$CF_API/zones/$ZONE_ID/dns_records" >/dev/null || {
      log "ERROR: create failed"
      return 1
    }
  fi
}

# --- MX record for the apex ---
log "Ensuring MX record: $MAIL_DOMAIN -> $MX_TARGET (priority 10)"
upsert_record MX "$MAIL_DOMAIN" "$MX_TARGET" 10

# --- SPF TXT record for the apex ---
if [ -n "$SPF_VALUE" ]; then
  log "Ensuring SPF TXT: $MAIL_DOMAIN = '$SPF_VALUE'"
  upsert_record TXT "$MAIL_DOMAIN" "$SPF_VALUE"
fi

log "Mail DNS setup complete."
cat <<EOF
[{"id":"mail_dns_zone_id","value":"$ZONE_ID"}]
EOF
