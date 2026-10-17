#!/bin/sh
# Confirm the WireGuard data plane inside the wg-easy container.
#
# Runs on the PVE host. Three things must hold for road-warrior clients to
# reach the LAN:
#   1. the wireguard module is loaded on the host (an unprivileged container
#      cannot load it; 096-host-load-kernel-modules does),
#   2. net.ipv4.ip_forward=1 in the container's netns (set by the init
#      wrapper /usr/local/sbin/proxvex-init from container_sysctls),
#   3. wg-easy created the wg0 interface.
# wg0 appears a few seconds after node starts, so it is polled.
# Then the web UI: the SSL addon's nginx must answer HTTPS on
# local_https_port, and the plain-HTTP app port must be blocked from outside
# (wg-easy refuses logins over HTTP anyway, INSECURE=false).
#
# Template variables:
#   vm_id            - Container VM ID
#   local_https_port - HTTPS port of the nginx proxy
#   http_port        - wg-easy's own HTTP port (must not be reachable)
#   ipv6_token       - expected IPv6 interface ID on eth0 (optional)
#
# stdout: JSON array (schemas/outputs.schema.json). All logs go to stderr.
set -u

VM_ID="{{ vm_id }}"
HTTPS_PORT="{{ local_https_port }}"
HTTP_PORT="{{ http_port }}"
IPV6_TOKEN="{{ ipv6_token }}"
[ "$IPV6_TOKEN" = "NOT_DEFINED" ] && IPV6_TOKEN=""
ATTEMPTS=12
SLEEP=5

fail() {
  echo "CHECK: wireguard_interface_up FAILED — $1" >&2
  printf '[{"id":"wireguard_interface_up","value":"false"}]'
  exit 1
}

if ! lsmod | grep -q "^wireguard "; then
  fail "kernel module 'wireguard' is not loaded on the host"
fi
echo "Host: wireguard module loaded" >&2

forward=$(pct exec "$VM_ID" -- cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)
if [ "$forward" != "1" ]; then
  fail "net.ipv4.ip_forward is '$forward' inside the container (init wrapper not applied?)"
fi
echo "Container: net.ipv4.ip_forward=1" >&2

# The token only turns into <prefix>::<token> once a router advertisement
# arrives (none in the nested test VM) — but the kernel must have accepted it,
# which it refuses while eth0 ignores RAs (forwarding=1 without accept_ra=2).
if [ -n "$IPV6_TOKEN" ]; then
  token=$(pct exec "$VM_ID" -- ip token get dev eth0 2>/dev/null)
  case "$token" in
    "token $IPV6_TOKEN dev eth0"*) echo "Container: IPv6 token $IPV6_TOKEN on eth0" >&2 ;;
    *) fail "IPv6 token not applied on eth0 (got '$token', expected $IPV6_TOKEN)" ;;
  esac
  ra=$(pct exec "$VM_ID" -- cat /proc/sys/net/ipv6/conf/eth0/accept_ra 2>/dev/null)
  [ "$ra" = "2" ] || fail "net.ipv6.conf.eth0.accept_ra is '$ra' (forwarding=1 needs 2 to keep SLAAC)"
  echo "Container: accept_ra=2 on eth0 (SLAAC kept despite forwarding)" >&2
fi

i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  if out=$(pct exec "$VM_ID" -- wg show wg0 2>/dev/null) && [ -n "$out" ]; then
    echo "Container: wg0 is up" >&2
    printf '%s\n' "$out" | grep -v "private key" | sed 's/^/  /' >&2
    break
  fi
  i=$((i + 1))
  echo "wg0 not up yet (attempt $i/$ATTEMPTS), waiting ${SLEEP}s..." >&2
  sleep "$SLEEP"
done

if [ "$i" -ge "$ATTEMPTS" ]; then
  echo "ip link inside the container:" >&2
  pct exec "$VM_ID" -- ip -brief link >&2 || true
  fail "wg0 did not come up within $((ATTEMPTS * SLEEP))s"
fi

