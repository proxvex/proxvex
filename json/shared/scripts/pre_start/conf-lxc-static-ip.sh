#!/bin/sh
# Edit LXC network settings for a container
#
# This script configures static IP addresses for an LXC container by:
# 1. Updating LXC container network configuration
# 2. Setting IPv4 and/or IPv6 addresses
# 3. Configuring gateway settings
#
# Requires:
#   - vm_id: LXC container ID (from context)
#   - hostname: Container hostname (from context)
#   - static_ip: IPv4 address (optional)
#   - static_ip6: IPv6 address (optional)
#   - static_gw: IPv4 gateway (optional)
#   - static_gw6: IPv6 gateway (optional)
#
# Output: JSON to stdout (errors to stderr)
#   {{ bridge }} (string)

# Helper function to output JSON result
output_result() {
  _configured="$1"
  _ip="$2"
  printf '[{"id": "static_ip_configured", "value": "%s"}, {"id": "static_ip", "value": "%s"}]\n' "$_configured" "$_ip"
}
ipv4_ok=true

 # Initialize variables from template
# Unresolved template variables are replaced with "NOT_DEFINED" - treat as empty
static_ip="{{ static_ip }}"
static_ip6="{{ static_ip6 }}"
static_gw="{{ static_gw }}"
static_gw6="{{ static_gw6 }}"
bridge="{{ bridge }}"
nameserver4="{{ nameserver4 }}"
nameserver6="{{ nameserver6 }}"
[ "$static_ip" = "NOT_DEFINED" ] && static_ip=""
[ "$static_ip6" = "NOT_DEFINED" ] && static_ip6=""
[ "$static_gw" = "NOT_DEFINED" ] && static_gw=""
[ "$static_gw6" = "NOT_DEFINED" ] && static_gw6=""
[ "$bridge" = "NOT_DEFINED" ] && bridge=""
[ "$nameserver4" = "NOT_DEFINED" ] && nameserver4=""
[ "$nameserver6" = "NOT_DEFINED" ] && nameserver6=""

# Nameserver-only mode: set DNS without changing network config
if [ -z "$static_ip" ] && [ -z "$static_ip6" ]; then
  if [ -n "$nameserver4" ] || [ -n "$nameserver6" ]; then
    nameservers=""
    [ -n "$nameserver4" ] && nameservers="$nameserver4"
    [ -n "$nameserver6" ] && nameservers="${nameservers:+$nameservers }$nameserver6"
    pct set {{ vm_id }} --nameserver "$nameservers" >&2
    echo "DNS nameserver set (no static IP): $nameservers" >&2
    output_result "skipped" ""
    exit 0
  fi
  echo "Static IP configuration not requested, skipping." >&2
  output_result "skipped" ""
  exit 0
fi

if [ -z "{{ vm_id }}" ]; then
  echo "No VMID provided!" >&2
  output_result "false" ""
  exit 2
fi

if [ -z "{{ hostname }}" ]; then
  echo "No hostname provided!" >&2
  output_result "false" ""
  exit 2
fi


ipv6_ok=true

is_valid_ipv4_cidr() {
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*/[0-9]*)
      ip_part=${1%/*}
      prefix=${1#*/}
      # Check prefix range 0-32
      if [ "$prefix" -ge 0 ] 2>/dev/null && [ "$prefix" -le 32 ] 2>/dev/null; then
        # Check each octet 0-255
        IFS='.' read o1 o2 o3 o4 <<EOF
$ip_part
EOF
        for o in "$o1" "$o2" "$o3" "$o4"; do
          case "$o" in
            ''|*[!0-9]) return 1 ;;
          esac
          if [ "$o" -lt 0 ] || [ "$o" -gt 255 ]; then return 1; fi
        done
        return 0
      fi
      return 1 ;;
    *) return 1 ;;
  esac
}

