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

# Stable IPv6 per static app: the ULA prefix is fixed on router-kg
# (fd29:cd10:9a98::/48, cluster = :0::/64); apps pin ::<octet> via
# static_ip6 (wireguard via ipv6_token). SLAAC addresses follow the MAC and
# change on every upgrade, so DNS only ever points at these.
ULA="fd29:cd10:9a98:"
NGINX_IP6="${ULA}:41"
REGISTRY_MIRROR_IP6="${ULA}:45"
MOSQUITTO_IP6="${ULA}:44"
ZOT_MIRROR_IP6="${ULA}:50"
WIREGUARD_IP6="${ULA}:53"

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

# _dns6_section <name>: uci section of the IPv6 entry for <name>, if any.
_dns6_section() {
  for s in $(uci show dhcp | sed -n "s/^dhcp\.\([^.]*\)\.name='$1'\$/\1/p"); do
    case "$(uci -q get "dhcp.$s.ip")" in
      *:*) echo "$s"; return ;;
    esac
  done
}

# add_dns6 <name> <ipv6>: AAAA counterpart of add_dns. A name can have one
# IPv4 and one IPv6 section, so the upsert matches name AND address family.
add_dns6() {
  local name="$1"
  local ip="$2"
  local sec
  sec=$(_dns6_section "$name")
  if [ -n "$sec" ]; then
    if [ "$(uci -q get "dhcp.$sec.ip")" = "$ip" ]; then
      echo "DNS entry '$name' (AAAA) → $ip already set"
    else
      uci set "dhcp.$sec.ip=$ip"
      echo "Updated DNS: $name (AAAA) → $ip"
    fi
    return
  fi
  uci add dhcp domain
  uci set "dhcp.@domain[-1].name=$name"
  uci set "dhcp.@domain[-1].ip=$ip"
  uci set "dhcp.@domain[-1].dns=1"
  uci set "dhcp.@domain[-1].managed=$MANAGED_TAG"
  echo "Added DNS: $name (AAAA) → $ip"
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

# AAAA for the same names. Clients prefer IPv6, so every name below must be
# served on its ULA (nginx/mosquitto/registry listen on [::]) and the router
# must allow it (lan-cluster-allow-https-443-v6 for nginx).
for n in nginx ohnewarum.de www.ohnewarum.de git.ohnewarum.de auth.ohnewarum.de; do
  add_dns6 "$n" "$NGINX_IP6"
done
add_dns6 docker-registry-mirror "$REGISTRY_MIRROR_IP6"
add_dns6 eclipse-mosquitto      "$MOSQUITTO_IP6"
add_dns6 mqtt.ohnewarum.de      "$MOSQUITTO_IP6"
# Not yet: zot-mirror is not deployed; wireguard's web UI only listens on
# IPv6 after a reconfigure (ssl-proxy hook from before the IPv6 fix).
# add_dns6 zot-mirror             "$ZOT_MIRROR_IP6"
# add_dns6 wireguard              "$WIREGUARD_IP6"

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
