#!/bin/sh
# NAT-Regeln für öffentlichen HTTPS-Zugang über Nginx.
# Leitet Port 443 auf der Router-IP an Nginx:8443 weiter.
#
# Öffentliche Domains (auth.ohnewarum.de, git.ohnewarum.de, etc.)
# zeigen per dnsmasq auf die Router-IP. Diese DNAT-Regel leitet
# den Traffic an Nginx weiter — funktioniert sowohl im LAN als auch von extern.
#
# Ausführung: scp auf Router, dann sh router-nat.sh
#
# Für Persistenz über Reboots: in /etc/firewall.user oder als uci-Regel einrichten.

set -e

NGINX_IP="192.168.4.41"
NGINX_HTTPS_PORT=8443

# DNAT: Port 443 → Nginx HTTPS port
if iptables -t nat -C PREROUTING -p tcp --dport 443 -j DNAT --to-destination "${NGINX_IP}:${NGINX_HTTPS_PORT}" 2>/dev/null; then
  echo "DNAT rule already exists (443 → ${NGINX_IP}:${NGINX_HTTPS_PORT}), skipping"
else
  iptables -t nat -A PREROUTING -p tcp --dport 443 -j DNAT --to-destination "${NGINX_IP}:${NGINX_HTTPS_PORT}"
  echo "Added DNAT: *:443 → ${NGINX_IP}:${NGINX_HTTPS_PORT}"
fi

# Ensure forwarding is enabled
if [ "$(cat /proc/sys/net/ipv4/ip_forward)" != "1" ]; then
  echo 1 > /proc/sys/net/ipv4/ip_forward
  echo "IP forwarding enabled"
fi

# Masquerade so return traffic goes back through the router
if ! iptables -t nat -C POSTROUTING -d "$NGINX_IP" -p tcp --dport "$NGINX_HTTPS_PORT" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -d "$NGINX_IP" -p tcp --dport "$NGINX_HTTPS_PORT" -j MASQUERADE
  echo "Added MASQUERADE for return traffic"
fi

echo ""
echo "NAT rules configured."
echo "  https://*.ohnewarum.de:443 → ${NGINX_IP}:${NGINX_HTTPS_PORT} (Nginx)"
echo ""
echo "To make persistent, add to /etc/firewall.user or use:"
echo "  uci add firewall redirect"
echo "  uci set firewall.@redirect[-1].target=DNAT"
echo "  uci set firewall.@redirect[-1].proto=tcp"
echo "  uci set firewall.@redirect[-1].src_dport=443"
echo "  uci set firewall.@redirect[-1].dest_ip=${NGINX_IP}"
echo "  uci set firewall.@redirect[-1].dest_port=${NGINX_HTTPS_PORT}"
echo "  uci commit firewall && /etc/init.d/firewall restart"
