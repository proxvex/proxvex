#!/bin/sh
# Install acme.sh and issue Let's Encrypt wildcard certificate via Cloudflare DNS-01
#
# Runs inside the nginx LXC container.
# Certificates are deployed to /etc/ssl/addon/ (same path as SSL addon).
#
# Template variables:
#   CF_TOKEN       - Cloudflare API Token (Zone:DNS:Edit)
#   CF_ZONE_ID     - Cloudflare Zone ID
#   acme_domain    - Domain for wildcard cert (optional, derived from domain_suffix)
#   domain_suffix  - Domain suffix (e.g. .ohnewarum.de)

CF_TOKEN="{{ CF_TOKEN }}"
CF_ZONE_ID="{{ CF_ZONE_ID }}"
ACME_DOMAIN="{{ acme_domain }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"

# Guard against NOT_DEFINED
if [ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ]; then DOMAIN_SUFFIX=""; fi
if [ "$ACME_DOMAIN" = "NOT_DEFINED" ]; then ACME_DOMAIN=""; fi

# Derive domain from domain_suffix if acme_domain not set
if [ -z "$ACME_DOMAIN" ]; then
  # Strip leading dot: .ohnewarum.de → ohnewarum.de
  ACME_DOMAIN=$(echo "$DOMAIN_SUFFIX" | sed 's/^\.//')
fi

if [ -z "$ACME_DOMAIN" ]; then
  echo "ERROR: No domain configured (set acme_domain or domain_suffix)" >&2
  echo '[]'
  exit 1
fi

echo "Setting up Let's Encrypt wildcard cert for *.${ACME_DOMAIN}" >&2

# Install dependencies
apk add --no-cache curl openssl socat >/dev/null 2>&1 || apt-get install -y curl openssl socat >/dev/null 2>&1

# Install acme.sh
if [ ! -f /root/.acme.sh/acme.sh ]; then
  echo "Installing acme.sh..." >&2
  curl -fsSL https://get.acme.sh | sh -s email=acme@${ACME_DOMAIN} >&2
fi

# Configure Cloudflare credentials
export CF_Token="$CF_TOKEN"
export CF_Zone_ID="$CF_ZONE_ID"

# Issue certificate (--force to always issue, even if existing cert is still valid)
echo "Issuing wildcard certificate for ${ACME_DOMAIN} and *.${ACME_DOMAIN}..." >&2
/root/.acme.sh/acme.sh --issue \
  --dns dns_cf \
  -d "$ACME_DOMAIN" \
  -d "*.${ACME_DOMAIN}" \
  --force >&2 || true

# Deploy to /etc/ssl/addon/ (SSL addon mount point)
mkdir -p /etc/ssl/addon
echo "Installing certificate to /etc/ssl/addon/..." >&2
/root/.acme.sh/acme.sh --install-cert \
  -d "$ACME_DOMAIN" \
  --fullchain-file /etc/ssl/addon/fullchain.pem \
  --key-file /etc/ssl/addon/privkey.pem \
  --reloadcmd "nginx -s reload 2>/dev/null || true" \
  >&2

# Install on_start.d renewal drop-in (background loop, checks daily)
mkdir -p /etc/lxc-oci-deployer/on_start.d
cat > /etc/lxc-oci-deployer/on_start.d/acme-renew.sh <<'RENEWAL'
#!/bin/sh
# ACME certificate auto-renewal (background daemon)
# Started by on_start_container dispatcher on every container boot.
# Runs acme.sh --cron daily (checks expiry, renews if needed).
ACME="/root/.acme.sh/acme.sh"
[ -f "$ACME" ] || exit 0

# Kill any previous instance
[ -f /var/run/acme-renew.pid ] && kill "$(cat /var/run/acme-renew.pid)" 2>/dev/null

while true; do
  sleep 86400
  "$ACME" --cron 2>&1 | logger -t acme-renew || true
done &
echo $! > /var/run/acme-renew.pid
RENEWAL
chmod +x /etc/lxc-oci-deployer/on_start.d/acme-renew.sh

echo "Wildcard certificate installed for *.${ACME_DOMAIN}" >&2
echo "Auto-renewal daemon configured (on_start.d/acme-renew.sh)" >&2
echo '[]'
