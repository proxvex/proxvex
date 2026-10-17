#!/bin/bash
# >>> proxvex-cwd-guard (auto-generated) — repo-root cwd + absolute $0, any caller cwd
case "$0" in
  /*) _pvx_self="$0" ;;
  *)  _pvx_self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")" || { echo "FATAL cwd-guard: cannot resolve $0" >&2; exit 2; } ;;
esac
_pvx_rr="$(cd "$(dirname "$_pvx_self")/.." 2>/dev/null && pwd)" || { echo "FATAL cwd-guard: cannot resolve repo root from $0" >&2; exit 2; }
if [ -f "$_pvx_rr/package.json" ] && [ -d "$_pvx_rr/e2e" ] && [ -d "$_pvx_rr/production" ]; then
  if [ "$0" != "$_pvx_self" ]; then cd "$_pvx_rr" && exec "$_pvx_self" "$@"; fi
  cd "$_pvx_rr" || echo "WARN cwd-guard: cannot cd to '$_pvx_rr'; continuing in $(pwd)" >&2
fi
unset _pvx_self _pvx_rr
# <<< proxvex-cwd-guard
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
# Running containers only: an upgrade leaves the previous container stopped
# (lock: migrate) as a fallback, and it still carries hostname nginx.
NGINX_VMID=$(pct list | awk '$2 == "running" && $NF == "nginx" {print $1}')
if [ -z "$NGINX_VMID" ]; then
  echo "ERROR: no running nginx container found"
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
# nginx runs as uid 101 and binds 443 directly: the container is deployed
# with unprivileged_port_start=443, so the init wrapper (proxvex-init) lowers
# net.ipv4.ip_unprivileged_port_start as root and then drops to uid 101. The
# Cloudflare Tunnel origins and the LAN (split-DNS) both use :443; the old
# 1443 listener and the router's 443 -> 1443 DNAT are gone.
CERT_DIR="/etc/ssl/addon"
LISTEN_PORT=443
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
    listen [::]:${LISTEN_PORT} ssl default_server;
${SSL_DIRECTIVES}
    return 444;
}
EOF

cat > "$TMPDIR/ohnewarum.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    listen [::]:${LISTEN_PORT} ssl;
    server_name ohnewarum.de;
${SSL_DIRECTIVES}
    root /usr/share/nginx/html/ohnewarum;
    index index.html;
}
EOF

cat > "$TMPDIR/nebenkosten.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    listen [::]:${LISTEN_PORT} ssl;
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
    listen [::]:${LISTEN_PORT} ssl;
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
    listen [::]:${LISTEN_PORT} ssl;
    server_name git.ohnewarum.de;
${SSL_DIRECTIVES}
    client_max_body_size 512m;
    location / {
        proxy_pass https://gitea:1443;
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

# gptwol: only the /api/wake/* path is reachable from the public internet.
# Upstream is oauth2-proxy inside the gptwol LXC (port 8443, provided by
# addon-oauth2-proxy), which validates Authorization: Bearer JWTs against
# Zitadel JWKS and proxies validated requests to gptwol's internal port 5000.
# All other paths return 404 — the gptwol UI is intentionally not exposed
# externally; LAN users reach it directly at http://gptwol:5000.
cat > "$TMPDIR/gptwol.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    listen [::]:${LISTEN_PORT} ssl;
    server_name gptwol.ohnewarum.de;
${SSL_DIRECTIVES}
    location /api/wake/ {
        proxy_pass https://gptwol:8443;
        proxy_http_version 1.1;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate ${CERT_DIR}/chain.pem;
        proxy_ssl_server_name on;
        proxy_ssl_name gptwol;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Authorization \$http_authorization;
    }
    location / {
        return 404;
    }
}
EOF

# wolproxy: stable JSON API for WoL+ping, Bearer-only public endpoint.
# Same pattern as gptwol — addon-oauth2-proxy on wolproxy:8443 validates
# Authorization: Bearer JWTs against Zitadel JWKS, then proxies to the
# internal wolproxy port 5000. Unlike gptwol no UI exists, so we expose
# /wake, /status, /health — every other path 404. LAN tooling reaches
# wolproxy directly at http://wolproxy:5000.
cat > "$TMPDIR/wolproxy.conf" <<EOF
server {
    listen ${LISTEN_PORT} ssl;
    listen [::]:${LISTEN_PORT} ssl;
    server_name wolproxy.ohnewarum.de;
${SSL_DIRECTIVES}
    location ~ ^/(wake|status|health)\$ {
        proxy_pass https://wolproxy:8443;
        proxy_http_version 1.1;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate ${CERT_DIR}/chain.pem;
        proxy_ssl_server_name on;
        proxy_ssl_name wolproxy;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Authorization \$http_authorization;
    }
    location / {
        return 404;
    }
}
EOF

# Push config files into container. nginx resolves every proxy_pass host when
# it loads the config, so ONE unresolvable upstream (an app that is not
# deployed, e.g. gptwol) makes `nginx -s reload` and a fresh start fail for
# ALL sites. Skip such vhosts — and remove a stale copy — with a warning; the
# next run brings them back once the upstream resolves again.
SKIPPED=""
for conf in default.conf ohnewarum.conf nebenkosten.conf auth.conf git.conf gptwol.conf wolproxy.conf; do
  upstream=$(sed -n 's|.*proxy_pass https\{0,1\}://\([^:/;]*\).*|\1|p' "$TMPDIR/$conf" | head -1)
  if [ -n "$upstream" ] && ! pct exec "$NGINX_VMID" -- nslookup "$upstream" 2>/dev/null | grep -q "^Name:"; then
    pct exec "$NGINX_VMID" -- rm -f "/etc/nginx/conf.d/$conf"
    SKIPPED="$SKIPPED $conf($upstream)"
    echo "  WARNING: skipped $conf — upstream '$upstream' does not resolve"
    continue
  fi
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

# Copy profile page
pct push "$NGINX_VMID" "$SCRIPT_DIR/volkmar-nissen-profil.html" \
  /usr/share/nginx/html/ohnewarum/profil.html
echo "  Pushed volkmar-nissen-profil.html → /usr/share/nginx/html/ohnewarum/profil.html"

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
echo "  gptwol API:   https://gptwol.ohnewarum.de/api/wake/<host> (M2M Bearer JWT only)"
echo "  wolproxy:     https://wolproxy.ohnewarum.de/{wake,status,health} (M2M Bearer JWT only)"
if [ -n "$SKIPPED" ]; then
  echo ""
  echo "  WARNING: vhosts NOT active (upstream does not resolve):$SKIPPED"
fi
