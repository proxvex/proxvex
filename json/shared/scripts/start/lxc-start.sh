#!/bin/sh
# Start LXC container on Proxmox host
#
# This script starts an LXC container by:
# 1. Checking if container exists
# 2. Starting the container if it's not already running
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

# Check container status first
CONTAINER_STATUS=$(pct status "$VMID" 2>/dev/null | grep -o "status: [a-z]*" | cut -d' ' -f2 || echo "unknown")
echo "Container $VMID current status: $CONTAINER_STATUS" >&2

# If container doesn't exist or is in a bad state, provide diagnostic info
if [ "$CONTAINER_STATUS" = "unknown" ] || [ -z "$CONTAINER_STATUS" ]; then
  echo "Error: Container $VMID does not exist or cannot be accessed" >&2
  echo "Diagnostic information:" >&2
  pct list 2>&1 | grep -E "(VMID|$VMID)" >&2 || echo "No containers found" >&2
  exit 1
fi

# If container is already running, exit successfully
if [ "$CONTAINER_STATUS" = "running" ]; then
  echo "Container $VMID is already running" >&2
  echo '[{"id":"started","value":"true"}]'
  exit 0
fi

# Truncate LXC console log before start (ensures clean hookscript markers)
HOSTNAME_FOR_LOG=$(pct config "$VMID" 2>/dev/null | awk '/^hostname:/{print $2}')
if [ -n "$HOSTNAME_FOR_LOG" ]; then
  LOG_PATH="/var/log/lxc/${HOSTNAME_FOR_LOG}-${VMID}.log"
  : > "$LOG_PATH" 2>/dev/null || true
fi

# Try to start the container
echo "Attempting to start container $VMID..." >&2
if ! pct start "$VMID" >/dev/null 2>&1; then
  START_ERROR=$(pct start "$VMID" 2>&1)
  echo "" >&2
  echo "=== Container $VMID failed to start ===" >&2
  echo "$START_ERROR" >&2

  # Show application log if available — often more useful than the config
  LOG_PATH=$(pct config "$VMID" 2>/dev/null | grep "^lxc.console.logfile:" | awk '{print $2}')
  if [ -n "$LOG_PATH" ] && [ -f "$LOG_PATH" ]; then
    echo "" >&2
    echo "=== Application log (last 30 lines) ===" >&2
    tail -30 "$LOG_PATH" >&2
  fi

  echo "" >&2
  echo "=== Container configuration ===" >&2
  pct config "$VMID" >&2 || echo "Could not read container configuration" >&2
  exit 1
fi

# Brief wait, then check if container is still running.
# Some containers start successfully but crash immediately
# (e.g. missing config files, bad environment variables).
sleep 3
POST_STATUS=$(pct status "$VMID" 2>/dev/null | grep -o "status: [a-z]*" | cut -d' ' -f2 || echo "unknown")

if [ "$POST_STATUS" != "running" ]; then
  echo "" >&2
  echo "=== Container $VMID started but exited immediately ===" >&2
  echo "The application inside the container crashed on startup." >&2
  echo "Check the log below for details (e.g. missing files, invalid configuration)." >&2

  # Show console log — this contains the application's error output
  LOG_PATH=$(pct config "$VMID" 2>/dev/null | grep "^lxc.console.logfile:" | awk '{print $2}')
  if [ -n "$LOG_PATH" ] && [ -f "$LOG_PATH" ]; then
    echo "" >&2
    echo "=== Application log (last 30 lines) ===" >&2
    tail -30 "$LOG_PATH" >&2
  fi

  # Show log viewer URL from notes if available
  LOG_URL=$(pct config "$VMID" 2>/dev/null | grep -o 'oci-lxc-deployer[:%]3[Aa]log-url [^ ]*' | head -1 | sed 's/.*log-url //')
  if [ -n "$LOG_URL" ]; then
    echo "" >&2
    echo "Full log: $LOG_URL" >&2
  fi

  exit 1
fi

exit 0