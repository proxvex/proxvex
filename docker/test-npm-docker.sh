#!/bin/bash
set -e

# docker/test-npm-docker.sh
# Test script for building npm pack tarball and Docker image
# Usage: ./docker/test-npm-docker.sh [--tag <image>] [--no-build] [--no-push]

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

# Default values
IMAGE_TAG="oci-lxc-deployer-test"
CONTAINER_NAME="oci-lxc-deployer-test"
SKIP_BUILD=false
SKIP_PACK=false
SKIP_RUN=false
DETACH=false
PORT=3080
CONFIG_DIR="examples"
SECURE_DIR="local"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      if [[ -n "$2" ]]; then
        IMAGE_TAG="$2"
        shift 2
      else
        echo "ERROR: --tag requires an argument" >&2
        exit 1
      fi
      ;;
    --container-name)
      if [[ -n "$2" ]]; then
        CONTAINER_NAME="$2"
        shift 2
      else
        echo "ERROR: --container-name requires an argument" >&2
        exit 1
      fi
      ;;
    --no-build)
      SKIP_BUILD=true
      shift
      ;;
    --no-pack)
      SKIP_PACK=true
      shift
      ;;
    --no-run)
      SKIP_RUN=true
      shift
      ;;
    --detach|-d)
      DETACH=true
      shift
      ;;
    --port|-p)
      if [[ -n "$2" ]]; then
        PORT="$2"
        shift 2
      else
        echo "ERROR: --port requires an argument" >&2
        exit 1
      fi
      ;;
    --config-dir)
      if [[ -n "$2" ]]; then
        CONFIG_DIR="$2"
        shift 2
      else
        echo "ERROR: --config-dir requires an argument" >&2
        exit 1
      fi
      ;;
    --secure-dir)
      if [[ -n "$2" ]]; then
        SECURE_DIR="$2"
        shift 2
      else
        echo "ERROR: --secure-dir requires an argument" >&2
        exit 1
      fi
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --tag <image>         Docker image tag (default: oci-lxc-deployer-test)"
      echo "  --container-name <n>  Container name (default: oci-lxc-deployer-test)"
      echo "  --no-build           Skip npm build steps (use existing dist/)"
      echo "  --no-pack            Skip npm pack (use existing docker/oci-lxc-deployer.tgz)"
      echo "  --no-run             Skip starting container after build"
      echo "  --detach, -d          Run container in detached mode"
      echo "  --port <p>, -p <p>   Host port to map to container port 3080 (default: 3000)"
      echo "  --config-dir <dir>   Local directory to mount as /config (default: examples)"
      echo "  --secure-dir <dir>   Local directory to mount as /secure (default: local)"
      echo "  --help, -h           Show this help message"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Use --help for usage information" >&2
      exit 1
      ;;
  esac
done

cd "$PROJECT_ROOT"

# Get version from package.json
BUILD_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "dev")
BUILD_REF=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
BUILD_REPOSITORY="${BUILD_REPOSITORY:-modbus2mqtt/oci-lxc-deployer}"

echo "=== OCI LXC Deployer npm pack + Docker Build Test ==="
echo "  Image tag: $IMAGE_TAG"
echo "  Version: $BUILD_VERSION"
echo "  Git ref: ${BUILD_REF:0:8}"
echo "  Build date: $BUILD_DATE"
echo ""

# Step 1: Build project (if not skipped)
if [ "$SKIP_BUILD" = "false" ]; then
  echo "=== Step 1: Building project ==="
  
  # Sync dependencies first to ensure package.json is up to date
  echo "Synchronizing dependencies..."
  # Redirect stdout to stderr to avoid interfering with node -p commands
  npm run sync-dependencies:lock >&2
  
  echo "Installing root dependencies..."
  # Use npm install instead of npm ci since we just synced dependencies
  npm install
  
  echo "Building frontend..."
  (cd frontend && npm install && npm run build)
  
  echo "Building backend..."
  (cd backend && npm install && npm run build)
  
  echo "Building root..."
  npm run build
  
  echo "✓ Build completed"
  echo ""
