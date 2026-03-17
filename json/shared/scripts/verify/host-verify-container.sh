#!/bin/sh
# Verify container status after installation.
# Checks: container is running, notes contain managed marker.
#
# Template variables:
#   vm_id - Container VM ID
#   hostname - Container hostname
#
# Outputs JSON array with verification results.
# Exit 1 on fatal check failure (default), exit 0 if all checks pass.

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"

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

# --- Check 1: Container is running ---
status_output=$(pct status "$VM_ID" 2>/dev/null)
if echo "$status_output" | grep -q "running"; then
    add_result "container_running" "true"
    echo "VERIFY: container_running PASSED (VM $VM_ID is running)" >&2
else
    add_result "container_running" "false" "status: ${status_output}"
    echo "VERIFY: container_running FAILED (VM $VM_ID status: ${status_output})" >&2
    all_passed=false
fi

# --- Check 2: Notes contain managed marker ---
# Proxmox stores notes URL-encoded in the config (colon → %3A).
# The description line may contain large base64 icon data that grep treats as binary,
# so use grep -a to force text mode and match both encoded and decoded forms.
notes_raw=$(pct config "$VM_ID" 2>/dev/null | grep -a "^description:" || true)
if echo "$notes_raw" | grep -aq "oci-lxc-deployer%3Amanaged\|oci-lxc-deployer:managed"; then
    add_result "notes_managed" "true"
    echo "VERIFY: notes_managed PASSED" >&2
else
    add_result "notes_managed" "false" "managed marker not found in notes"
    echo "VERIFY: notes_managed FAILED (managed marker not found)" >&2
    all_passed=false
fi

# Output results
printf '[{"id":"verify_results","value":"%s"}]' "$(echo "$results" | sed 's/"/\\"/g')"

if [ "$all_passed" = "false" ]; then
    exit 1
fi