IP=$(pct exec "$VM_ID" -- ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$IP" ] || fail "cannot determine the container's IPv4 address"

code=000
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  code=$(curl -sk -m 5 -o /dev/null -w '%{http_code}' "https://${IP}:${HTTPS_PORT}/" 2>/dev/null)
  case "$code" in 2??|3??) break ;; esac
  i=$((i + 1))
  echo "web UI not answering on https://${IP}:${HTTPS_PORT}/ yet (HTTP $code, attempt $i/$ATTEMPTS)" >&2
  sleep "$SLEEP"
done
case "$code" in
  2??|3??) echo "Web UI: https://${IP}:${HTTPS_PORT}/ -> HTTP $code" >&2 ;;
  *) fail "web UI did not answer on https://${IP}:${HTTPS_PORT}/ (last HTTP $code)" ;;
esac

if curl -s -m 3 -o /dev/null "http://${IP}:${HTTP_PORT}/" 2>/dev/null; then
  fail "plain HTTP port ${HTTP_PORT} is reachable from outside (SSL proxy iptables rule missing)"
fi
echo "Web UI: plain HTTP port ${HTTP_PORT} blocked from outside" >&2

# Same over IPv6. The test network has no global IPv6, but every container
# has a link-local address on its bridge — enough to prove nginx listens on
# [::] and that ip6tables blocks the plain-HTTP port.
LL=$(pct exec "$VM_ID" -- awk '$6 == "eth0" && $1 ~ /^fe80/ {print $1; exit}' /proc/net/if_inet6 2>/dev/null \
  | python3 -c 'import ipaddress,sys; h=sys.stdin.read().strip(); print(ipaddress.IPv6Address(int(h,16)) if h else "")')
BR=$(pct config "$VM_ID" | sed -n 's/^net0:.*bridge=\([^,]*\).*/\1/p')
BR_V6_OFF=$(cat "/proc/sys/net/ipv6/conf/${BR}/disable_ipv6" 2>/dev/null)
if [ "$BR_V6_OFF" = "1" ]; then
  echo "Warning: IPv6 is disabled on host bridge ${BR} — IPv6 UI checks skipped" >&2
elif [ -n "$LL" ] && [ -n "$BR" ]; then
  code6=$(curl -sk -m 5 --interface "$BR" -o /dev/null -w '%{http_code}' "https://[${LL}%25${BR}]:${HTTPS_PORT}/" 2>/dev/null)
  case "$code6" in
    2??|3??) echo "Web UI: https://[${LL}%${BR}]:${HTTPS_PORT}/ -> HTTP $code6 (IPv6)" >&2 ;;
    *)
      echo "--- IPv6 diagnostics ---" >&2
      echo "target: https://[${LL}%${BR}]:${HTTPS_PORT}/" >&2
      pct exec "$VM_ID" -- sh -c 'netstat -lnt 2>/dev/null | grep ":443 "; grep -h listen /etc/nginx/http.d/ssl-proxy.conf /etc/nginx/conf.d/ssl-proxy.conf 2>/dev/null; ip6tables -S INPUT 2>/dev/null' >&2
      ip -6 addr show dev "$BR" scope link >&2
      curl -skv -m 5 --interface "$BR" -o /dev/null "https://[${LL}%25${BR}]:${HTTPS_PORT}/" 2>/tmp/wg-curl6.err
      tail -5 /tmp/wg-curl6.err >&2
      fail "web UI not reachable over IPv6 link-local (HTTP $code6)"
      ;;
  esac
  if curl -s -m 3 --interface "$BR" -o /dev/null "http://[${LL}%25${BR}]:${HTTP_PORT}/" 2>/dev/null; then
    fail "plain HTTP port ${HTTP_PORT} is reachable over IPv6 (ip6tables rule missing)"
  fi
  echo "Web UI: plain HTTP port ${HTTP_PORT} blocked over IPv6" >&2
else
  echo "Warning: no IPv6 link-local address/bridge found — IPv6 UI checks skipped" >&2
fi

echo "CHECK: wireguard_interface_up PASSED (wg0, forwarding, HTTPS UI)" >&2
printf '[{"id":"wireguard_interface_up","value":"true"}]'