else
  echo "=== Step 1: Skipping build (using existing dist/) ==="
  echo ""
fi

# Step 2: Create npm pack tarball (if not skipped)
if [ "$SKIP_PACK" = "false" ]; then
  echo "=== Step 2: Creating npm pack tarball ==="
  
  # Remove old tarball if exists
  if [ -f "docker/oci-lxc-deployer.tgz" ]; then
    echo "Removing old tarball..."
    rm -f docker/oci-lxc-deployer.tgz
  fi
  
  echo "Running npm pack..."
  PACK_INFO=$(npm pack --json)
  TARBALL=$(echo "$PACK_INFO" | node -e "const i=JSON.parse(require('fs').readFileSync(0, 'utf-8')); console.log(i[0].filename)")
  
  if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
    echo "ERROR: npm pack failed or tarball not found" >&2
    exit 1
  fi
  
  echo "Moving tarball to docker/oci-lxc-deployer.tgz..."
  mv "$TARBALL" docker/oci-lxc-deployer.tgz
  
  TARBALL_SIZE=$(du -h docker/oci-lxc-deployer.tgz | cut -f1)
  echo "✓ Tarball created: docker/oci-lxc-deployer.tgz ($TARBALL_SIZE)"
  echo ""
else
  echo "=== Step 2: Skipping npm pack (using existing docker/oci-lxc-deployer.tgz) ==="
  if [ ! -f "docker/oci-lxc-deployer.tgz" ]; then
    echo "ERROR: docker/oci-lxc-deployer.tgz not found. Run without --no-pack first." >&2
    exit 1
  fi
  echo "✓ Using existing tarball: docker/oci-lxc-deployer.tgz"
  echo ""
fi

# Step 3: Build Docker image with buildx
echo "=== Step 3: Building Docker image ==="

# Check if buildx is available
if ! docker buildx version >/dev/null 2>&1; then
  echo "WARNING: docker buildx not available, using regular docker build" >&2
  USE_BUILDX=false
else
  USE_BUILDX=true
  # Ensure buildx builder exists
  if ! docker buildx ls | grep -q "oci-lxc-deployer-builder"; then
    echo "Creating buildx builder..."
    docker buildx create --name oci-lxc-deployer-builder --use >/dev/null 2>&1 || true
  else
    docker buildx use oci-lxc-deployer-builder >/dev/null 2>&1 || true
  fi
fi

echo "Building Docker image..."
echo "  Dockerfile: docker/Dockerfile.npm-pack"
echo "  Tarball: docker/oci-lxc-deployer.tgz"
echo ""

if [ "$USE_BUILDX" = "true" ]; then
  docker buildx build \
    --file docker/Dockerfile.npm-pack \
    --tag "$IMAGE_TAG:latest" \
    --tag "$IMAGE_TAG:$BUILD_VERSION" \
    --build-arg NPM_TARBALL=docker/oci-lxc-deployer.tgz \
    --build-arg BUILD_VERSION="$BUILD_VERSION" \
    --build-arg BUILD_REF="$BUILD_REF" \
    --build-arg BUILD_DATE="$BUILD_DATE" \
    --build-arg BUILD_REPOSITORY="$BUILD_REPOSITORY" \
    --load \
    .
else
  docker build \
    --file docker/Dockerfile.npm-pack \
    --tag "$IMAGE_TAG:latest" \
    --tag "$IMAGE_TAG:$BUILD_VERSION" \
    --build-arg NPM_TARBALL=docker/oci-lxc-deployer.tgz \
    --build-arg BUILD_VERSION="$BUILD_VERSION" \
    --build-arg BUILD_REF="$BUILD_REF" \
    --build-arg BUILD_DATE="$BUILD_DATE" \
    --build-arg BUILD_REPOSITORY="$BUILD_REPOSITORY" \
    .
fi

echo ""
echo "✓ Docker image built successfully"
echo "  Image: $IMAGE_TAG:latest"
echo "  Image: $IMAGE_TAG:$BUILD_VERSION"
echo ""

# Show image info
echo "=== Image Information ==="
docker images "$IMAGE_TAG" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
echo ""

