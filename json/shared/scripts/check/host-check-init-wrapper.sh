#!/bin/sh
# Check that the init wrapper (/usr/local/sbin/proxvex-init) took effect at
# runtime, not just that it was written.
#
# 109-host-install-init-wrapper writes the wrapper, conf-oci-lxc-configuration
# puts it in front of the container's init (lxc.init.cmd or `entrypoint:`).
# Both steps succeed even if the wrapper never runs — e.g. when no init
# command exists to prepend to. So read the live values back:
#   - the container config starts the wrapper,
#   - net.ipv4.ip_unprivileged_port_start equals unprivileged_port_start,
#   - every container_sysctls key has its value,
#   - eth0 carries ipv6_token (only if the image has iproute2's `ip`).
#
# Template variables:
#   vm_id, unprivileged_port_start, container_sysctls, ipv6_token
#
# Outputs JSON array; exit 1 on the first mismatch.

VM_ID="{{ vm_id }}"
PORT_START="{{ unprivileged_port_start }}"
SYSCTLS="{{ container_sysctls }}"
IPV6_TOKEN="{{ ipv6_token }}"
WRAPPER=/usr/local/sbin/proxvex-init

[ "$PORT_START" = "NOT_DEFINED" ] && PORT_START=""
[ "$SYSCTLS" = "NOT_DEFINED" ] && SYSCTLS=""
[ "$IPV6_TOKEN" = "NOT_DEFINED" ] && IPV6_TOKEN=""

# skip_if_all_missing does not help here: 107/109 declare these parameters,
# so they always count as "present" by the time checks run. Decide here.
if [ -z "$PORT_START" ] && [ -z "$IPV6_TOKEN" ] \
  && [ -z "$(printf '%s' "$SYSCTLS" | tr -d '[:space:]')" ]; then
  echo "CHECK: init_wrapper SKIPPED (no wrapper requested)" >&2
  printf '[{"id":"check_init_wrapper","value":"not requested"}]'
  exit 0
fi

fail() {
  echo "CHECK: init_wrapper FAILED — $1" >&2
  printf '[{"id":"check_init_wrapper","value":"failed"}]'
  exit 1
}

if ! grep -E "^(entrypoint|lxc\.init\.cmd):" "/etc/pve/lxc/${VM_ID}.conf" 2>/dev/null | grep -q "$WRAPPER"; then
  # 109 skips the wrapper when only the port setting was asked for and it is
  # not needed (root app) or not possible (no shell / no drop tool in the
  # image). Requested sysctls or a token, however, must be in effect.
  if [ -z "$IPV6_TOKEN" ] && [ -z "$(printf '%s' "$SYSCTLS" | tr -d '[:space:]')" ]; then
    echo "CHECK: init_wrapper PASSED (wrapper skipped: image without shell or without privilege-drop tool — port start left at kernel default)" >&2
    printf '[{"id":"check_init_wrapper","value":"not needed"}]'
    exit 0
  fi
  fail "container init does not start $WRAPPER although container_sysctls/ipv6_token are set ($(grep -E '^(entrypoint|lxc\.init\.cmd):' "/etc/pve/lxc/${VM_ID}.conf" 2>/dev/null))"
fi
echo "Container init starts $WRAPPER" >&2

# With `--as UID:...` the wrapper starts as root and must drop to the image's
# user before exec — the app must never stay root. The uid inside the
# container's user namespace is what /proc/1/status reports via pct exec.
as_uid=$(grep -E "^(entrypoint|lxc\.init\.cmd):" "/etc/pve/lxc/${VM_ID}.conf" \
  | sed -n "s|.*$WRAPPER --as \([0-9][0-9]*\):.*|\1|p" | head -1)
if [ -n "$as_uid" ]; then
  pid1_uid=$(pct exec "$VM_ID" -- awk '/^Uid:/ {print $2}' /proc/1/status 2>/dev/null)
  [ "$pid1_uid" = "$as_uid" ] || fail "PID 1 runs as uid '$pid1_uid', expected $as_uid (privilege drop did not happen)"
  echo "PID 1 dropped to uid $pid1_uid" >&2
fi

# read_sysctl <dotted key> → value inside the container's namespaces
read_sysctl() {
  pct exec "$VM_ID" -- cat "/proc/sys/$(printf '%s' "$1" | tr '.' '/')" 2>/dev/null
}

if [ -n "$PORT_START" ]; then
  got=$(read_sysctl net.ipv4.ip_unprivileged_port_start)
  [ "$got" = "$PORT_START" ] || fail "net.ipv4.ip_unprivileged_port_start is '$got', expected $PORT_START"
  echo "net.ipv4.ip_unprivileged_port_start=$got" >&2
fi

# Prints the first mismatch (empty when all match); logs matches to stderr.
first_sysctl_mismatch() {
  printf '%s\n' "$SYSCTLS" | while IFS= read -r entry; do
    entry=$(printf '%s' "$entry" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$entry" in ''|'#'*) continue ;; esac
    key=$(printf '%s' "${entry%%=*}" | sed 's/[[:space:]]*$//')
    want=$(printf '%s' "${entry#*=}" | sed 's/^[[:space:]]*//')
    got=$(read_sysctl "$key")
    if [ "$got" = "$want" ]; then
      echo "$key=$got" >&2
    else
      echo "$key is '$got', expected $want"
      break
    fi
  done
}

if [ -n "$SYSCTLS" ]; then
  mismatch=$(first_sysctl_mismatch)
  [ -z "$mismatch" ] || fail "$mismatch"
fi

if [ -n "$IPV6_TOKEN" ]; then
  # Needs iproute2 in the image; busybox `ip` has no token subcommand, and
  # then the wrapper could not have set it either.
  token=$(pct exec "$VM_ID" -- ip token get dev eth0 2>/dev/null)
  case "$token" in
    "token $IPV6_TOKEN dev eth0"*) echo "eth0 IPv6 token $IPV6_TOKEN" >&2 ;;
    *) fail "eth0 IPv6 token is '$token', expected $IPV6_TOKEN (image needs iproute2)" ;;
  esac
fi

echo "CHECK: init_wrapper PASSED" >&2
printf '[{"id":"check_init_wrapper","value":"ok"}]'
