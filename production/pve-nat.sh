#!/bin/sh
# NAT-Regeln auf dem PVE-Host für öffentlichen HTTPS-Zugang.
# Mappt Port 443 auf Container-IPs zu den tatsächlichen HTTPS-Ports (>1024).
#
# Rootless LXC-Container können Port 443 nicht binden.
# Diese DNAT-Regeln auf dem PVE-Host lösen das transparent:
# LAN-Client → container-IP:443 → PVE DNAT → container-IP:8443
#
# Ausführung auf dem PVE-Host:
#   ./production/pve-nat.sh
#
# Für Persistenz: als cron @reboot oder in /etc/network/interfaces post-up

set -e

add_port_redirect() {
  local ip="$1"
  local from_port="$2"
  local to_port="$3"
  local name="$4"

  if iptables -t nat -C PREROUTING -d "$ip" -p tcp --dport "$from_port" \
      -j DNAT --to-destination "${ip}:${to_port}" 2>/dev/null; then
    echo "  ${name}: already configured (${ip}:${from_port} → ${to_port})"
  else
    iptables -t nat -A PREROUTING -d "$ip" -p tcp --dport "$from_port" \
      -j DNAT --to-destination "${ip}:${to_port}"
    echo "  ${name}: ${ip}:${from_port} → ${ip}:${to_port}"
  fi
}

echo "Setting up port redirects on PVE host..."

# Nginx: 443 → 8443 (ACME SSL proxy)
add_port_redirect 192.168.4.41  443  8443  "nginx"

# Zitadel: 443 → 8443 (Traefik SSL)
add_port_redirect 192.168.4.42  443  8443  "zitadel"

# Gitea: 443 → 443 (addon-ssl proxy — if rootless, change to actual port)
# add_port_redirect 192.168.4.43  443  8443  "gitea"

echo ""
echo "Port redirects configured."
echo "LAN clients can now use https://auth.ohnewarum.de (→ nginx:8443)"
echo "and https://zitadel (→ zitadel:8443) directly."
echo ""
echo "To make persistent, add to /etc/crontab:"
echo "  @reboot root $(readlink -f "$0")"
