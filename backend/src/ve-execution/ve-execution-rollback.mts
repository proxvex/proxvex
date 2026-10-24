/**
 * Rollback of a failed replacement (reconfigure / upgrade).
 *
 * A reconfigure or upgrade clones OLD into NEW, starts NEW and only at the very
 * end (replace_ct) stops and destroys OLD. When a step AFTER the start fails —
 * typically a post_start hook of the application — the task used to end with
 * BOTH containers running: same hostname, the router's DNS answering with
 * whichever registered last, and every `ssh <hostname>` / sync landing on a
 * random one of the two. (lxc-start.sh already rolls back when NEW never comes
 * up, and stops OLD up front only for static IPs.)
 *
 * Policy: keep what worked. NEW is stopped and set to onboot=0 — it stays for
 * diagnosis, nothing is destroyed. OLD is unlocked, set to onboot=1 and
 * started if it is not running. Not applied to the deployer's self-upgrade
 * (switchover path in lxc-start.sh) and not inside nested template executions.
 */

/** Positive integer VMID, or undefined. */
export function parseVmid(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^[1-9][0-9]*$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/**
 * Decide whether a failed task needs the rollback. Returns the pair, or
 * undefined when there is nothing to roll back (no replacement, NEW never
 * started, same container).
 */
export function rollbackTarget(
  inputs: Record<string, unknown>,
  outputs: Map<string, unknown>,
): { newVmid: number; oldVmid: number } | undefined {
  if (outputs.get("started") !== "true") return undefined;
  if (outputs.get("switchover_scheduled") === "true") return undefined;
  const oldVmid = parseVmid(inputs["previous_vm_id"]);
  const newVmid = parseVmid(outputs.get("vm_id") ?? inputs["vm_id"]);
  if (oldVmid === undefined || newVmid === undefined || oldVmid === newVmid) return undefined;
  return { newVmid, oldVmid };
}

/**
 * POSIX sh for the PVE host. stdout carries only the JSON result, all logs go
 * to stderr (project rule: no 2>&1).
 */
export function buildRollbackScript(newVmid: number, oldVmid: number): string {
  return `#!/bin/sh
NEW=${newVmid}
OLD=${oldVmid}
log() { echo "$@" >&2; }
status() { pct status "$1" 2>/dev/null | awk '{print $2}'; }

if pct config "$OLD" 2>/dev/null | grep -qa "deployer-instance"; then
  log "Rollback skipped: $OLD is the deployer (self-upgrade has its own recovery path)"
  printf '[{"id":"rolled_back","value":"false"}]'
  exit 0
fi

log "=== Rollback: replacement $OLD -> $NEW failed after $NEW was started ==="
if [ "$(status "$NEW")" = "running" ]; then
  log "Stopping NEW $NEW (kept for diagnosis, not destroyed)"
  pct shutdown "$NEW" --timeout 60 --forceStop 1 >&2 || pct stop "$NEW" >&2 || log "Warning: could not stop $NEW"
fi
pct set "$NEW" --onboot 0 >&2 || true

if pct config "$OLD" 2>/dev/null | grep -qa '^lock:'; then
  pct unlock "$OLD" >&2 || log "Warning: could not unlock $OLD"
fi
pct set "$OLD" --onboot 1 >&2 || true
if [ "$(status "$OLD")" != "running" ]; then
  log "Starting OLD $OLD"
  pct start "$OLD" >&2 || log "Warning: could not start $OLD — service is down, start it manually"
fi

log "OLD $OLD serves again; NEW $NEW is stopped (onboot=0)."
log "Inspect NEW: pct start $NEW; pct enter $NEW."
log "Discard NEW: pct destroy $NEW --purge — its rootfs is a ZFS clone of a snapshot of $OLD"
log "  (subvol-$OLD-disk-*@oci-clone-*); that snapshot stays on $OLD and can be destroyed afterwards."
printf '[{"id":"rolled_back","value":"true"}]'
`;
}
