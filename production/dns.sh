#!/bin/sh
# DNS configuration for production environment on OpenWrt
#
# Strategy:
#   - Internal apps (deployer, postgres, zitadel, gitea) use DHCP
#     → dnsmasq resolves their hostnames automatically
#   - External apps (nginx, mosquitto) have static IPs
#     → manual DNS entries required
#   - nginx-served domains (ohnewarum.de, www, git, auth) resolve to nginx
#     (192.168.4.41:443) directly — split DNS. git/auth are internal-only
#     (not in the Cloudflare Tunnel); LAN and WireGuard clients reach them
#     here with the public ACME wildcard cert. No hairpin via 192.168.1.1.
#   - mqtt.ohnewarum.de → mosquitto's real IP directly (same port 8883,
#     no DNAT). Its clients sit in the cluster VLAN 4 like the other
#     internal consumers. No Cloudflare.
#
# Firewall/NAT is no longer managed here — it lives as static nftables
# includes in the repo (openwrt/nftables.d/, applied manually to the router).
#
# Usage: scp production/dns.sh root@router: && ssh root@router sh dns.sh

set -e

# --- Configuration ---
NGINX_IP="192.168.4.41"
REGISTRY_MIRROR_IP="192.168.4.45"
MOSQUITTO_IP="192.168.4.44"
ZOT_MIRROR_IP="192.168.4.50"
PROXVEX_IP="192.168.4.51"
WIREGUARD_IP="192.168.4.53"

MANAGED_TAG="prod-setup"

add_dns() {
  local name="$1"
  local ip="$2"
  # Upsert: an existing entry with another IP is corrected, not skipped —
  # skipping left stale 192.168.1.1 hairpin entries for *.ohnewarum.de alive.
  local sec
  sec=$(uci show dhcp | sed -n "s/^dhcp\.\([^.]*\)\.name='$name'\$/\1/p" | head -1)
  if [ -n "$sec" ]; then
    if [ "$(uci -q get "dhcp.$sec.ip")" = "$ip" ]; then
      echo "DNS entry '$name' → $ip already set"
    else
      uci set "dhcp.$sec.ip=$ip"
      echo "Updated DNS: $name → $ip"
    fi
    return
  fi
  uci add dhcp domain
  uci set "dhcp.@domain[-1].name=$name"
  uci set "dhcp.@domain[-1].ip=$ip"
  uci set "dhcp.@domain[-1].dns=1"
  uci set "dhcp.@domain[-1].managed=$MANAGED_TAG"
  echo "Added DNS: $name → $ip"
}

# === DNS ===

echo "=== Configuring DNS entries ==="

# External apps with static IPs (no DHCP → need manual DNS)
add_dns nginx                  "$NGINX_IP"
add_dns docker-registry-mirror "$REGISTRY_MIRROR_IP"
add_dns eclipse-mosquitto      "$MOSQUITTO_IP"
add_dns zot-mirror             "$ZOT_MIRROR_IP"
add_dns proxvex                "$PROXVEX_IP"
add_dns wireguard              "$WIREGUARD_IP"
# Internal apps use DHCP — dnsmasq resolves hostnames automatically:
#   proxvex, postgres, zitadel, gitea

# Split DNS: nginx-served domains straight to nginx (443).
add_dns ohnewarum.de              "$NGINX_IP"
add_dns www.ohnewarum.de          "$NGINX_IP"
add_dns git.ohnewarum.de          "$NGINX_IP"
add_dns auth.ohnewarum.de         "$NGINX_IP"

# MQTT domain → mosquitto directly (same port 8883, no DNAT). LAN/cluster only.
add_dns mqtt.ohnewarum.de         "$MOSQUITTO_IP"

uci commit dhcp
/etc/init.d/dnsmasq restart
echo "DNS entries configured."

echo ""
echo "=== DNS setup complete ==="
echo ""
echo "Split DNS → nginx (${NGINX_IP}:443):"
echo "  ohnewarum.de, www (also public via Cloudflare Tunnel)"
echo "  git, auth (internal only — LAN + WireGuard)"
echo ""
echo "MQTT (${MOSQUITTO_IP}:8883, cluster VLAN 4 clients):"
echo "  mqtt.ohnewarum.de"
echo ""
echo "Internal apps (DHCP, no manual DNS):"
echo "  proxvex, postgres, zitadel, gitea"
echo ""
echo "Firewall/NAT: managed via static nftables includes"
echo "  (repo openwrt/nftables.d/, applied manually) — not by this script."
