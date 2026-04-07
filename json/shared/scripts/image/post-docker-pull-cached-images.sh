#!/bin/sh
# Pre-pull Docker images in the existing (old) container before upgrade.
#
# This script runs inside the OLD (still running) container during the
# image phase of an upgrade. It extracts image names from the existing
# docker-compose.yml and pulls the latest versions. Since /var/lib/docker
# is mounted as a persistent Proxmox volume, the pulled images will be
# available to the new container after replace_ct, avoiding re-download.
#
# This is best-effort: failures are logged but don't abort the upgrade.
#
# Requires:
#   - compose_project: Docker Compose project name (for locating compose file)
#
# Output: JSON to stdout (errors to stderr)

COMPOSE_PROJECT="{{ compose_project }}"
TARGET_VERSIONS="{{ target_versions }}"

[ "$TARGET_VERSIONS" = "NOT_DEFINED" ] && TARGET_VERSIONS=""

if [ -z "$COMPOSE_PROJECT" ] || [ "$COMPOSE_PROJECT" = "NOT_DEFINED" ]; then
  echo "No compose_project set, skipping docker pre-pull" >&2
  exit 0
fi

COMPOSE_DIR="/opt/docker-compose/$COMPOSE_PROJECT"
COMPOSE_FILE=""

# Find the compose file
for f in "$COMPOSE_DIR/docker-compose.yml" "$COMPOSE_DIR/docker-compose.yaml" "$COMPOSE_DIR/compose.yml" "$COMPOSE_DIR/compose.yaml"; do
  if [ -f "$f" ]; then
    COMPOSE_FILE="$f"
    break
  fi
done

if [ -z "$COMPOSE_FILE" ]; then
  echo "No docker-compose file found in $COMPOSE_DIR, skipping pre-pull" >&2
  exit 0
fi

# Check if docker is available
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not available in container, skipping pre-pull" >&2
  exit 0
fi

# Extract image names from compose file using grep (no YAML parser needed)
# Matches lines like:  image: nginx:latest  or  image: "ghcr.io/foo/bar:1.0"
IMAGES=$(grep -E '^\s+image:\s' "$COMPOSE_FILE" | sed -E 's/^\s+image:\s+//; s/^["'"'"']//; s/["'"'"']$//' | tr -d '\r')

if [ -z "$IMAGES" ]; then
  echo "No images found in $COMPOSE_FILE, skipping pre-pull" >&2
  exit 0
fi

PULL_COUNT=0
FAIL_COUNT=0

# Helper: resolve target version for a given image
resolve_image_version() {
  _img="$1"
  if [ -z "$TARGET_VERSIONS" ]; then
    echo "$_img"
    return
  fi
  # Extract short name from image (last segment before :tag)
  _base=$(echo "$_img" | sed -E 's/:[^/]*$//')
  _short=$(echo "$_base" | sed -E 's|.*/||')
  # Look up target version
  _target=$(echo "$TARGET_VERSIONS" | tr ',' '\n' | while IFS='=' read -r _svc _ver; do
    if [ "$_svc" = "$_short" ] && [ -n "$_ver" ]; then
      echo "$_ver"
      break
    fi
  done)
  if [ -n "$_target" ]; then
    echo "${_base}:${_target}"
  else
    echo "$_img"
  fi
}

echo "$IMAGES" | while IFS= read -r image; do
  [ -z "$image" ] && continue
  pull_image=$(resolve_image_version "$image")
  echo "Pre-pulling image: $pull_image" >&2
  if docker pull "$pull_image" >&2 2>&1; then
    PULL_COUNT=$((PULL_COUNT + 1))
  else
    echo "Warning: Failed to pull $pull_image (will be pulled during post_start)" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo "Docker pre-pull complete" >&2
exit 0
