#!/bin/sh
# Verify Docker services are running inside a container.
# Only applicable to docker-compose based applications.
#
# Template variables:
#   vm_id - Container VM ID
#
# Checks that all docker containers are in "Up" state.
# Exit 1 on failure, exit 0 if all services are up.

VM_ID="{{ vm_id }}"

# Check if docker is installed in the container
if ! pct exec "$VM_ID" -- which docker >/dev/null 2>&1; then
    echo "VERIFY: services_up SKIPPED (docker not installed)" >&2
    printf '[{"id":"verify_services","value":"skipped (no docker)"}]'
    exit 0
fi

# Get docker ps output from inside the container
docker_ps=$(pct exec "$VM_ID" -- docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true)

if [ -z "$docker_ps" ]; then
    echo "VERIFY: services_up FAILED (no docker containers found)" >&2
    printf '[{"id":"verify_services","value":"no containers found"}]'
    exit 1
fi

all_up=true
not_up=""

echo "$docker_ps" | while IFS="$(printf '\t')" read -r name status; do
    if echo "$status" | grep -q "^Up"; then
        echo "VERIFY: service $name is Up" >&2
    else
        echo "VERIFY: service $name is NOT Up (status: $status)" >&2
    fi
done

# Check if any service is not "Up"
not_up_services=$(echo "$docker_ps" | grep -v "	Up" || true)
if [ -n "$not_up_services" ]; then
    echo "VERIFY: services_up FAILED" >&2
    echo "$not_up_services" >&2
    printf '[{"id":"verify_services","value":"some services not up"}]'
    exit 1
fi

echo "VERIFY: services_up PASSED (all services are Up)" >&2
printf '[{"id":"verify_services","value":"all services up"}]'
