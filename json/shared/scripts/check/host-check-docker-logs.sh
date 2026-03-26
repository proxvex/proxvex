#!/bin/sh
# Check Docker container logs for errors.
#
# Template variables:
#   vm_id - Container VM ID
#
# Outputs JSON array with check results.
# Exit 0 always (log errors are warnings, not fatal).

VM_ID="{{ vm_id }}"

# Check if docker is installed in the container
if ! pct exec "$VM_ID" -- which docker >/dev/null 2>&1; then
    echo "CHECK: docker_log_no_errors SKIPPED (docker not installed)" >&2
    printf '[{"id":"check_docker_logs","value":"skipped (no docker)"}]'
    exit 0
fi

# Get logs from all containers (last 200 lines each)
LB='{''{'
RB='}''}'
NAMES_FMT="${LB}.Names${RB}"
containers=$(pct exec "$VM_ID" -- docker ps --format "$NAMES_FMT" 2>/dev/null || true)

if [ -z "$containers" ]; then
    echo "CHECK: docker_log_no_errors SKIPPED (no containers)" >&2
    printf '[{"id":"check_docker_logs","value":"skipped (no containers)"}]'
    exit 0
fi

all_clean=true
error_summary=""

for name in $containers; do
    logs=$(pct exec "$VM_ID" -- docker logs --tail 200 "$name" 2>&1 || true)
    # Filter for error lines, ignoring known harmless patterns
    errors=$(printf '%s' "$logs" | grep -i error | grep -v "projections\.notifications.*missing protocol scheme" || true)
    if [ -n "$errors" ]; then
        count=$(printf '%s\n' "$errors" | wc -l | tr -d ' ')
        echo "CHECK: docker_log_no_errors WARNING ($name has $count error lines)" >&2
        printf '%s\n' "$errors" | head -3 >&2
        error_summary="${error_summary}${name}: ${count} errors; "
        all_clean=false
    fi
done

if [ "$all_clean" = "true" ]; then
    echo "CHECK: docker_log_no_errors PASSED" >&2
    printf '[{"id":"check_docker_logs","value":"clean"}]'
else
    escaped=$(printf '%s' "$error_summary" | sed 's/"/\\"/g')
    printf '[{"id":"check_docker_logs","value":"%s"}]' "$escaped"
fi
