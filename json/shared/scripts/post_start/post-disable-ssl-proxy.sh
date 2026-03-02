#!/bin/sh
# Disable the SSL proxy addon.
#
# Removes on-start drop-in script, stops nginx, cleans iptables rules,
# and removes the nginx SSL config.
#
# Requires:
#   - http_port: Application HTTP port (for iptables cleanup)
#
# Output: errors to stderr only

HTTP_PORT="{{ http_port }}"

echo "Disabling SSL proxy addon..." >&2

# Remove the on-start drop-in script
rm -f /etc/lxc-oci-deployer/on_start.d/ssl-proxy.sh
echo "Removed on_start.d/ssl-proxy.sh" >&2

# Stop nginx if running
if pgrep -x nginx >/dev/null 2>&1; then
  echo "Stopping nginx..." >&2
  pkill nginx 2>/dev/null || true
fi

# Remove iptables HTTP block rules (best effort)
if [ -n "$HTTP_PORT" ] && [ "$HTTP_PORT" != "NOT_DEFINED" ]; then
  iptables -D INPUT -p tcp --dport "${HTTP_PORT}" -j DROP 2>/dev/null || true
  iptables -D INPUT -i lo -p tcp --dport "${HTTP_PORT}" -j ACCEPT 2>/dev/null || true
  echo "Cleaned iptables rules for port ${HTTP_PORT}" >&2
fi

# Remove nginx SSL config files
rm -f /etc/nginx/http.d/ssl-proxy.conf 2>/dev/null
rm -f /etc/nginx/conf.d/ssl-proxy.conf 2>/dev/null
echo "Removed nginx SSL config" >&2

echo "SSL proxy addon disabled" >&2
