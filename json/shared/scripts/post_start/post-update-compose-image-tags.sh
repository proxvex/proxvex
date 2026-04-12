#!/bin/sh
# Update Docker Compose image tags in-place on the persistent volume.
#
# Reads the existing docker-compose.yaml, updates image tags based on
# target_versions parameter, and writes it back. All other content
# (hardening changes, env vars, volumes, etc.) is preserved.
#
# Runs inside the LXC container (execute_on: lxc).
#
# Requires:
#   - target_versions: Comma-separated "service=version" pairs
#                      (e.g. "traefik=v3.7,zitadel=v4.13.0")
#   - compose_project: Docker Compose project name
#
# Output: JSON to stdout (errors to stderr)

set -eu

TARGET_VERSIONS="{{ target_versions }}"
COMPOSE_PROJECT="{{ compose_project }}"

if [ -z "$TARGET_VERSIONS" ] || [ "$TARGET_VERSIONS" = "NOT_DEFINED" ]; then
  echo "No target_versions set, skipping" >&2
  printf '[{"id":"image_tags_updated","value":"false"}]'
  exit 0
fi

# Fallback: use container hostname as compose_project
if [ -z "$COMPOSE_PROJECT" ] || [ "$COMPOSE_PROJECT" = "NOT_DEFINED" ]; then
  COMPOSE_PROJECT=$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || true)
fi
if [ -z "$COMPOSE_PROJECT" ] || [ "$COMPOSE_PROJECT" = "NOT_DEFINED" ]; then
  echo "No compose_project set, skipping" >&2
  printf '[{"id":"image_tags_updated","value":"false"}]'
  exit 0
fi

PROJECT_DIR="/opt/docker-compose/$COMPOSE_PROJECT"

# Find compose file
COMPOSE_FILE=""
for name in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
  if [ -f "$PROJECT_DIR/$name" ]; then
    COMPOSE_FILE="$PROJECT_DIR/$name"
    break
  fi
done

if [ -z "$COMPOSE_FILE" ]; then
  echo "ERROR: No compose file found in $PROJECT_DIR" >&2
  exit 1
fi

echo "Updating image tags in $COMPOSE_FILE" >&2

# Process each service=version pair
TMPFILE=$(mktemp)
cp "$COMPOSE_FILE" "$TMPFILE"

IFS=','
for pair in $TARGET_VERSIONS; do
  svc=$(echo "$pair" | cut -d'=' -f1 | tr -d ' ')
  ver=$(echo "$pair" | cut -d'=' -f2 | tr -d ' ')
  [ -z "$svc" ] && continue
  [ -z "$ver" ] && continue

  # Match image lines containing the service name and replace the tag
  # Handles: image: traefik:v3.6
  #          image: ghcr.io/zitadel/zitadel:v4.12.3
  # Sed pattern: find lines with "image:" containing "/<svc>:" or "^<svc>:",
  # then replace the tag portion
  if grep -q "image:.*/${svc}:" "$TMPFILE" 2>/dev/null; then
    # Image with registry prefix: ghcr.io/org/svc:tag
    old_image=$(grep "image:.*/${svc}:" "$TMPFILE" | head -1 | sed 's/.*image:[[:space:]]*//' | tr -d "'" | tr -d '"' | tr -d ' ')
    new_image=$(echo "$old_image" | sed "s|/${svc}:.*|/${svc}:${ver}|")
    # Escape slashes for sed
    old_escaped=$(echo "$old_image" | sed 's|/|\\/|g; s|\\.|\\\\.|g')
    new_escaped=$(echo "$new_image" | sed 's|/|\\/|g')
    sed -i "s|${old_image}|${new_image}|g" "$TMPFILE"
    echo "  Updated $svc: $old_image -> $new_image" >&2
  elif grep -q "image:[[:space:]]*${svc}:" "$TMPFILE" 2>/dev/null; then
    # Image without prefix: svc:tag
    sed -i "s|image:\([[:space:]]*\)${svc}:[^[:space:]\"']*|image:\1${svc}:${ver}|g" "$TMPFILE"
    echo "  Updated $svc to ${ver}" >&2
  else
    echo "  Warning: No image found for service '$svc'" >&2
  fi
done

cp "$TMPFILE" "$COMPOSE_FILE"
rm -f "$TMPFILE"

echo "Image tags updated successfully" >&2
printf '[{"id":"image_tags_updated","value":"true"}]'
