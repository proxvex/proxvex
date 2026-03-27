#!/bin/sh
# DNS and NAT configuration for production environment on OpenWrt
#
# Strategy:
#   - Internal apps (deployer, postgres, zitadel, gitea) use DHCP
#     → dnsmasq resolves their hostnames automatically
#   - External apps (nginx, mosquitto) have static IPs
#     → manual DNS entries required
#   - All public domains → Router alt IP (192.168.1.1)
#     → one NAT rule forwards :443 → nginx:1443
#     → avoids hairpin NAT (source and dest on different subnets)
#
# Usage: scp production/dns.sh root@router: && ssh root@router sh dns.sh

set -e

# --- Configuration ---
NGINX_IP="192.168.4.41"
MOSQUITTO_IP="192.168.4.44"
ROUTER_ALT_IP="192.168.1.1"

add_dns() {
  local name="$1"
  local ip="$2"
  # Check if entry already exists
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

add_redirect() {
  local name="$1"
  local src="$2"
  local dest="$3"
  local src_ip="$4"
  local src_port="$5"
  local dest_ip="$6"
  local dest_port="$7"
  existing=$(uci show firewall | grep "\.name='$name'" || true)
  if [ -n "$existing" ]; then
    echo "NAT redirect '$name' already exists, skipping"
    return
  fi
  uci add firewall redirect
  uci set "firewall.@redirect[-1].name=$name"
  uci set "firewall.@redirect[-1].src=$src"
  uci set "firewall.@redirect[-1].dest=$dest"
  uci set "firewall.@redirect[-1].src_dport=$src_port"
  uci set "firewall.@redirect[-1].dest_ip=$dest_ip"
  uci set "firewall.@redirect[-1].dest_port=$dest_port"
  uci set "firewall.@redirect[-1].proto=tcp"
  uci set "firewall.@redirect[-1].target=DNAT"
  # src_dip only needed for hairpin NAT (LAN), not for WAN
  if [ -n "$src_ip" ]; then
    uci set "firewall.@redirect[-1].src_dip=$src_ip"
  fi
  echo "Added NAT redirect ($src→$dest): ${src_ip:-*}:$src_port → $dest_ip:$dest_port"
}

# === DNS ===

echo "=== Configuring DNS entries ==="

# External apps with static IPs (no DHCP → need manual DNS)
add_dns nginx              "$NGINX_IP"
add_dns eclipse-mosquitto  "$MOSQUITTO_IP"

# Internal apps use DHCP — dnsmasq resolves hostnames automatically:
#   oci-lxc-deployer, postgres, zitadel, gitea

# Public domains → Router alt IP
# All go through the same path: DNS → 192.168.1.1 → NAT → nginx:1443
add_dns ohnewarum.de              "$ROUTER_ALT_IP"
add_dns www.ohnewarum.de          "$ROUTER_ALT_IP"
add_dns auth.ohnewarum.de         "$ROUTER_ALT_IP"
add_dns git.ohnewarum.de          "$ROUTER_ALT_IP"
add_dns nebenkosten.ohnewarum.de  "$ROUTER_ALT_IP"

# MQTT domain → Router alt IP (LAN only, no WAN port forward)
add_dns mqtt.ohnewarum.de         "$ROUTER_ALT_IP"

uci commit dhcp
/etc/init.d/dnsmasq restart
echo "DNS entries configured."

# === NAT ===

echo ""
echo "=== Configuring NAT redirects ==="

# HTTPS: all *.ohnewarum.de → nginx
# LAN: hairpin NAT via router alt IP
add_redirect "public-https-to-nginx" \
  lan cluster "$ROUTER_ALT_IP" 443 "$NGINX_IP" 1443
# WAN: external access
add_redirect "wan-https-to-nginx" \
  wan cluster "" 443 "$NGINX_IP" 1443

# MQTTS: mqtt.ohnewarum.de → mosquitto (LAN only, no WAN)
add_redirect "mqtts-to-mosquitto" \
  lan cluster "$ROUTER_ALT_IP" 8883 "$MOSQUITTO_IP" 8883

uci commit firewall
/etc/init.d/firewall restart

echo ""
echo "=== DNS and NAT setup complete ==="
echo ""
echo "Public domains (all → ${ROUTER_ALT_IP} → NAT → nginx:1443):"
echo "  ohnewarum.de, auth, git, nebenkosten"
echo ""
echo "MQTT (${ROUTER_ALT_IP}:8883 → ${MOSQUITTO_IP}:8883, LAN only):"
echo "  mqtt.ohnewarum.de"
echo ""
echo "Internal apps (DHCP, no manual DNS):"
echo "  oci-lxc-deployer, postgres, zitadel, gitea"
