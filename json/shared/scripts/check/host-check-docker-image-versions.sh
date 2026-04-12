#!/bin/sh
# Check that Docker containers are running expected image versions.
#
# Template variables:
#   vm_id              - Container VM ID
#   expected_versions  - Comma-separated service=version pairs
#                        e.g. "zitadel=v4.13.1,traefik=v3.6.13"
#
# For each expected pair, finds the running container whose image
# short name matches the service, then checks that the tag matches.
# Exit 1 on mismatch, exit 0 if all match.

VM_ID="{{ vm_id }}"
EXPECTED="{{ expected_versions }}"

if [ -z "$EXPECTED" ] || [ "$EXPECTED" = "NOT_DEFINED" ]; then
  echo "CHECK: image_versions SKIPPED (no expected_versions set)" >&2
  printf '[{"id":"check_image_versions","value":"skipped"}]'
  exit 0
fi

# Build format string (avoid {{ }} being treated as template vars)
LB='{''{'
RB='}''}'
DOCKER_FMT="${LB}.Image${RB}"

# Get all running images into a temp file
IMAGES_FILE=$(mktemp)
pct exec "$VM_ID" -- docker ps --format "$DOCKER_FMT" 2>/dev/null > "$IMAGES_FILE" || true

if [ ! -s "$IMAGES_FILE" ]; then
  echo "CHECK: image_versions FAILED (no running containers)" >&2
  printf '[{"id":"check_image_versions","value":"no containers"}]'
  rm -f "$IMAGES_FILE"
  exit 1
fi

echo "Running images:" >&2
cat "$IMAGES_FILE" >&2

failed=0
checked=0

# Parse expected_versions: "svc1=ver1,svc2=ver2"
# Replace commas with newlines for iteration
PAIRS_FILE=$(mktemp)
echo "$EXPECTED" | tr ',' '\n' > "$PAIRS_FILE"

while IFS= read -r pair; do
  svc=$(echo "$pair" | cut -d'=' -f1 | tr -d ' ')
  ver=$(echo "$pair" | cut -d'=' -f2 | tr -d ' ')

  [ -z "$svc" ] && continue
  [ -z "$ver" ] && continue

  # Find image matching this service name
  # Match: image short name (last path component before :) equals svc
  # e.g. ghcr.io/zitadel/zitadel:v4.13.1 -> short name "zitadel"
  # e.g. traefik:v3.6.13 -> short name "traefik"
  matched_image=$(sed -n "s|.*/${svc}:.*|&|p" "$IMAGES_FILE" | head -1)
  if [ -z "$matched_image" ]; then
    # Try without registry prefix (e.g. traefik:v3.6)
    matched_image=$(grep "^${svc}:" "$IMAGES_FILE" | head -1)
  fi

  if [ -z "$matched_image" ]; then
    echo "CHECK: image_versions FAILED - no running container for service '$svc'" >&2
    failed=$((failed + 1))
    checked=$((checked + 1))
    continue
  fi

  # Extract tag from matched image
  actual_tag=$(echo "$matched_image" | sed 's|.*:||')

  if [ "$actual_tag" = "$ver" ]; then
    echo "CHECK: $svc version OK ($actual_tag)" >&2
  else
    echo "CHECK: $svc version MISMATCH (expected=$ver actual=$actual_tag image=$matched_image)" >&2
    failed=$((failed + 1))
  fi
  checked=$((checked + 1))
done < "$PAIRS_FILE"

rm -f "$IMAGES_FILE" "$PAIRS_FILE"

if [ "$failed" -gt 0 ]; then
  echo "CHECK: image_versions FAILED ($failed/$checked mismatches)" >&2
  printf '[{"id":"check_image_versions","value":"failed: %d/%d mismatches"}]' "$failed" "$checked"
  exit 1
fi

echo "CHECK: image_versions PASSED ($checked services verified)" >&2
printf '[{"id":"check_image_versions","value":"all %d versions match"}]' "$checked"
exit 0