# Step 4: Start container (if not skipped)
if [ "$SKIP_RUN" = "false" ]; then
  echo "=== Step 4: Starting container ==="
  
  # Check if port is already in use
  if lsof -i ":$PORT" >/dev/null 2>&1; then
    echo "WARNING: Port $PORT is already in use" >&2
    echo "  Using a different port or stop the service using port $PORT" >&2
    exit 1
  fi
  
  # Stop and remove existing container if it exists
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Stopping and removing existing container '$CONTAINER_NAME'..."
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  
  # Resolve directories: support absolute paths, else relative to project root
  if [[ "$CONFIG_DIR" = /* ]]; then
    CONFIG_PATH="$CONFIG_DIR"
  else
    CONFIG_PATH="$PROJECT_ROOT/$CONFIG_DIR"
  fi
  if [[ "$SECURE_DIR" = /* ]]; then
    SECURE_PATH="$SECURE_DIR"
  else
    SECURE_PATH="$PROJECT_ROOT/$SECURE_DIR"
  fi
  
  if [ ! -d "$CONFIG_PATH" ]; then
    echo "WARNING: Config directory not found: $CONFIG_PATH" >&2
    echo "  Creating directory..." >&2
    mkdir -p "$CONFIG_PATH"
  fi
  
  if [ ! -d "$SECURE_PATH" ]; then
    echo "WARNING: Secure directory not found: $SECURE_PATH" >&2
    echo "  Creating directory..." >&2
    mkdir -p "$SECURE_PATH"
  fi
  
  echo "Starting container..."
  echo "  Container name: $CONTAINER_NAME"
  echo "  Port mapping: $PORT:3080"
  echo "  Config volume: $CONFIG_PATH -> /config"
  echo "  Secure volume: $SECURE_PATH -> /secure"
  echo ""
  
  if [ "$DETACH" = "true" ]; then
    docker run -d \
      --name "$CONTAINER_NAME" \
      -p "$PORT:3080" \
      -v "$CONFIG_PATH:/config" \
      -v "$SECURE_PATH:/secure" \
      "$IMAGE_TAG:latest"
    
    echo "✓ Container started in detached mode"
    echo ""
    echo "Container information:"
    docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo "View logs:"
    echo "  docker logs -f $CONTAINER_NAME"
    echo ""
    echo "Stop container:"
    echo "  docker stop $CONTAINER_NAME"
    echo ""
    echo "Remove container:"
    echo "  docker rm $CONTAINER_NAME"
    echo ""
    echo "Access web UI:"
    echo "  http://localhost:$PORT"
  else
    echo "Starting container (press Ctrl+C to stop)..."
    echo ""
    echo "Access web UI: http://localhost:$PORT"
    echo ""
    echo "SSH keys will be written to: $SECURE_PATH/.ssh"
    echo "Storage context is at:      $CONFIG_PATH/storagecontext.json"
    echo ""
    
    # Trap Ctrl+C to cleanup
    trap 'echo ""; echo "Stopping container..."; docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true; docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true; exit 0' INT TERM
    
    docker run --rm \
      --name "$CONTAINER_NAME" \
      -p "$PORT:3080" \
      -v "$CONFIG_PATH:/config" \
      -v "$SECURE_PATH:/secure" \
      "$IMAGE_TAG:latest"
  fi
else
  echo "=== Step 4: Skipping container start ==="
  echo ""
  echo "=== Next Steps ==="
  echo "Start the container manually:"
  echo "  docker run --rm -p $PORT:3080 \\"
  echo "    -v \"\$PWD/$CONFIG_DIR:/config\" \\"
  echo "    -v \"\$PWD/$SECURE_DIR:/secure\" \\"
  echo "    $IMAGE_TAG:latest"
  echo ""
  echo "Or in detached mode:"
  echo "  docker run -d --name $CONTAINER_NAME -p $PORT:3080 \\"
  echo "    -v \"\$PWD/$CONFIG_DIR:/config\" \\"
  echo "    -v \"\$PWD/$SECURE_DIR:/secure\" \\"
  echo "    $IMAGE_TAG:latest"
  echo ""
fi

