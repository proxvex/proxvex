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
PREV_VMID="{{ previous_vm_id }}"
if [ -z "$VMID" ]; then
  echo "Missing vm_id" >&2
  exit 2
fi

# ─── Self-upgrade fast path ───────────────────────────────────────────────────
# When the previous container is the proxvex deployer itself, OLD and NEW
# share static IP + MAC. Keeping both running through the post_start/check/
# replace_ct phases causes bridge-FDB flapping that breaks the orchestrator's
# SSH session back to PVE. Solution: do an atomic start-NEW + stop-OLD here,
# then exit signalling switchover_scheduled so the orchestrator marks all
# remaining steps as completed without trying to execute them.
#
# Tradeoff: we lose live validation of NEW before committing — if NEW boots
# but is broken, OLD has already been told to stop. The recovery procedure
# is in the failure log below.
if [ -n "$PREV_VMID" ] && [ "$PREV_VMID" != "NOT_DEFINED" ] && [ "$PREV_VMID" != "$VMID" ] \
   && pct config "$PREV_VMID" 2>/dev/null | grep -qa "deployer-instance"; then
  echo "=== Self-upgrade detected: $PREV_VMID (old) -> $VMID (new) ===" >&2

  # Drop the post-upgrade marker on NEW's /config so that NEW's
  # finalizeUpgradeIfPending picks up after first boot (unlinks OLD's managed
  # volumes, re-applies lock). The existing finalizer tolerates "OLD already
  # stopped" — see host-stop-and-unlink-previous-deployer.sh:36-42.
  NEW_CONFIG_VOLID=$(pct config "$VMID" 2>/dev/null \
    | grep -aE '^mp[0-9]+:.*[ ,]mp=/config([, ]|$)' \
    | head -1 | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/' || true)
  CONFIG_PATH=""
  if [ -n "$NEW_CONFIG_VOLID" ]; then
    CONFIG_PATH=$(pvesm path "$NEW_CONFIG_VOLID" 2>/dev/null || true)
  fi
  if [ -n "$CONFIG_PATH" ] && [ -d "$CONFIG_PATH" ]; then
    NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    cat > "${CONFIG_PATH}/.pending-post-upgrade.json" <<EOF
{
  "previous_vmid": "${PREV_VMID}",
  "new_vmid": "${VMID}",
  "upgraded_at": "${NOW_UTC}"
}
EOF
    echo "Wrote post-upgrade marker: ${CONFIG_PATH}/.pending-post-upgrade.json" >&2
  else
    echo "Warning: could not resolve NEW's /config path (volid=$NEW_CONFIG_VOLID path=$CONFIG_PATH) — finalizer will not run on $VMID's boot; manual cleanup of $PREV_VMID's managed volumes will be needed" >&2
  fi

  # Mark OLD as replaced (onboot=0 + lock=migrate) BEFORE starting NEW so
  # that even if something goes wrong, OLD won't auto-restart on next host
  # boot and stomp on NEW's IP again.
  pct set "$PREV_VMID" --onboot 0 >&2 2>/dev/null || true
  pct set "$PREV_VMID" --lock migrate >&2 2>/dev/null || true

  # Start NEW.
  echo "Starting $VMID..." >&2
  if ! pct start "$VMID" >&2 2>&1; then
    echo "" >&2
    echo "=== Self-upgrade ABORTED: pct start $VMID failed ===" >&2
    echo "Recovery: $PREV_VMID is still running (we only marked it lock=migrate" >&2
    echo "and onboot=0; nothing was stopped yet). To resume serving from OLD:" >&2
    echo "  pct unlock $PREV_VMID" >&2
    echo "  pct set $PREV_VMID --onboot 1" >&2
    echo "Then investigate why $VMID fails to start (often: storage full," >&2
    echo "missing volume mounts, or cgroup limits). pct config $VMID and the" >&2
    echo "console log under /var/log/lxc/ are the starting points." >&2
    exit 1
  fi

  # Health gate: NEW must still be running after 5s. Catches kernel-level
  # crashes during boot (duplicate MAC, missing rootfs, OOM). Does NOT catch
  # application-level breakage that surfaces minutes later.
  sleep 5
  POST_STATUS=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
  if [ "$POST_STATUS" != "running" ]; then
    echo "" >&2
    echo "=== Self-upgrade ABORTED: $VMID crashed during boot (status=$POST_STATUS) ===" >&2
    echo "Recovery: $PREV_VMID is still running. To resume serving from OLD:" >&2
    echo "  pct unlock $PREV_VMID" >&2
    echo "  pct set $PREV_VMID --onboot 1" >&2
    echo "Then check $VMID's console log under /var/log/lxc/ for the crash cause." >&2
    exit 1
  fi

  # Marker: container is up. Tells the backend to start tailing the
  # application logs (LXC console log + docker compose) into the diagnosis
  # timeline. Must go to stderr — stdout is JSON-only.
  echo "PROXVEX_PCT_START_EXECUTED vmid=$VMID" >&2

  # This is the commit point of a self-upgrade: replace-ct.sh does not run,
  # so the unfinished-rebuild tag from create-ct-clone.sh is cleared here.
  vol_rebuild_tag_clear "$VMID" || echo "Warning: could not clear rebuild tag on $VMID" >&2

  # Stop OLD detached. Stopping OLD severs this script's SSH session — `setsid`
  # puts pct stop in its own session so it survives the SIGHUP that follows.
  # We log to a file on the host because stderr/stdout get torn down with
  # the SSH connection.
  #
  # Switchover-result race: this script runs over an SSH session whose client
  # lives inside OLD (the orchestrator's own container). It exits 0 with the
  # `switchover_scheduled` JSON on stdout; ve-execution.mts:790 then marks the
  # remaining steps complete and ends the task cleanly. But if OLD halts
  # before that result is delivered over SSH, the orchestrator's ssh client is
  # killed mid-read → the command looks like exit 255 → ve-execution's error
  # path runs instead of the switchover short-circuit → the task wrongly
  # reports "Failed" (observed for the reconfigure phase, which lost this
  # race where upgrade usually won it). Deferring the OLD-stop by a few
  # seconds gives the result a deterministic window to propagate before OLD
  # goes down — NEW is already running and OLD is already onboot=0/lock=migrate,
  # so this brief extra dual-run is within the existing tradeoff window.
  STOP_LOG="/var/log/proxvex-self-upgrade-${PREV_VMID}-to-${VMID}.log"
  echo "Stopping $PREV_VMID (detached, +10s delay so the switchover result reaches the orchestrator first, log: $STOP_LOG)..." >&2
  # `pct stop` does not accept --timeout on this PVE (`pct stop` is the
  # forceful path; only `pct shutdown` carries the timeout knob). Use
  # `shutdown --timeout N --forceStop 1` (graceful with SIGKILL fallback
  # after the timeout) with `pct stop` as a last-resort.
  setsid sh -c "echo '=== $(date -u +%FT%TZ) scheduled stop of $PREV_VMID for upgrade to $VMID (10s delay) ===' > '$STOP_LOG'; sleep 10; (pct shutdown '$PREV_VMID' --timeout 90 --forceStop 1 || pct stop '$PREV_VMID') >> '$STOP_LOG' 2>&1; echo '=== $(date -u +%FT%TZ) pct shutdown/stop exit=$?' >> '$STOP_LOG'" </dev/null >/dev/null 2>&1 &

  echo "" >&2
  echo "=== Self-upgrade switchover initiated ===" >&2
  echo "  NEW: $VMID running, will own the static IP once OLD finishes stopping" >&2
  echo "  OLD: $PREV_VMID being stopped (graceful, 90s timeout) — see $STOP_LOG on the PVE host" >&2
  echo "  finalizer on $VMID's first boot will unlink OLD's managed volumes" >&2
  echo "If $VMID fails after this point, the recovery procedure is:" >&2
  echo "  ssh root@<pve> 'pct start $PREV_VMID; pct unlock $PREV_VMID; pct set $PREV_VMID --onboot 1'" >&2
  echo "  (OLD's rootfs is intact; managed volumes only get unlinked if NEW boots and runs finalizeUpgradeIfPending)" >&2

  # switchover_scheduled tells the orchestrator (ve-execution.mts:776) to
  # mark all remaining commands as successfully completed without executing
  # them. Without this, the orchestrator would try to run post_start/check/
  # replace_ct via SSH back to OLD — which is about to die.
  printf '[{"id":"started","value":"true"},{"id":"switchover_scheduled","value":"true"}]'
  exit 0
fi

# ─── Regular (non-self-upgrade) path ──────────────────────────────────────────

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
  echo "PROXVEX_PCT_START_EXECUTED vmid=$VMID" >&2
  echo '[{"id":"started","value":"true"}]'
  exit 0
fi

# ─── Static-IP reconfigure: stop OLD before starting NEW ──────────────────────
# A reconfigure/upgrade clones OLD into NEW; the clone inherits OLD's static
# IP + MAC. Starting NEW while OLD is still running puts the same IP/MAC on the
# bridge twice → FDB flapping, and anything in NEW that needs the network on
# startup fails intermittently: a docker-compose app can't resolve its DB
# ("server misbehaving"), a cloudflared tunnel can't reach the edge. Unlike
# the self-upgrade fast-path above we do NOT switchover-skip the remaining
# steps — post_start (docker-compose up) must still run on NEW and replace_ct
# then destroys the already-stopped OLD. We only need OLD off the wire first.
#
# Scope: static ip= only. DHCP clones get a fresh lease and never collide, so
# `ip=dhcp` (NEW_IP stays empty) leaves this untouched and the old behaviour
# (OLD keeps running through the phases) is preserved — which is what the
# livetest suite exercises. STOPPED_PREV is checked in the failure paths below
# to roll OLD back if NEW never comes up.
STOPPED_PREV=""
if [ -n "$PREV_VMID" ] && [ "$PREV_VMID" != "NOT_DEFINED" ] && [ "$PREV_VMID" != "$VMID" ]; then
  NEW_IP=$(pct config "$VMID" 2>/dev/null | grep -aoE 'ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  OLD_IP=$(pct config "$PREV_VMID" 2>/dev/null | grep -aoE 'ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  OLD_STATUS=$(pct status "$PREV_VMID" 2>/dev/null | awk '{print $2}')
  if [ -n "$NEW_IP" ] && [ "$NEW_IP" = "$OLD_IP" ] && [ "$OLD_STATUS" = "running" ]; then
    echo "Static-IP reconfigure: OLD $PREV_VMID and NEW $VMID both use $NEW_IP — stopping OLD before starting NEW" >&2
    # onboot=0 so a host reboot mid-reconfigure can't bring OLD back onto NEW's IP.
    pct set "$PREV_VMID" --onboot 0 >&2 2>/dev/null || true
    if pct shutdown "$PREV_VMID" --timeout 60 --forceStop 1 >&2 2>&1 || pct stop "$PREV_VMID" >&2 2>&1; then
      STOPPED_PREV="$PREV_VMID"
      echo "OLD $PREV_VMID stopped" >&2
    else
      echo "Warning: could not stop OLD $PREV_VMID — continuing, IP collision may persist" >&2
    fi
  fi
fi

# Roll OLD back onto the wire when NEW never comes up (only if we stopped it).
rollback_prev() {
  [ -z "$STOPPED_PREV" ] && return 0
  echo "Rollback: restarting OLD $STOPPED_PREV after NEW $VMID failed to come up" >&2
  pct start "$STOPPED_PREV" >&2 2>&1 || echo "Warning: rollback pct start $STOPPED_PREV failed — service is down, start it manually" >&2
  pct set "$STOPPED_PREV" --onboot 1 >&2 2>/dev/null || true
}

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
  rollback_prev
  echo "" >&2
  echo "=== Container $VMID failed to start ===" >&2
  echo "$START_ERROR" >&2

  # Show application log if available — often more useful than the config
  LOG_PATH=$(pct config "$VMID" 2>/dev/null | grep -a "^lxc.console.logfile:" | awk '{print $2}')
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
  rollback_prev
  echo "" >&2
  echo "=== Container $VMID started but exited immediately ===" >&2
  echo "The application inside the container crashed on startup." >&2
  echo "Check the log below for details (e.g. missing files, invalid configuration)." >&2

  # Show console log — this contains the application's error output
  LOG_PATH=$(pct config "$VMID" 2>/dev/null | grep -a "^lxc.console.logfile:" | awk '{print $2}')
  if [ -n "$LOG_PATH" ] && [ -f "$LOG_PATH" ]; then
    echo "" >&2
    echo "=== Application log (last 30 lines) ===" >&2
    tail -30 "$LOG_PATH" >&2
  fi

  # Show log viewer URL from notes if available
  LOG_URL=$(pct config "$VMID" 2>/dev/null | grep -ao 'proxvex[:%]3[Aa]log-url [^ ]*' | head -1 | sed 's/.*log-url //')
  if [ -n "$LOG_URL" ]; then
    echo "" >&2
    echo "Full log: $LOG_URL" >&2
  fi

  exit 1
fi

# Marker: container is up. Tells the backend to start tailing the application
# logs (LXC console log + docker compose) into the diagnosis timeline.
echo "PROXVEX_PCT_START_EXECUTED vmid=$VMID" >&2

exit 0