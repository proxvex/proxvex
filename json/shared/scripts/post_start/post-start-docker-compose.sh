#!/bin/sh
# Start Docker Compose services
#
# This script:
# 1. Changes to the project directory
# 2. Starts Docker daemon if not running
# 3. Runs 'docker-compose up -d' to start services
# 4. Checks status of containers
#
# Requires:
#   - compose_project: Project name (directory name)
#
# Output: JSON to stdout (errors to stderr)

COMPOSE_PROJECT="{{ compose_project }}"
VMID="{{ vm_id }}"
STARTUP_TIMEOUT="{{ startup_timeout }}"

# Default timeout if not set
if [ -z "$STARTUP_TIMEOUT" ] || [ "$STARTUP_TIMEOUT" = "NOT_DEFINED" ]; then
  STARTUP_TIMEOUT=120
fi

if [ -z "$COMPOSE_PROJECT" ]; then
  echo "Error: Required parameter 'compose_project' must be set" >&2
  exit 1
fi

PROJECT_DIR="/opt/docker-compose/$COMPOSE_PROJECT"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Project directory '$PROJECT_DIR' does not exist" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/docker-compose.yaml" ] && [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "Error: docker-compose.yaml or docker-compose.yml not found in '$PROJECT_DIR'" >&2
  exit 1
fi

# Check if Docker is available
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker command not found. Please ensure Docker is installed." >&2
  exit 1
fi

# Wait for Docker daemon to be ready (handles timing issues after container start)
wait_for_docker() {
  max_attempts="${1:-30}"
  attempt=1

  echo "Waiting for Docker daemon to be ready..." >&2

  while [ "$attempt" -le "$max_attempts" ]; do
    if docker info >/dev/null 2>&1; then
      echo "Docker daemon is ready (attempt $attempt/$max_attempts)" >&2
      return 0
    fi

    echo "Docker not ready yet, waiting... (attempt $attempt/$max_attempts)" >&2
    sleep 2
    attempt=$((attempt + 1))
  done

  echo "Error: Docker daemon did not become ready after $max_attempts attempts" >&2
  echo "For Docker Rootless, ensure dockerd-rootless is running." >&2
  echo "For standard Docker, ensure dockerd service is running." >&2
  return 1
}

if ! wait_for_docker 30; then
  exit 1
fi

echo "Docker daemon is running" >&2

# Change to project directory
cd "$PROJECT_DIR" || {
  echo "Error: Failed to change to directory '$PROJECT_DIR'" >&2
  exit 1
}

# Determine compose file name
COMPOSE_FILE=""
if [ -f "docker-compose.yaml" ]; then
  COMPOSE_FILE="docker-compose.yaml"
elif [ -f "docker-compose.yml" ]; then
  COMPOSE_FILE="docker-compose.yml"
fi

# Fix volume permissions inside container (host chmod may not propagate through LXC bind-mounts)
# Parse docker-compose.yaml for bind-mount volumes and ensure they are writable
if [ -n "$COMPOSE_FILE" ]; then
  for vol_line in $(grep -E '^\s*-\s+/' "$COMPOSE_FILE" | sed 's/.*- //' | sed 's/:.*//'); do
    if [ -d "$vol_line" ]; then
      chmod 777 "$vol_line" 2>/dev/null || true
    fi
  done
fi

# Run docker compose up -d --wait (waits for healthchecks to pass)
echo "Starting Docker Compose services (timeout: ${STARTUP_TIMEOUT}s)..." >&2
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout "$STARTUP_TIMEOUT" --quiet-pull >&2
  RC=$?
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout "$STARTUP_TIMEOUT" --quiet-pull >&2
  RC=$?
else
  echo "Error: Neither 'docker-compose' nor 'docker compose' command found" >&2
  exit 1
fi

if [ $RC -ne 0 ]; then
  echo "Error: Failed to start Docker Compose services (exit code: $RC)" >&2
  # Dump logs per service for debugging
  for svc in $(docker compose -f "$COMPOSE_FILE" ps --services 2>/dev/null); do
    echo "=== Docker logs: $svc (last 30 lines) ===" >&2
    docker compose -f "$COMPOSE_FILE" logs --tail=30 "$svc" >&2 2>&1 || true
  done
  exit $RC
fi

# Check container status
echo "Checking container status..." >&2
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f "$COMPOSE_FILE" ps >&2
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_FILE" ps >&2
fi

# Ensure containers restart automatically on boot
# Docker daemon is enabled at boot (rc-update/systemctl enable)
# Setting restart policy ensures Docker starts these containers when daemon starts
echo "Setting restart policy for containers..." >&2
if command -v docker-compose >/dev/null 2>&1; then
  CONTAINER_IDS=$(docker-compose -f "$COMPOSE_FILE" ps -q 2>/dev/null)
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  CONTAINER_IDS=$(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null)
fi
if [ -n "$CONTAINER_IDS" ]; then
  echo "$CONTAINER_IDS" | xargs docker update --restart=unless-stopped >&2 || true
  echo "Restart policy set for all containers" >&2
else
  echo "Warning: No container IDs found to set restart policy" >&2
fi

echo "Docker Compose services started successfully" >&2
echo '[{"id": "docker_compose_started", "value": "true"}, {"id": "compose_dir", "value": "'"$PROJECT_DIR"'"}]'
