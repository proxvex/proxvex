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
VM_ID="{{ vm_id }}"
COMPOSE_B64="{{ compose_file }}"
LOCAL_HTTPS_PORT="{{ local_https_port }}"
[ -z "$LOCAL_HTTPS_PORT" ] || [ "$LOCAL_HTTPS_PORT" = "NOT_DEFINED" ] && LOCAL_HTTPS_PORT="1443"

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
      - \"--entrypoints.websecure.address=:${LOCAL_HTTPS_PORT}\"" "$TMPFILE"

# 3. Add HTTPS port mapping after HTTP port
sed -i "/"8080:8080"/a\\
      - \"${LOCAL_HTTPS_PORT}:${LOCAL_HTTPS_PORT}\"" "$TMPFILE"

# 4. Add cert volume to traefik (before configs section)
sed -i '/^    configs:$/i\
    volumes:\
      - /certs:/certs:ro' "$TMPFILE"

# 5. Switch tlsMode from disabled to external (Traefik handles TLS)
sed -i 's/--tlsMode disabled/--tlsMode external/' "$TMPFILE"

# 6. Database SSL mode now lives in zitadel.yaml on the `config` managed
# volume (written pre-start by conf-write-zitadel-yaml, step 155, which runs
# before this script at step 159). Patch it there instead of in the compose
# env. EXTERNALSECURE / EXTERNALPORT / FORWARDED_PROTO / PUBLIC_BASE_URL are
# template-var driven into zitadel.yaml — set them via app parameters
# (production/zitadel.json), not here.

# Re-encode (compose now only carries the Traefik HTTPS changes + tlsMode)
COMPOSE_SSL_B64=$(base64 < "$TMPFILE" | tr -d '\n')

# Fix cert permissions for non-root Traefik user.
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CERT_DIR=$(resolve_host_volume "$SAFE_HOST" "certs" "$VM_ID")

if [ -d "$CERT_DIR" ]; then
  chmod 0755 "$CERT_DIR" 2>/dev/null || true
  chmod 0644 "$CERT_DIR"/*.pem 2>/dev/null || true
  echo "Cert permissions relaxed for non-root Traefik user" >&2
fi

# Patch Database SSL mode in the on-volume zitadel.yaml (disable -> require).
# Covers both User.SSL.Mode and Admin.SSL.Mode. Idempotent: re-runs find no
# `Mode: disable` and no-op.
CONFIG_DIR=$(resolve_host_volume "$SAFE_HOST" "config" "$VM_ID")
if [ -f "$CONFIG_DIR/zitadel.yaml" ]; then
  sed -i 's/^\([[:space:]]*\)Mode: disable/\1Mode: require/g' "$CONFIG_DIR/zitadel.yaml"
  echo "Patched zitadel.yaml Database SSL Mode -> require" >&2
else
  echo "Warning: $CONFIG_DIR/zitadel.yaml not found — SSL mode not patched" >&2
fi

echo "SSL enabled: HTTPS on :8443, HTTP redirect, DB SSL Mode=require" >&2
echo "[{\"id\":\"ssl_app_enabled\",\"value\":\"true\"},{\"id\":\"compose_file\",\"value\":\"$COMPOSE_SSL_B64\"}]"
