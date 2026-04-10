#!/bin/sh
# Enable SSL/TLS for Zitadel docker-compose application
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# Transforms the HTTP compose into HTTPS by:
# 1. Switching traefik config from HTTP to HTTPS
# 2. Adding HTTPS entrypoint, redirect, port, and cert volume to traefik
# 3. Updating env values (EXTERNALSECURE, EXTERNALPORT, URLs, SSL_MODE)
# 4. Fixing cert permissions for non-root Traefik user
set -eu

HOSTNAME="{{ hostname }}"
COMPOSE_B64="{{ compose_file }}"
HTTPS_PORT="{{ https_port }}"
[ -z "$HTTPS_PORT" ] || [ "$HTTPS_PORT" = "NOT_DEFINED" ] && HTTPS_PORT="1443"

# Decode compose to temp file
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
printf '%s' "$COMPOSE_B64" | base64 -d > "$TMPFILE"

# Idempotency: skip if already SSL-transformed
if grep -q 'entrypoints.websecure.address' "$TMPFILE"; then
  echo "SSL already applied, skipping transformation" >&2
  COMPOSE_SSL_B64=$(base64 < "$TMPFILE" | tr -d '\n')
  echo "[{\"id\":\"ssl_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_SSL_B64\"}]"
  exit 0
fi

# 1. Switch traefik config reference: only in the service section (source: line)
sed -i 's/source: traefik-dynamic-http$/source: traefik-dynamic-https/' "$TMPFILE"

# 2. Add HTTPS entrypoint + redirect after web entrypoint
sed -i "/--entrypoints.web.address=:8080/a\\
      - \"--entrypoints.web.http.redirections.entryPoint.to=websecure\"\\
      - \"--entrypoints.web.http.redirections.entryPoint.scheme=https\"\\
      - \"--entrypoints.websecure.address=:${HTTPS_PORT}\"" "$TMPFILE"

# 3. Add HTTPS port mapping after HTTP port
sed -i "/"8080:8080"/a\\
      - \"${HTTPS_PORT}:${HTTPS_PORT}\"" "$TMPFILE"

# 4. Add cert volume to traefik (before configs section)
sed -i '/^    configs:$/i\
    volumes:\
      - /certs:/certs:ro' "$TMPFILE"

# 5. Switch tlsMode from disabled to external (Traefik handles TLS)
sed -i 's/--tlsMode disabled/--tlsMode external/' "$TMPFILE"

# 6. Update env values for HTTPS
sed -i 's/ZITADEL_EXTERNALSECURE: "false"/ZITADEL_EXTERNALSECURE: "true"/' "$TMPFILE"
sed -i "s/ZITADEL_EXTERNALPORT: 8080/ZITADEL_EXTERNALPORT: ${HTTPS_PORT}/" "$TMPFILE"
sed -i "s|http://\([^:]*\):8080/ui/v2/login|https://\1:${HTTPS_PORT}/ui/v2/login|g" "$TMPFILE"
sed -i 's/X-Forwarded-Proto:http/X-Forwarded-Proto:https/' "$TMPFILE"
sed -i 's/SSL_MODE: disable/SSL_MODE: require/g' "$TMPFILE"

# Re-encode
COMPOSE_SSL_B64=$(base64 < "$TMPFILE" | tr -d '\n')

# Fix cert permissions for non-root Traefik user
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CERT_DIR=$(resolve_host_volume "$SAFE_HOST" "certs")

if [ -d "$CERT_DIR" ]; then
  chmod 0755 "$CERT_DIR" 2>/dev/null || true
  chmod 0644 "$CERT_DIR"/*.pem 2>/dev/null || true
  echo "Cert permissions relaxed for non-root Traefik user" >&2
fi

echo "SSL enabled: HTTPS on :8443, HTTP redirect, POSTGRES_SSL_MODE=require" >&2
echo "[{\"id\":\"ssl_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_SSL_B64\"}]"