is_valid_ipv6_cidr() {
  case "$1" in
    */*)
      ip_part=${1%/*}
      prefix=${1#*/}
      # prefix 0-128
      if ! [ "$prefix" -ge 0 ] 2>/dev/null || ! [ "$prefix" -le 128 ] 2>/dev/null; then
        return 1
      fi
      # Rough IPv6 check: hex groups separated by ':' (allow :: abbreviation)
      case "$ip_part" in
        *::*) ;; # allow compressed
        *)
          IFS=':' read -r g1 g2 g3 g4 g5 g6 g7 g8 <<EOF
$ip_part
EOF
          ;;
      esac
      # Basic pattern: only hex digits and colons
      case "$ip_part" in
        *[!0-9a-fA-F:]* ) return 1 ;;
      esac
      return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "$static_ip" ]; then
  if ! is_valid_ipv4_cidr "$static_ip"; then
    echo "Invalid IPv4 CIDR: '$static_ip'. Expected format a.b.c.d/prefix (e.g. 192.168.1.10/24)." >&2
    output_result "false" ""
    exit 2
  fi
  ipv4_ok=true
else
  # If gateway is provided without IP, that's invalid
  if [ -n "$static_gw" ]; then
    echo "IPv4 gateway provided without IPv4 address!" >&2
    output_result "false" ""
    exit 2
  fi
  ipv4_ok=false
fi

if [ -n "$static_ip6" ]; then
  if ! is_valid_ipv6_cidr "$static_ip6"; then
    echo "Invalid IPv6 CIDR: '$static_ip6'. Expected format ip/prefix (e.g. fd00::10/64)." >&2
    output_result "false" ""
    exit 2
  fi
  ipv6_ok=true
else
  # If gateway is provided without IP, that's invalid
  if [ -n "$static_gw6" ]; then
    echo "IPv6 gateway provided without IPv6 address!" >&2
    output_result "false" ""
    exit 2
  fi
  ipv6_ok=false
fi

if [ "$ipv4_ok" = false ] && [ "$ipv6_ok" = false ]; then
  echo "No static IP (IPv4 or IPv6) provided!" >&2
  output_result "false" ""
  exit 2
fi

NET_OPTS="name=eth0,bridge=${bridge}"
if [ "$ipv4_ok" = true ]; then
  NET_OPTS="$NET_OPTS,ip=$static_ip"
  if [ -n "$static_gw" ]; then
    NET_OPTS="$NET_OPTS,gw=$static_gw"
  fi
fi
if [ "$ipv6_ok" = true ]; then
  NET_OPTS="$NET_OPTS,ip6=$static_ip6"
  if [ -n "$static_gw6" ]; then
    NET_OPTS="$NET_OPTS,gw6=$static_gw6"
  fi
fi

# Enable host-managed networking so Proxmox generates lxc.net.0.ipv4.address
# and lxc.net.0.flags=up in the LXC config. Without this, OCI containers
# (which lack an init system to configure networking) get no IP assigned.
NET_OPTS="$NET_OPTS,host-managed=1"
pct set {{ vm_id }} --net0 "$NET_OPTS" >&2
RC=$?
if [ $RC -ne 0 ]; then
  echo "Failed to set network configuration!" >&2
  output_result "false" ""
  exit $RC
fi

# Set DNS nameserver(s) if provided
nameservers=""
if [ -n "$nameserver4" ]; then
  nameservers="$nameserver4"
fi
if [ -n "$nameserver6" ]; then
  nameservers="${nameservers:+$nameservers }$nameserver6"
fi
if [ -n "$nameservers" ]; then
  pct set {{ vm_id }} --nameserver "$nameservers" >&2
  echo "DNS nameserver set: $nameservers" >&2
fi

echo "Network configuration updated for VM {{ vm_id }}." >&2
# Output the configured IP (use IPv4 if available, otherwise IPv6)
if [ "$ipv4_ok" = true ]; then
  output_result "true" "$static_ip"
else
  output_result "true" "$static_ip6"
fi
exit 0
