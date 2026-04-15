#!/bin/bash
# Configure nginx: virtual hosts and homepage.
# Runs directly on pve1.cluster (no SSH).
#
# Prerequisites:
#   - nginx container is deployed (deploy.sh nginx)
#   - ACME wildcard certificate is provisioned
#
# Usage (on pve1.cluster):
#   ./production/setup-nginx.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Find nginx container (match hostname column exactly, not anywhere) ---
NGINX_VMID=$(pct list | awk '$NF == "nginx" {print $1}')
if [ -z "$NGINX_VMID" ]; then
  echo "ERROR: nginx container not found"
  exit 1
fi
if [ "$(echo "$NGINX_VMID" | wc -l)" -gt 1 ]; then
  echo "ERROR: multiple nginx containers found: $(echo $NGINX_VMID | tr '\n' ' ')"
  echo "       Clean up the unwanted ones before running this script."
  exit 1
fi
echo "Nginx VMID: $NGINX_VMID"

# --- Ensure container is running ---
STATUS=$(pct status "$NGINX_VMID" | awk '{print $2}')
if [ "$STATUS" != "running" ]; then
  echo "ERROR: nginx container is not running (status: $STATUS)"
  exit 1
fi

# --- Cert and port config ---
# nginx runs rootless (uid 101) and cannot bind ports < 1024, so TLS
# terminates on 1443. The router DNATs 443 → 1443 (see production/dns.sh).
CERT_DIR="/etc/ssl/addon"
LISTEN_PORT=1443
SSL_DIRECTIVES="    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;"

# --- Create temp dir ---
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# --- 1. Write nginx config files ---
echo "=== Writing nginx config files ==="

# Remove default config (shipped with nginx-unprivileged)
cat > "$TMPDIR/default.conf" <<EOF
# Default: reject unknown domains
server {
    listen ${LISTEN_PORT} ssl default_server;
${SSL_DIRECTIVES}
    return 444;
}
EOF

cat > "$TMPDIR/ohnewarum.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    server_name ohnewarum.de;
${SSL_DIRECTIVES}
    root /usr/share/nginx/html/ohnewarum;
    index index.html;
}
EOF

cat > "$TMPDIR/nebenkosten.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    server_name nebenkosten.ohnewarum.de;
${SSL_DIRECTIVES}
    root /usr/share/nginx/html/nebenkosten;
    index index.html;
    try_files \$uri \$uri/ /index.html;
}
EOF

cat > "$TMPDIR/auth.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    server_name auth.ohnewarum.de;
${SSL_DIRECTIVES}
    location / {
        proxy_pass https://zitadel:1443;
        proxy_http_version 1.1;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate ${CERT_DIR}/chain.pem;
        proxy_ssl_server_name on;
        proxy_ssl_name zitadel;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Port 443;
    }
}
EOF

cat > "$TMPDIR/git.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    server_name git.ohnewarum.de;
${SSL_DIRECTIVES}
    client_max_body_size 512m;
    location / {
        proxy_pass https://gitea:443;
        proxy_http_version 1.1;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate ${CERT_DIR}/chain.pem;
        proxy_ssl_server_name on;
        proxy_ssl_name gitea;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Port 443;
    }
}
EOF

# Push config files into container
for conf in default.conf ohnewarum.conf nebenkosten.conf auth.conf git.conf; do
  pct push "$NGINX_VMID" "$TMPDIR/$conf" "/etc/nginx/conf.d/$conf"
  echo "  Pushed $conf"
done

# --- 2. Create directories and copy homepage ---
echo ""
echo "=== Setting up homepage ==="

pct exec "$NGINX_VMID" -- mkdir -p /usr/share/nginx/html/ohnewarum
pct exec "$NGINX_VMID" -- mkdir -p /usr/share/nginx/html/nebenkosten

# Copy homepage
pct push "$NGINX_VMID" "$SCRIPT_DIR/ohnewarum_startseite.html" \
  /usr/share/nginx/html/ohnewarum/index.html
echo "  Pushed ohnewarum_startseite.html → /usr/share/nginx/html/ohnewarum/index.html"

# Placeholder for nebenkosten (will be replaced with actual app later)
cat > "$TMPDIR/nebenkosten-placeholder.html" <<'EOF'
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Nebenkosten</title></head>
<body><p>Nebenkosten-App wird geladen...</p></body>
</html>
EOF
pct push "$NGINX_VMID" "$TMPDIR/nebenkosten-placeholder.html" \
  /usr/share/nginx/html/nebenkosten/index.html
echo "  Pushed nebenkosten placeholder"

# --- 3. Fix ownership (nginx-unprivileged runs as uid 101) ---
echo ""
echo "=== Fixing ownership ==="
pct exec "$NGINX_VMID" -- chown -R 101:101 /usr/share/nginx/html/ohnewarum
pct exec "$NGINX_VMID" -- chown -R 101:101 /usr/share/nginx/html/nebenkosten
pct exec "$NGINX_VMID" -- chown -R 101:101 /etc/nginx/conf.d/
echo "  Ownership set to 101:101"

# --- 4. Reload nginx ---
# We send SIGHUP directly via `nginx -s reload` and skip a preliminary
# `nginx -t` pass: running it as a separate process conflicts with the
# already-running master's /tmp/nginx.pid and /var/log/nginx/error.log (both
# owned by uid 101) and fails with "Permission denied", aborting the reload
# even though the config is valid. The master re-parses on SIGHUP anyway: if
# the new config is broken it logs and keeps the old one, so we still get
# safe behaviour.
echo ""
echo "=== Reloading nginx ==="
if pct exec "$NGINX_VMID" -- nginx -s reload 2>&1; then
  echo "  nginx reloaded"
else
  echo "ERROR: nginx -s reload failed (see output above)" >&2
  exit 1
fi

echo ""
echo "=== Nginx setup complete ==="
echo "  Homepage:     https://ohnewarum.de"
echo "  Nebenkosten:  https://nebenkosten.ohnewarum.de (Placeholder)"
echo "  Zitadel:      https://auth.ohnewarum.de"
echo "  Gitea:        https://git.ohnewarum.de"
