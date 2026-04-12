#!/bin/sh
# Upgrade Docker Compose services in-place.
#
# Steps:
# 1. Stop running services (docker compose down)
# 2. Pull new images
# 3. Start services (docker compose up -d --wait)
#
# Requires:
#   - compose_project: Project name (directory name)
#
# Output: JSON to stdout

COMPOSE_PROJECT="{{ compose_project }}"
STARTUP_TIMEOUT="{{ startup_timeout }}"

if [ -z "$STARTUP_TIMEOUT" ] || [ "$STARTUP_TIMEOUT" = "NOT_DEFINED" ]; then
  STARTUP_TIMEOUT=120
fi

# Fallback: use container hostname as compose_project
if [ -z "$COMPOSE_PROJECT" ] || [ "$COMPOSE_PROJECT" = "NOT_DEFINED" ]; then
  COMPOSE_PROJECT=$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || true)
fi
if [ -z "$COMPOSE_PROJECT" ] || [ "$COMPOSE_PROJECT" = "NOT_DEFINED" ]; then
  echo "Error: Required parameter 'compose_project' must be set" >&2
  exit 1
fi

PROJECT_DIR="/opt/docker-compose/$COMPOSE_PROJECT"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Project directory '$PROJECT_DIR' does not exist" >&2
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

# Determine compose file name
COMPOSE_FILE=""
if [ -f "docker-compose.yaml" ]; then
  COMPOSE_FILE="docker-compose.yaml"
elif [ -f "docker-compose.yml" ]; then
  COMPOSE_FILE="docker-compose.yml"
else
  echo "Error: No docker-compose.yaml or docker-compose.yml found in '$PROJECT_DIR'" >&2
  exit 1
fi

# Detect compose command
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Error: Neither 'docker-compose' nor 'docker compose' command found" >&2
  exit 1
fi

# Wait for Docker daemon
echo "Waiting for Docker daemon..." >&2
attempt=1
while [ "$attempt" -le 30 ]; do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker daemon not ready" >&2
  exit 1
fi

# Step 1: Stop running services
echo "Stopping Docker Compose services..." >&2
$DC -f "$COMPOSE_FILE" down >&2 || true

# Step 2: Pull new images
echo "Pulling updated Docker images..." >&2
$DC -f "$COMPOSE_FILE" pull >&2

# Step 3: Start services
echo "Starting Docker Compose services (timeout: ${STARTUP_TIMEOUT}s)..." >&2
$DC -f "$COMPOSE_FILE" up -d --wait --wait-timeout "$STARTUP_TIMEOUT" >&2
RC=$?

if [ $RC -ne 0 ]; then
  echo "Error: Failed to start Docker Compose services (exit code: $RC)" >&2
  for svc in $($DC -f "$COMPOSE_FILE" ps --services 2>/dev/null); do
    echo "=== Docker logs: $svc (last 30 lines) ===" >&2
    $DC -f "$COMPOSE_FILE" logs --tail=30 "$svc" >&2 2>&1 || true
  done
  exit $RC
fi

# Check status
$DC -f "$COMPOSE_FILE" ps >&2

# Set restart policy
CONTAINER_IDS=$($DC -f "$COMPOSE_FILE" ps -q 2>/dev/null)
if [ -n "$CONTAINER_IDS" ]; then
  echo "$CONTAINER_IDS" | xargs docker update --restart=unless-stopped >&2 || true
fi

echo "Docker Compose upgrade completed successfully" >&2
echo '[{"id":"docker_compose_upgraded","value":"true"}]'
