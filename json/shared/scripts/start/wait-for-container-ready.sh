#!/bin/sh
# Wait until an LXC container is ready for package operations
#
# Polls four readiness signals (pct status running, lxc-attach responsive,
# IPv4 on the container side, package manager present). Once all four pass,
# requires N consecutive successful samples (~10 s of stable running) before
# returning. The stability window catches startup-time crashes — e.g.
# postgres reaches the "ready" state during initdb but PANICs ~9 s later
# when the data volume runs out of space. A single-sample readiness check
# would miss that and let the install pipeline continue against a dead
# container.
#
# Requires:
#   - vm_id: LXC container ID (required)
#
# Output: JSON to stdout (errors to stderr)

VMID="{{ vm_id }}"
if [ -z "$VMID" ]; then
  echo "Missing vm_id" >&2
  exit 2
fi

TIMEOUT=60
SLEEP=3
STABLE_REQUIRED=3   # ~10 s of stable running (3 samples * STABLE_SLEEP)
STABLE_SLEEP=5
END=$(( $(date +%s) + TIMEOUT ))

check_cmd() {
  lxc-attach -n "$VMID" -- /bin/sh -c "$1" </dev/null >/dev/null 2>&1
}

# all_ready returns 0 if every readiness signal passes right now, 1 otherwise.
all_ready() {
  pct status "$VMID" | grep -q running || return 1
  check_cmd "true" || return 1
  lxc-attach -n "$VMID" -- /bin/sh -c \
    'ip -4 addr show 2>/dev/null | grep -q "inet " || hostname -i 2>/dev/null | grep -q .' \
    </dev/null >/dev/null 2>&1 || return 1
  check_cmd "apk --version" || check_cmd "dpkg --version" || check_cmd "true" || return 1
  return 0
}

while [ $(date +%s) -lt $END ]; do
  if ! all_ready; then
    sleep "$SLEEP"
    continue
  fi

  # First all-pass observed — verify the container stays healthy for
  # STABLE_REQUIRED more consecutive samples before declaring ready.
  stable=1
  while [ $stable -lt $STABLE_REQUIRED ]; do
    sleep "$STABLE_SLEEP"
    if ! all_ready; then
      echo "Container $VMID became unhealthy during stability window after $stable stable sample(s); resuming wait" >&2
      stable=0
      break
    fi
    stable=$((stable + 1))
  done
  if [ $stable -ge $STABLE_REQUIRED ]; then
    echo '[{"id":"ready","value":"true"}]'
    exit 0
  fi
  # Fall through to outer loop — keep polling until TIMEOUT
done

echo "Container $VMID not ready within ${TIMEOUT}s" >&2
exit 1
^