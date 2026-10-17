#!/bin/sh
# Check a static IPv6 address (static_ip6) on the container.
#
# Runs on the PVE host. When static_ip6 is set, the address must be on eth0
# inside the container and answer a ping from the host. Typical use: a fixed
# ULA (fd29:cd10:9a98::41/64) for a static app, so DNS AAAA records and
# firewall rules can point at it — the SLAAC address follows the MAC, which
# changes on every upgrade. No-op when static_ip6 is empty.
#
# Template variables:
#   vm_id      - Container VM ID
#   static_ip6 - Expected address with prefix length, e.g. fd00:e2e::41/64
#
# stdout: JSON array. Logs to stderr.

VM_ID="{{ vm_id }}"
STATIC_IP6="{{ static_ip6 }}"

out() { printf '[{"id":"check_static_ipv6","value":"%s"}]' "$1"; }

case "$STATIC_IP6" in
  ""|NOT_DEFINED)
    echo "CHECK: static_ipv6 SKIPPED (static_ip6 not set)" >&2
    out "skipped"
    exit 0
    ;;
esac

addr=${STATIC_IP6%/*}
want=$(python3 -c 'import ipaddress,sys; print(ipaddress.IPv6Address(sys.argv[1]).exploded.replace(":",""))' "$addr" 2>/dev/null)
if [ -z "$want" ]; then
  echo "CHECK: static_ipv6 FAILED — '$STATIC_IP6' is not an IPv6 address" >&2
  out "failed"
  exit 1
fi

if ! pct exec "$VM_ID" -- awk -v w="$want" '$1 == w && $6 == "eth0" {f=1} END {exit !f}' /proc/net/if_inet6 2>/dev/null; then
  echo "CHECK: static_ipv6 FAILED — $addr not on eth0 of $VM_ID" >&2
  pct exec "$VM_ID" -- awk '$6 == "eth0" {print "  have:", $1}' /proc/net/if_inet6 >&2
  out "failed"
  exit 1
fi
echo "Container: $addr on eth0" >&2

i=0
while [ "$i" -lt 5 ]; do
  if ping -6 -c1 -W2 "$addr" >/dev/null 2>/dev/null; then
    echo "CHECK: static_ipv6 PASSED ($addr reachable from host)" >&2
    out "ok"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
echo "CHECK: static_ipv6 FAILED — $addr on eth0 but not reachable from the host" >&2
out "failed"
exit 1
