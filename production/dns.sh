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
  echo "Added DNS: $name → $ip"
}

add_dns postgres    192.168.4.40
add_dns nginx       192.168.4.41
add_dns zitadel     192.168.4.42
add_dns gitea       192.168.4.43

uci commit dhcp
/etc/init.d/dnsmasq restart

echo "DNS entries configured."
