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

# --- Find nginx container ---
NGINX_VMID=$(pct list | awk '/nginx/{print $1}')
if [ -z "$NGINX_VMID" ]; then
  echo "ERROR: nginx container not found"
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
CERT_DIR="/etc/ssl/addon"
LISTEN_PORT=8080

# --- Create temp dir ---
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# --- 1. Write nginx config files ---
echo "=== Writing nginx config files ==="

# Remove default config (shipped with nginx-unprivileged)
cat > "$TMPDIR/default.conf" <<EOF
# Default: reject unknown domains
server {
    listen ${LISTEN_PORT} default_server;
    return 444;
}
EOF

cat > "$TMPDIR/ohnewarum.conf" <<EOF
server {
    listen ${LISTEN_PORT};
    server_name ohnewarum.de;
    root /usr/share/nginx/html/ohnewarum;
    index index.html;
}
EOF

cat > "$TMPDIR/nebenkosten.conf" <<EOF
server {
    listen ${LISTEN_PORT};
    server_name nebenkosten.ohnewarum.de;
    root /usr/share/nginx/html/nebenkosten;
    index index.html;
    try_files \$uri \$uri/ /index.html;
}
EOF

cat > "$TMPDIR/auth.conf" <<EOF
server {
    listen ${LISTEN_PORT};
    server_name auth.ohnewarum.de;
    location / {
        proxy_pass https://zitadel:8443;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate ${CERT_DIR}/chain.pem;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF

cat > "$TMPDIR/git.conf" <<EOF
server {
    listen ${LISTEN_PORT};
    server_name git.ohnewarum.de;
    client_max_body_size 512m;
    location / {
        proxy_pass https://gitea:443;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate ${CERT_DIR}/chain.pem;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
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
echo ""
echo "=== Reloading nginx ==="
pct exec "$NGINX_VMID" -- nginx -t 2>&1 && \
  pct exec "$NGINX_VMID" -- nginx -s reload 2>&1
echo "  nginx reloaded"

echo ""
echo "=== Nginx setup complete ==="
echo "  Homepage:     https://ohnewarum.de"
echo "  Nebenkosten:  https://nebenkosten.ohnewarum.de (Placeholder)"
echo "  Zitadel:      https://auth.ohnewarum.de"
echo "  Gitea:        https://git.ohnewarum.de"
