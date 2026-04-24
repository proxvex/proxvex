#!/bin/bash
set -e

# docker/test.sh
# Test script for proxvex Docker image
# Usage: ./docker/test.sh [--keep|-k] [--docker-tag <TAG>]

IMAGE_TAG="proxvex"
KEEP_CONTAINER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep|-k)
      KEEP_CONTAINER=true
      shift
      ;;
    --docker-tag)
      if [[ -n "$2" ]]; then
        IMAGE_TAG="$2"
        shift 2
      else
        echo "ERROR: --docker-tag requires an argument" >&2
        exit 1
      fi
      ;;
    *)
      echo "Usage: $0 [--keep|-k] [--docker-tag <TAG>]"
      echo "  --keep|-k         Keep containers running for debugging"
      echo "  --docker-tag TAG  Use specific Docker image tag (default: proxvex)"
      exit 1
      ;;
  esac
done

: "${TEST_PORT_MAIN:=38010}"
: "${TEST_PORT_STANDALONE:=38011}"
TEST_PORTS=("$TEST_PORT_MAIN" "$TEST_PORT_STANDALONE")
MAX_ATTEMPTS=15
WAIT_SECONDS=2

echo "Testing proxvex Docker image '$IMAGE_TAG'..."

cleanup_containers() {
  echo "Cleaning up test containers..."
  docker stop proxvex-test-main proxvex-test-standalone >/dev/null 2>&1 || true
  docker rm   proxvex-test-main proxvex-test-standalone >/dev/null 2>&1 || true
}

cleanup_or_keep() {
  if [ "$KEEP_CONTAINER" = "true" ]; then
    echo ""
    echo "=== Containers kept for debugging ==="
    echo "Main container:       proxvex-test-main       (http://localhost:${TEST_PORT_MAIN}/)"
    echo "Standalone container: proxvex-test-standalone (http://localhost:${TEST_PORT_STANDALONE}/)"
    echo ""
    echo "Commands:"
    echo "  docker logs proxvex-test-main"
    echo "  docker exec -it proxvex-test-main sh"
    echo "  docker stop proxvex-test-main proxvex-test-standalone"
    echo "  docker rm   proxvex-test-main proxvex-test-standalone"
  else
    cleanup_containers
  fi
}

check_ports() {
  local ports_in_use=()
  for port in "${TEST_PORTS[@]}"; do
    if lsof -i ":$port" >/dev/null 2>&1; then
      ports_in_use+=("$port")
    fi
  done
  if [ ${#ports_in_use[@]} -gt 0 ]; then
    echo "ERROR: Ports in use: ${ports_in_use[*]}" >&2
    echo "Run: docker ps -a | grep proxvex" >&2
    exit 1
  fi
}

wait_for_service() {
  local port=$1
  local name=$2
  local container=$3
  local attempts=0
  echo "Waiting for $name on port $port..."
  while [ $attempts -lt $MAX_ATTEMPTS ]; do
    attempts=$((attempts + 1))
    echo "  Attempt $attempts/$MAX_ATTEMPTS..."
    if curl -s -f -o /dev/null "http://localhost:$port/"; then
      echo "✓ $name is ready on port $port"
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$container" >/dev/null 2>&1 \
       || [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
      echo "ERROR: Container $container stopped unexpectedly" >&2
      docker logs "$container" >&2
      return 1
    fi
    sleep $WAIT_SECONDS
  done
  echo "ERROR: $name failed to respond after $MAX_ATTEMPTS attempts" >&2
  docker logs "$container" >&2
  return 1
}

echo "=== proxvex Docker Test ==="

cleanup_containers
check_ports

if [ -z "$(docker images -q "$IMAGE_TAG" 2>/dev/null)" ]; then
  docker images >&2
  echo "ERROR: Docker image '$IMAGE_TAG' not found" >&2
  echo "Build it via:" >&2
  echo "  pnpm install && pnpm run build" >&2
  echo "  npm pack --pack-destination docker/ && mv docker/proxvex-*.tgz docker/proxvex.tgz" >&2
  echo "  docker build -t proxvex -f docker/Dockerfile.npm-pack ." >&2
  exit 1
fi

TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/config" "$TEST_DIR/secure"
trap 'rm -rf "$TEST_DIR"' EXIT

# Test 1: container with persistent /config + /secure volumes
echo ""
echo "=== Test 1: Volume-mounted configuration ==="
echo "Starting container with /config + /secure volumes..."
docker run -d \
  -p "${TEST_PORT_MAIN}":3080 \
  -v "$TEST_DIR/config:/config" \
  -v "$TEST_DIR/secure:/secure" \
  --name proxvex-test-main \
  "$IMAGE_TAG"

if ! wait_for_service "$TEST_PORT_MAIN" "Web service" "proxvex-test-main"; then
  cleanup_or_keep
  exit 1
fi
echo "✓ Test 1 passed: container starts, web service responds"

# Test 2: standalone container without mounted volumes
echo ""
echo "=== Test 2: Standalone container (no volume mounts) ==="
echo "Starting standalone container..."
docker run -d \
  -p "${TEST_PORT_STANDALONE}":3080 \
  --name proxvex-test-standalone \
  "$IMAGE_TAG"

if ! wait_for_service "$TEST_PORT_STANDALONE" "Standalone web service" "proxvex-test-standalone"; then
  docker logs proxvex-test-standalone >&2 || true
  cleanup_or_keep
  exit 1
fi
echo "✓ Test 2 passed: standalone container works"

cleanup_or_keep

echo ""
echo "=== All Tests Passed ==="
echo "✓ Docker image works correctly"
echo "✓ Web service accessible (main + standalone)"
