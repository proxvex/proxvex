#!/bin/sh
# Check IPv6 inside a docker-compose LXC (docker_ipv6, post-start-dockerd.sh).
#
# Runs on the PVE host. Verifies what IPv6 for Docker promises, end to end:
#   1. dockerd runs with IPv6 (daemon.json "ipv6": true),
#   2. the LXC kept its own SLAAC address although dockerd enabled
#      forwarding (eth0 accept_ra=2 and a non-link-local address),
#   3. every Docker container that is not on the host network has an IPv6
#      address,
#   4. every published TCP port answers on the LXC's IPv6 address
#      (ip6tables DNAT with userland-proxy off).
# Skipped when docker_ipv6 is off or the LXC has no IPv6 at all.
#
# Template variables:
#   vm_id       - Container VM ID
#   docker_ipv6 - "false" switches Docker IPv6 off (default on)
#
# stdout: JSON array. Logs to stderr. Exit 1 on the first failed point.

VM_ID="{{ vm_id }}"
DOCKER_IPV6="{{ docker_ipv6 }}"

out() { printf '[{"id":"check_docker_ipv6","value":"%s"}]' "$1"; }
fail() {
  echo "CHECK: docker_ipv6 FAILED — $1" >&2
  out "failed"
  exit 1
}

case "$DOCKER_IPV6" in
  false|0|no)
    echo "CHECK: docker_ipv6 SKIPPED (docker_ipv6=false)" >&2
    out "skipped"
    exit 0
    ;;
esac

if ! pct exec "$VM_ID" -- sh -c 'command -v docker' >/dev/null 2>/dev/null; then
  echo "CHECK: docker_ipv6 SKIPPED (no docker in container)" >&2
  out "skipped"
  exit 0
fi

# Global/ULA address on eth0 (not link-local), compressed form.
lxc_addr=$(pct exec "$VM_ID" -- cat /proc/net/if_inet6 2>/dev/null \
  | awk '$6 == "eth0" && $1 !~ /^fe80/ {print $1}' \
  | python3 -c 'import ipaddress,sys
addrs=[ipaddress.IPv6Address(int(l.strip(),16)) for l in sys.stdin if l.strip()]
ula=[a for a in addrs if a.is_private]
print((ula or addrs or [""])[0])')

if [ -z "$(pct exec "$VM_ID" -- cat /proc/net/if_inet6 2>/dev/null | awk '$6 == "eth0"')" ]; then
  echo "CHECK: docker_ipv6 SKIPPED (LXC has no IPv6)" >&2
  out "skipped"
  exit 0
fi

# 1. daemon.json
if ! pct exec "$VM_ID" -- grep -q '"ipv6": true' /etc/docker/daemon.json 2>/dev/null; then
  fail "/etc/docker/daemon.json has no \"ipv6\": true"
fi
echo "dockerd: ipv6 enabled in daemon.json" >&2

# 2. SLAAC kept on the LXC
ra=$(pct exec "$VM_ID" -- cat /proc/sys/net/ipv6/conf/eth0/accept_ra 2>/dev/null)
[ "$ra" = "2" ] || fail "eth0 accept_ra is '$ra', expected 2 (forwarding would drop SLAAC)"
[ -n "$lxc_addr" ] || fail "LXC eth0 has no global/ULA IPv6 address (SLAAC lost?)"
echo "LXC: eth0 $lxc_addr, accept_ra=2" >&2

# 3. Docker containers have IPv6. Go-template braces built at runtime so the
# deployer's {{ }} substitution leaves them alone.
LB='{''{'
RB='}''}'
fmt="${LB}.Name${RB} ${LB}.HostConfig.NetworkMode${RB} ${LB}range .NetworkSettings.Networks${RB}${LB}.GlobalIPv6Address${RB},${LB}end${RB}"
ids=$(pct exec "$VM_ID" -- docker ps -q 2>/dev/null)
[ -n "$ids" ] || fail "no running docker containers"
missing=""
for id in $ids; do
  line=$(pct exec "$VM_ID" -- docker inspect --format "$fmt" "$id" 2>/dev/null)
  name=$(echo "$line" | awk '{print $1}' | sed 's|^/||')
  mode=$(echo "$line" | awk '{print $2}')
  v6=$(echo "$line" | awk '{print $3}' | tr ',' ' ' | awk '{print $1}')
  if [ "$mode" = "host" ]; then
    echo "  $name: host network (uses the LXC's IPv6 directly)" >&2
  elif [ -n "$v6" ]; then
    echo "  $name: $v6" >&2
  else
    missing="$missing $name"
  fi
done
[ -z "$missing" ] || fail "containers without IPv6:$missing (network created before IPv6 was enabled?)"

# 4. Published TCP ports over the LXC's IPv6 address
lxc_v4=$(lxc-info -n "$VM_ID" -iH 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^172\.' | head -1)
ports=$(pct exec "$VM_ID" -- docker ps --format "${LB}.Ports${RB}" 2>/dev/null \
  | tr ',' '\n' | sed -n 's/.*:\([0-9][0-9]*\)->[0-9]*\/tcp.*/\1/p' | sort -un)
for p in $ports; do
  if python3 -c 'import socket,sys
s=socket.socket(socket.AF_INET6); s.settimeout(5)
s.connect((sys.argv[1], int(sys.argv[2])))' "$lxc_addr" "$p" 2>/dev/null; then
    echo "  published port $p reachable on [$lxc_addr]" >&2
    # IPv4 must keep working (an app switched to an IPv6 socket must stay dual stack).
    if [ -n "$lxc_v4" ] && ! python3 -c 'import socket,sys
s=socket.socket(); s.settimeout(5)
s.connect((sys.argv[1], int(sys.argv[2])))' "$lxc_v4" "$p" 2>/dev/null; then
      fail "published port $p answers over IPv6 but not on $lxc_v4 (IPv4)"
    fi
    [ -n "$lxc_v4" ] && echo "  published port $p reachable on $lxc_v4" >&2
  else
    echo "--- diagnostics for port $p ---" >&2
    pct exec "$VM_ID" -- docker ps --format "${LB}.Names${RB} ${LB}.Ports${RB}" >&2
    pct exec "$VM_ID" -- ip6tables -t nat -S DOCKER 2>/dev/null | grep DNAT >&2
    # Listeners via the container's /proc (distroless images have no cat).
    for id in $ids; do
      cpid=$(pct exec "$VM_ID" -- docker inspect -f "${LB}.State.Pid${RB}" "$id" 2>/dev/null)
      echo "  listeners in $id (pid $cpid): tcp6=$(pct exec "$VM_ID" -- awk 'NR>1 && $4=="0A" {printf "%s ", $2}' "/proc/$cpid/net/tcp6" 2>/dev/null) tcp4=$(pct exec "$VM_ID" -- awk 'NR>1 && $4=="0A" {printf "%s ", $2}' "/proc/$cpid/net/tcp" 2>/dev/null)" >&2
    done
    fail "published port $p not reachable on [$lxc_addr]:$p over IPv6"
  fi
done

echo "CHECK: docker_ipv6 PASSED" >&2
out "ok"
