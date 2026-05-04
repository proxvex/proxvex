#!/bin/sh
# Check container status after installation.
# Checks: container stays running over a stability window, notes contain managed marker.
#
# Template variables:
#   vm_id - Container VM ID
#   hostname - Container hostname
#
# Outputs JSON array with check results.
# Exit 1 on fatal check failure (default), exit 0 if all checks pass.
#
# The container_running check polls `pct status` over a stability window
# (~10 s, 3 samples * 5 s) instead of sampling once. A single sample can
# pass while the application inside the container is still in early startup
# (e.g. postgres initdb) and PANICs a few seconds later — we need to fail
# the install pipeline in that case rather than report success.

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"

# Stability window for container_running check: 3 samples * 5 s ≈ 10 s.
STABLE_SAMPLES=3
STABLE_SLEEP=5

results="[]"
all_passed=true

add_result() {
    check="$1"
    passed="$2"
    detail="$3"
    results=$(echo "$results" | sed 's/\]$//')
    [ "$results" != "[" ] && results="${results},"
    if [ -n "$detail" ]; then
        escaped=$(printf '%s' "$detail" | sed 's/"/\\"/g' | tr '\n' ' ')
        results="${results}{\"check\":\"${check}\",\"passed\":${passed},\"detail\":\"${escaped}\"}]"
    else
        results="${results}{\"check\":\"${check}\",\"passed\":${passed}}]"
    fi
}

# --- Check 1: Container stays running across a stability window ---
i=1
final_status=""
while [ $i -le $STABLE_SAMPLES ]; do
    final_status=$(pct status "$VM_ID" 2>/dev/null)
    if ! echo "$final_status" | grep -q "running"; then
        break
    fi
    if [ $i -lt $STABLE_SAMPLES ]; then
        sleep "$STABLE_SLEEP"
    fi
    i=$((i + 1))
done
if echo "$final_status" | grep -q "running"; then
    add_result "container_running" "true"
    echo "CHECK: container_running PASSED (VM $VM_ID stayed running across $STABLE_SAMPLES samples)" >&2
else
    add_result "container_running" "false" "status: ${final_status} (sample ${i}/${STABLE_SAMPLES})"
    echo "CHECK: container_running FAILED (VM $VM_ID went to '${final_status}' on sample ${i}/${STABLE_SAMPLES})" >&2
    all_passed=false
fi

# --- Check 2: Notes contain managed marker ---
# Proxmox stores notes URL-encoded in the config (colon → %3A).
# The description line may contain large base64 icon data that grep treats as binary,
# so use grep -a to force text mode and match both encoded and decoded forms.
notes_raw=$(pct config "$VM_ID" 2>/dev/null | grep -a "^description:" || true)
if echo "$notes_raw" | grep -aq "proxvex%3Amanaged\|proxvex:managed"; then
    add_result "notes_managed" "true"
    echo "CHECK: notes_managed PASSED" >&2
else
    add_result "notes_managed" "false" "managed marker not found in notes"
    echo "CHECK: notes_managed FAILED (managed marker not found)" >&2
    all_passed=false
fi

# Output results
printf '[{"id":"check_results","value":"%s"}]' "$(echo "$results" | sed 's/"/\\"/g')"

if [ "$all_passed" = "false" ]; then
    exit 1
fi
