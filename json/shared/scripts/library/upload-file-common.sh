#!/bin/sh
# Upload File Common Library
#
# This library provides functions for uploading configuration files to
# volume directories BEFORE container start.
#
# Paths use format: {volume_key}:{filename}
# Example: samba_config:smb.conf -> ${shared_volpath}/volumes/${hostname}/samba-config/smb.conf
#
# Main functions:
#   1. upload_is_defined - Check if value is defined and not empty
#   2. upload_sanitize_name - Sanitize name for filesystem
#   3. upload_pre_start_file - Write a single file to volume directory
#   4. upload_output_result - Generate JSON output for template
#
# Global state variables:
#   UPLOAD_FILES_WRITTEN - Counter for files written
#
# This library is automatically prepended to scripts that require
# file upload functionality.

# ============================================================================
# GLOBAL STATE
# ============================================================================
UPLOAD_FILES_WRITTEN=0

# ============================================================================
# 1. upload_is_defined()
# Check if value is defined and not empty
# Arguments: value
# Returns: 0 if defined, 1 if empty or NOT_DEFINED
# ============================================================================
upload_is_defined() {
  [ -n "$1" ] && [ "$1" != "NOT_DEFINED" ]
}

# ============================================================================
# 2. upload_sanitize_name()
# Sanitize name for filesystem (lowercase, replace non-alphanumeric with dash)
# Arguments: name
# Returns: sanitized name via stdout
# ============================================================================
upload_sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# ============================================================================
# 3. upload_pre_start_file()
# Write a single file to volume directory
# Arguments:
#   $1 - content: Base64 encoded file content
#   $2 - destination: Target path in format {volume_key}:{filename}
#   $3 - label: Human-readable label for logging
#   $4 - hostname: Container hostname
#   $5 - uid: User ID for file ownership (default: 0)
#   $6 - gid: Group ID for file ownership (default: 0)
#   $7 - mapped_uid: Mapped UID on host (optional)
#   $8 - mapped_gid: Mapped GID on host (optional)
# Returns: 0 on success, 1 if skipped or error
# ============================================================================
upload_pre_start_file() {
  _content="$1"
  _destination="$2"
  _label="$3"
  _hostname="$4"
  _uid="${5:-0}"
  _gid="${6:-0}"
  _mapped_uid="${7:-}"
  _mapped_gid="${8:-}"

  # Validate content and destination
  if ! upload_is_defined "$_content" || ! upload_is_defined "$_destination"; then
    return 0  # Skip silently if not defined
  fi

  # Validate required parameters
  if ! upload_is_defined "$_hostname"; then
    echo "hostname not defined - cannot upload $_label" >&2
    return 1
  fi

  # Calculate effective UID/GID (prefer mapped values)
  _effective_uid="$_uid"
  _effective_gid="$_gid"
  if upload_is_defined "$_mapped_uid"; then
    _effective_uid="$_mapped_uid"
  fi
  if upload_is_defined "$_mapped_gid"; then
    _effective_gid="$_mapped_gid"
  fi

  _safe_host=$(upload_sanitize_name "$_hostname")

  # Handle path format
  case "$_destination" in
    *:*)
      # Format: {volume_key}:{filename}
      _volume_key=$(echo "$_destination" | cut -d':' -f1)
      _filename=$(echo "$_destination" | cut -d':' -f2-)

      if [ -z "$_volume_key" ] || [ -z "$_filename" ]; then
        echo "Warning: Invalid path format '$_destination' for $_label, skipping" >&2
        return 1
      fi

      # Compute target directory
      _safe_key=$(upload_sanitize_name "$_volume_key")
      _target_dir=$(resolve_host_volume "$_safe_host" "$_safe_key")
      _target_path="${_target_dir}/${_filename}"

      # Verify directory exists (should have been created by template 150)
      if [ ! -d "$_target_dir" ]; then
        echo "Warning: Volume directory '$_target_dir' not found for $_label, skipping" >&2
        return 1
      fi

      # Skip if file already exists (preserve existing configuration)
      if [ -f "$_target_path" ]; then
        echo "Skipping $_label: $_target_path already exists" >&2
        return 0
      fi

      # Create subdirectories if filename contains path separators
      _target_subdir=$(dirname "$_target_path")
      if [ "$_target_subdir" != "$_target_dir" ]; then
        mkdir -p "$_target_subdir"
        if upload_is_defined "$_effective_uid" && upload_is_defined "$_effective_gid"; then
          chown "$_effective_uid:$_effective_gid" "$_target_subdir" 2>/dev/null || true
        fi
      fi

      # Decode and write file
      echo "Writing $_label to $_target_path..." >&2
      echo "$_content" | base64 -d > "$_target_path"
      if upload_is_defined "$_effective_uid" && upload_is_defined "$_effective_gid"; then
        chown "$_effective_uid:$_effective_gid" "$_target_path" 2>/dev/null || true
      fi
      echo "  Success: $_target_path" >&2
      UPLOAD_FILES_WRITTEN=$((UPLOAD_FILES_WRITTEN + 1))
      return 0
      ;;
    /*)
      # Absolute path - skip, should be handled post-start
      echo "Note: Absolute path '$_destination' for $_label will be handled post-start" >&2
      return 1
      ;;
    *)
      echo "Warning: Unrecognized path format '$_destination' for $_label, skipping" >&2
      return 1
      ;;
  esac
}

# ============================================================================
# 4. upload_output_result()
# Generate JSON output for template
# Arguments:
#   $1 - output_id: ID for the output parameter (default: "file_uploaded")
# Returns: JSON array via stdout
# ============================================================================
upload_output_result() {
  _output_id="${1:-file_uploaded}"
  if [ "$UPLOAD_FILES_WRITTEN" -gt 0 ]; then
    echo "[{\"id\":\"$_output_id\",\"value\":\"true\"}]"
  else
    echo "[{\"id\":\"$_output_id\",\"value\":\"false\"}]"
  fi
}
