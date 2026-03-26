#!/bin/sh
# Wait until an LXC container is ready for package operations
#
# This script waits for a container to be ready by:
# 1. Polling lxc-attach for simple commands until success or timeout
# 2. Checking hostname resolution
# 3. Checking network connectivity
# 4. Checking package manager availability (apk for Alpine, apt for Debian/Ubuntu)
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
END=$(( $(date +%s) + TIMEOUT ))

check_cmd() {
  lxc-attach -n "$VMID" -- /bin/sh -c "$1" </dev/null >/dev/null 2>&1
}

while [ $(date +%s) -lt $END ]; do
  # Basic process up?
  if ! pct status "$VMID" | grep -q running; then
    sleep "$SLEEP"
    continue
  fi
  # Responds to attach?
  if ! check_cmd "true"; then
    sleep "$SLEEP"
    continue
  fi
  # Has network? Check for any IPv4 address on eth0 (avoids hostname -i blocking on DHCPv6)
  if ! lxc-attach -n "$VMID" -- /bin/sh -c 'ip -4 addr show 2>/dev/null | grep -q "inet " || hostname -i 2>/dev/null | grep -q .' </dev/null >/dev/null 2>&1; then
    sleep "$SLEEP"
    continue
  fi
  # Package manager available? Support Alpine (apk), Debian/Ubuntu (dpkg), or any OCI image (true)
  if check_cmd "apk --version" || check_cmd "dpkg --version" || check_cmd "true"; then
    echo '[{"id":"ready","value":"true"}]'
    exit 0
  fi
  sleep "$SLEEP"
done

echo "Container $VMID not ready within ${TIMEOUT}s" >&2
exit 1
^