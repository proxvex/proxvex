#!/bin/sh
# Check if files exist inside a container.
#
# Template variables:
#   vm_id - Container VM ID
#   check_file_paths - Newline-separated list of file paths to check
#
# Outputs JSON array with check results.
# Exit 1 if any file is missing, exit 0 if all exist.

VM_ID="{{ vm_id }}"
FILE_PATHS="{{ check_file_paths }}"

all_ok=true
missing=""

echo "$FILE_PATHS" | while IFS= read -r fpath; do
    [ -z "$fpath" ] && continue
    if pct exec "$VM_ID" -- test -f "$fpath" 2>/dev/null; then
        echo "CHECK: file_exists PASSED ($fpath)" >&2
    else
        echo "CHECK: file_exists FAILED ($fpath)" >&2
    fi
done

# Re-check for exit code (subshell limitation)
result_missing=""
echo "$FILE_PATHS" | while IFS= read -r fpath; do
    [ -z "$fpath" ] && continue
    if ! pct exec "$VM_ID" -- test -f "$fpath" 2>/dev/null; then
        result_missing="${result_missing}${fpath} "
    fi
done

# Simple check: try each file and collect missing ones
check_result="ok"
for fpath in $(echo "$FILE_PATHS" | tr '\n' ' '); do
    [ -z "$fpath" ] && continue
    if ! pct exec "$VM_ID" -- test -f "$fpath" 2>/dev/null; then
        check_result="missing: ${fpath}"
        all_ok=false
        break
    fi
done

if [ "$all_ok" = "false" ]; then
    escaped=$(printf '%s' "$check_result" | sed 's/"/\\"/g')
    printf '[{"id":"check_file_exists","value":"%s"}]' "$escaped"
    exit 1
else
    printf '[{"id":"check_file_exists","value":"ok"}]'
fi
