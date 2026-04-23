#!/bin/sh
set -e

owner="proxvex"
repo="proxvex"

# Check if wget is available
if ! command -v wget >/dev/null 2>&1; then
  echo "Error: wget command not found" >&2
  exit 1
fi

# Check DNS resolution for api.github.com
if ! getent hosts api.github.com >/dev/null 2>&1; then
  echo "Error: DNS resolution failed for api.github.com. Check network connectivity and DNS configuration." >&2
  exit 1
fi

# Fetch GitHub API response with timeout and retry
API_URL="https://api.github.com/repos/$owner/$repo/releases/latest"
API_RESPONSE=""
RETRY_COUNT=0
MAX_RETRIES=3

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  API_RESPONSE=$(wget --timeout=10 --tries=1 -q -O - "$API_URL" 2>&1) && break
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
    sleep 2
  fi
done

if [ -z "$API_RESPONSE" ] || echo "$API_RESPONSE" | grep -q "bad address\|Connection refused\|Network is unreachable\|Name or service not known"; then
  echo "Error: Failed to fetch GitHub API after $MAX_RETRIES attempts: $API_RESPONSE" >&2
  exit 1
fi

# Extract package URL from API response
packagerurl=$(echo "$API_RESPONSE" | \
  awk '
    /"name":/ && /x86_64\.apk"/ { found=1 }
    found && /"browser_download_url":/ {
      gsub(/.*: *"/, "", $0)
      gsub(/",?$/, "", $0)
      print $0
      exit
    }
  ')

# Validate that package URL was found
if [ -z "$packagerurl" ] || [ "$packagerurl" = "" ]; then
  echo "Error: Failed to extract package URL from GitHub API response" >&2
  exit 1
fi

# Set public key URL
packagerpubkeyurl="https://github.com/$owner/$repo/releases/latest/download/packager.rsa.pub"

# Output JSON (only on success)
echo '[{ "id": "packageurl", "value": "'$packagerurl'" }, { "id": "packagerpubkeyurl", "value": "'$packagerpubkeyurl'" }]'