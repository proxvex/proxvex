#!/bin/sh
# Check if files exist inside a container.
# Retries for up to 60s to handle files written asynchronously after service start.
#
# Template variables:
#   vm_id - Container VM ID
#   check_file_paths - Newline-separated list of file paths to check
#
# Outputs JSON array with check results.
# Exit 1 if any file is missing after retries, exit 0 if all exist.

VM_ID="{{ vm_id }}"
FILE_PATHS="{{ check_file_paths }}"
RETRY_TIMEOUT=60

elapsed=0
while [ "$elapsed" -lt "$RETRY_TIMEOUT" ]; do
    all_found=true
    missing_file=""

    for fpath in $(echo "$FILE_PATHS" | tr '\n' ' '); do
        [ -z "$fpath" ] && continue
        if ! pct exec "$VM_ID" -- test -f "$fpath" 2>/dev/null; then
            all_found=false
            missing_file="$fpath"
            break
        fi
    done

    if [ "$all_found" = "true" ]; then
        # Log all files as passed
        for fpath in $(echo "$FILE_PATHS" | tr '\n' ' '); do
            [ -z "$fpath" ] && continue
            echo "CHECK: file_exists PASSED ($fpath)" >&2
        done
        printf '[{"id":"check_file_exists","value":"ok"}]'
        exit 0
    fi

    echo "CHECK: file_exists waiting ($missing_file not yet available, ${elapsed}s/${RETRY_TIMEOUT}s)" >&2
    sleep 5
    elapsed=$((elapsed + 5))
done

# Final report of what's missing
for fpath in $(echo "$FILE_PATHS" | tr '\n' ' '); do
    [ -z "$fpath" ] && continue
    if pct exec "$VM_ID" -- test -f "$fpath" 2>/dev/null; then
        echo "CHECK: file_exists PASSED ($fpath)" >&2
    else
        echo "CHECK: file_exists FAILED ($fpath)" >&2
    fi
done

printf '[{"id":"check_file_exists","value":"missing: %s"}]' "$missing_file"
exit 1
