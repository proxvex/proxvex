#!/bin/sh
# DNS-Einträge für Production-Umgebung auf OpenWrt anlegen
# Ausführung: scp auf Router, dann sh dns.sh

set -e

add_dns() {
  local name="$1"
  local ip="$2"
  # Prüfen ob Eintrag schon existiert
  existing=$(uci show dhcp | grep "\.name='$name'" || true)
  if [ -n "$existing" ]; then
    echo "DNS entry '$name' already exists, skipping"
    return
  fi
  uci add dhcp domain
  uci set "dhcp.@domain[-1].name=$name"
  uci set "dhcp.@domain[-1].ip=$ip"
  uci set "dhcp.@domain[-1].dns=1"
  echo "Added DNS: $name → $ip"
}

# Container hostnames
add_dns oci-lxc-deployer    192.168.4.39

add_dns postgres    192.168.4.40
add_dns nginx       192.168.4.41
add_dns zitadel     192.168.4.42
add_dns gitea       192.168.4.43

# Public domains → Nginx container IP
# PVE host DNAT maps 443 → 8443, so https://auth.ohnewarum.de works in LAN
NGINX_IP="192.168.4.41"
add_dns ohnewarum.de              "$NGINX_IP"
add_dns www.ohnewarum.de          "$NGINX_IP"
add_dns auth.ohnewarum.de         "$NGINX_IP"
add_dns git.ohnewarum.de          "$NGINX_IP"
add_dns nebenkosten.ohnewarum.de  "$NGINX_IP"

uci commit dhcp
/etc/init.d/dnsmasq restart

echo "DNS entries configured."
