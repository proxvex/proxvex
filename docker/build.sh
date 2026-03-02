#!/bin/bash
set -e

# docker/build.sh
# Local Docker build script - builds Docker image using APKs produced from alpine/package
# Usage:
#   ./docker/build.sh [version] [--generate] [--tag <image>]
# - If --generate is provided, will generate APK package dirs from INI files before building

# Determine script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

# Get version from parameter or package.json
BUILD_VERSION="${1:-$(cd "$PROJECT_ROOT" && node -p "require('./package.json').version" 2>/dev/null || echo "dev")}"

# Detect host architecture and map to Alpine naming
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
    x86_64)
        BUILD_ARCH="x86_64"
        ;;
    aarch64|arm64)
        BUILD_ARCH="aarch64"
        ;;
    *)
        echo "WARNING: Unknown architecture $HOST_ARCH, defaulting to x86_64" >&2
        BUILD_ARCH="x86_64"
        ;;
esac

GENERATE=false
IMAGE_TAG="modbus2mqtt"
for arg in "$@"; do
    if [ "$arg" = "--generate" ]; then GENERATE=true; fi
done

# Parse --tag <image>
while [ $# -gt 0 ]; do
    case "$1" in
        --tag)
            shift
            IMAGE_TAG="${1:-$IMAGE_TAG}"
            ;;
    esac
    shift || true
done

# Optionally generate APK package directories from INI files
PKG_BASE="$PROJECT_ROOT/alpine/package"
if [ "$GENERATE" = true ]; then
    echo "Generating APK package dirs from INI files..."
    if [ ! -x "$PKG_BASE/generate-ap.sh" ]; then
        echo "ERROR: generate-ap.sh not found or not executable at $PKG_BASE/generate-ap.sh" >&2
        exit 1
    fi
    # Find all .ini files and generate corresponding package directories
    find "$PKG_BASE" -maxdepth 1 -type f -name "*.ini" | while read -r ini; do
        pkg=$(basename "$ini" .ini)
        echo "  -> $pkg from $(basename "$ini")"
        (cd "$PKG_BASE" && ./generate-ap.sh "$pkg" "$ini")
    done
fi

echo "Building Docker image"
echo "  Image tag: $IMAGE_TAG"
echo "  Version: $BUILD_VERSION"
echo "  Architecture: $BUILD_ARCH"
echo "  Project root: $PROJECT_ROOT"

# Check if APK files exist
APK_DIR="$PROJECT_ROOT/alpine/repo/$BUILD_ARCH"
PUBLIC_KEY="$PROJECT_ROOT/alpine/repo/packager.rsa.pub"

if [ ! -d "$APK_DIR" ] || [ ! -f "$PUBLIC_KEY" ]; then
    echo ""
    echo "ERROR: APK repository not found!"
    echo "  Expected APK directory: $APK_DIR"
    echo "  Expected public key: $PUBLIC_KEY"
    echo ""
    echo "Please build APKs first, e.g.:"
    echo "  cd alpine/package/<pkg> && abuild -r"
    echo "Or use: ./docker/build.sh [version] --generate (then abuild)"
    echo ""
    exit 1
fi

APK_COUNT=$(find "$APK_DIR" -name "*.apk" | wc -l)
if [ "$APK_COUNT" -eq 0 ]; then
    echo "ERROR: No APK files found in $APK_DIR"
    echo "Available directories:"
    ls -la "$PROJECT_ROOT/alpine/repo/" 2>/dev/null || echo "  (none)"
    exit 1
fi

echo "Found APK repository:"
echo "  APK directory: $APK_DIR ($APK_COUNT files)"
echo "  Public key: $PUBLIC_KEY"

# Build the Docker image
cd "$PROJECT_ROOT"
docker build -t "$IMAGE_TAG" \
    -f docker/Dockerfile \
    --build-arg BUILD_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --build-arg BUILD_DESCRIPTION="${IMAGE_TAG} Docker Image" \
    --build-arg BUILD_NAME="${IMAGE_TAG}" \
    --build-arg BUILD_REPOSITORY="${IMAGE_TAG}" \
    --build-arg BUILD_VERSION="$BUILD_VERSION" \
    --build-arg BUILD_ARCH="$BUILD_ARCH" \
    --build-arg PACKAGE_NAME="$IMAGE_TAG" \
    --build-arg ALPINE_VERSION="3.22" \
    .

echo ""
echo "✓ Docker image '$IMAGE_TAG' built successfully"
echo "  Image: ${IMAGE_TAG}:latest"
echo "  Version: $BUILD_VERSION"
echo "  Architecture: $BUILD_ARCH"
echo ""
echo "Next steps:"
echo "  Test: ./docker/test.sh"
echo "  Run:  docker run -d -p 3080:3080 -p 3443:3443 -p 22:22 ${IMAGE_TAG}"
echo "  Generate APK dirs from INI: ./docker/build.sh --generate"
echo "  Generate APK dirs from INI: ./docker/build.sh --generate"