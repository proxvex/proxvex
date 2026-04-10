#!/bin/sh
# Upload Addon Configuration Files
#
# This script uploads addon configuration files to volume directories
# before the container starts. It uses the upload-file-common.sh library.
#
# Template variables:
#   addon_content  - Base64 encoded file content
#   addon_path     - Target path (volume_key:filename)
#   shared_volpath - Base path for volumes
#   hostname       - Container hostname
#   uid, gid       - File ownership
#   mapped_uid, mapped_gid - Host-mapped ownership

# Library functions are prepended automatically:
# - upload_pre_start_file()
# - upload_output_result()

# Get template variables
ADDON_CONTENT="{{ addon_content }}"
ADDON_PATH="{{ addon_path }}"
HOSTNAME="{{ hostname }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

# Upload the addon configuration file
upload_pre_start_file \
  "$ADDON_CONTENT" \
  "$ADDON_PATH" \
  "Addon configuration" \
  "$HOSTNAME" \
  "$UID_VAL" \
  "$GID_VAL" \
  "$MAPPED_UID" \
  "$MAPPED_GID"

# Output result
upload_output_result "addon_file_uploaded"
