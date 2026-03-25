#!/bin/sh
# Get latest OS template for Proxmox
#
# This script downloads the latest OS template by:
# 1. Finding the latest template matching the specified OS type
# 2. Checking if template is already present in local storage
# 3. Downloading template if not present
#
# Requires:
#   - ostype: Operating system type (e.g., alpine, debian, ubuntu) (from context)
#   - storage: Storage name (optional, defaults to "local")
#
# Output: JSON to stdout (errors to stderr)
# Note: Do NOT use exec >&2 here, as it redirects ALL stdout to stderr, including JSON output

# Name of the local storage
STORAGE="local"
# Template keyword
OSTYPE={{ ostype }}
# Deployer version (auto-injected by backend)
OCI_IMAGE_TAG={{ oci_image_tag }}
# Fallback if version could not be resolved (rate limit, missing labels)
if [ -z "$OCI_IMAGE_TAG" ] || [ "$OCI_IMAGE_TAG" = "NOT_DEFINED" ] || [ "$OCI_IMAGE_TAG" = "unknown" ]; then
  OCI_IMAGE_TAG="latest"
fi

# Find the latest OSTYPE template from the list of available templates
TEMPLATE=$(pveam available 2>&1 | awk -v OSTYPE="$OSTYPE" 'index($2, OSTYPE)==1 {print $2}' | sort -V | tail -n 1)
if [ -z "$TEMPLATE" ]; then
  echo "No $OSTYPE template found!" >&2
  exit 1
fi

# Check if the template is already present in local storage
if pveam list $STORAGE 2>&1 | grep -q "$TEMPLATE"; then
  echo "Template $TEMPLATE is already present in local storage." >&2
else
  echo "Downloading $TEMPLATE..." >&2
  if ! pveam download $STORAGE "$TEMPLATE" >&2; then
    echo "Error: Failed to download template $TEMPLATE" >&2
    exit 1
  fi
fi

# Verify template is now available
template_path=$(pveam list $STORAGE 2>&1 | awk -v T="$TEMPLATE" '$1 ~ T {print $1}')
if [ -z "$template_path" ]; then
  echo "Error: Template $TEMPLATE not found in storage $STORAGE after download" >&2
  exit 1
fi

# Output the template path and version in JSON format to stdout
echo '[{"id":"template_path","value":"'$template_path'"},{"id":"oci_image_tag","value":"'$OCI_IMAGE_TAG'"}]'