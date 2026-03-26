#!/bin/sh
# Check Docker services are running inside a container.
# Only applicable to docker-compose based applications.
#
# Template variables:
#   vm_id - Container VM ID
#
# Checks that all docker containers are in "Up" state.
# For containers with a healthcheck, waits until they report "(healthy)".
# Exit 1 on failure, exit 0 if all services are up and healthy.

VM_ID="{{ vm_id }}"
HEALTH_TIMEOUT="{{ startup_timeout }}"

# Default timeout if not set
if [ -z "$HEALTH_TIMEOUT" ] || [ "$HEALTH_TIMEOUT" = "NOT_DEFINED" ]; then
    HEALTH_TIMEOUT=120
fi

# Check if docker is installed in the container
if ! pct exec "$VM_ID" -- which docker >/dev/null 2>&1; then
    echo "CHECK: services_up SKIPPED (docker not installed)" >&2
    printf '[{"id":"check_services","value":"skipped (no docker)"}]'
    exit 0
fi

# Build format string via shell variable to avoid {{ }} being treated as template variables
LB='{''{'
RB='}''}'
DOCKER_FMT="${LB}.Names${RB}\t${LB}.Status${RB}"

# --- Phase 1: All containers must be Up ---
docker_ps=$(pct exec "$VM_ID" -- docker ps --format "$DOCKER_FMT" 2>/dev/null || true)

if [ -z "$docker_ps" ]; then
    echo "CHECK: services_up FAILED (no docker containers found)" >&2
    printf '[{"id":"check_services","value":"no containers found"}]'
    exit 1
fi

not_up=$(echo "$docker_ps" | grep -v "	Up" || true)
if [ -n "$not_up" ]; then
    echo "CHECK: services_up FAILED (some services not Up)" >&2
    echo "$not_up" >&2
    printf '[{"id":"check_services","value":"some services not up"}]'
    exit 1
fi

# --- Phase 2: Wait for containers with healthcheck to become healthy ---
elapsed=0
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    docker_ps=$(pct exec "$VM_ID" -- docker ps --format "$DOCKER_FMT" 2>/dev/null || true)

    has_unhealthy=false
    has_starting=false

    echo "$docker_ps" | while IFS="$(printf '\t')" read -r name status; do
        [ -z "$name" ] && continue
        case "$status" in
            *"(healthy)"*)
                echo "CHECK: service $name is healthy" >&2 ;;
            *"(unhealthy)"*)
                echo "CHECK: service $name is UNHEALTHY" >&2 ;;
            *"(health: starting)"*)
                echo "CHECK: service $name health starting (waiting...)" >&2 ;;
            *Up*)
                echo "CHECK: service $name is Up (no healthcheck)" >&2 ;;
        esac
    done

    # Check for unhealthy (fatal)
    if echo "$docker_ps" | grep -q "(unhealthy)"; then
        unhealthy_names=$(echo "$docker_ps" | grep "(unhealthy)" | cut -f1)
        echo "CHECK: services_up FAILED (unhealthy: $unhealthy_names)" >&2
        printf '[{"id":"check_services","value":"unhealthy: %s"}]' "$unhealthy_names"
        exit 1
    fi

    # Check if any are still starting
    if echo "$docker_ps" | grep -q "(health: starting)"; then
        sleep 5
        elapsed=$((elapsed + 5))
        continue
    fi

    # All Up and healthy (or no healthcheck)
    echo "CHECK: services_up PASSED (all services up and healthy)" >&2
    printf '[{"id":"check_services","value":"all services up and healthy"}]'
    exit 0
done

# Timeout waiting for healthy
starting_names=$(echo "$docker_ps" | grep "(health: starting)" | cut -f1)
echo "CHECK: services_up FAILED (timeout waiting for healthy: $starting_names)" >&2
printf '[{"id":"check_services","value":"timeout waiting for healthy"}]'
exit 1
