#!/bin/sh
# Write modbus2mqtt configuration into the managed `config` volume before
# the LXC starts. Replaces the REST-upload pattern that failed because
# modbus2mqtt only exposes its admin HTTPS endpoint *after* a config file
# is loaded — so /api/health never came up to receive the upload.
#
# Content can be either:
#   - a single YAML file → written to config/modbus2mqtt/modbus2mqtt.yaml
#   - a ZIP archive      → extracted into the config volume root (typically
#                          containing modbus2mqtt.yaml + busses/ + specifications/)
# Detection is by PK magic bytes after base64 decode.
set -eu

_content_b64="{{ upload_modbus2mqtt_config_content }}"

if [ -z "$_content_b64" ] || [ "$_content_b64" = "NOT_DEFINED" ]; then
  echo "no upload content, skipping" >&2
  echo '[{"id":"modbus2mqtt_config_written","value":"false"}]'
  exit 0
fi

_tmp=$(mktemp)
trap 'rm -f "$_tmp"' EXIT
printf '%s' "$_content_b64" | base64 -d > "$_tmp"

# Detect ZIP by magic bytes (PK\x03\x04)
_magic=$(dd if="$_tmp" bs=1 count=2 2>/dev/null)
if [ "$_magic" = "PK" ]; then
  # When this runs during an upgrade (previous_vm_id is set and differs from
  # vm_id), 150-conf-create-storage-volumes-for-lxc names the new container's
  # mp* volumes after the PREVIOUS container's hostname — i.e. CT 211's
  # config volume is `subvol-211-modbus2mqtt-default-config`, NOT
  # `subvol-211-modbus2mqtt-upgrade-config`. resolve_host_volume keys on the
  # hostname argument, so it would fail with the scenario's planner-hostname
  # ("modbus2mqtt-upgrade") on an upgrade. Read previous's hostname from pct
  # config and prefer it when it differs from the scenario's hostname.
  _effective_host="{{ hostname }}"
  _prev_vmid="{{ previous_vm_id }}"
  if [ -n "$_prev_vmid" ] && [ "$_prev_vmid" != "NOT_DEFINED" ] && [ "$_prev_vmid" != "{{ vm_id }}" ]; then
    _prev_host=$(pct config "$_prev_vmid" 2>/dev/null | awk '/^hostname:/ {print $2; exit}' || true)
    if [ -n "$_prev_host" ] && [ "$_prev_host" != "$_effective_host" ]; then
      echo "Upgrade: using previous container's hostname '$_prev_host' for volume lookup (planner hostname was '$_effective_host')" >&2
      _effective_host="$_prev_host"
    fi
  fi
  _safe_host=$(upload_sanitize_name "$_effective_host")
  _config_dir=$(resolve_host_volume "$_safe_host" "config" "{{ vm_id }}")
  if [ ! -d "$_config_dir" ]; then
    echo "ERROR: config volume directory '$_config_dir' not found" >&2
    exit 1
  fi
  # modbus2mqtt reads from ${configDir}/modbus2mqtt/ — mirror what
  # POST /api/upload/local + Config.importLocalZip do in the running app.
  _target_dir="${_config_dir}/modbus2mqtt"
  mkdir -p "$_target_dir"

  echo "Extracting modbus2mqtt config ZIP into $_target_dir" >&2
  python3 - "$_tmp" "$_target_dir" <<'PY'
import sys, zipfile, os
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    z.extractall(dest)
PY

  # chown to mapped UID/GID so the container's modbus2mqtt user can read
  _uid="{{ mapped_uid }}"
  _gid="{{ mapped_gid }}"
  [ -z "$_uid" ] || [ "$_uid" = "NOT_DEFINED" ] && _uid="{{ uid }}"
  [ -z "$_gid" ] || [ "$_gid" = "NOT_DEFINED" ] && _gid="{{ gid }}"
  if [ -n "$_uid" ] && [ -n "$_gid" ] && [ "$_uid" != "NOT_DEFINED" ] && [ "$_gid" != "NOT_DEFINED" ]; then
    chown -R "$_uid:$_gid" "$_target_dir" 2>/dev/null || true
  fi

  echo '[{"id":"modbus2mqtt_config_written","value":"true"}]'
  exit 0
fi

# Plain YAML fallback — write as single modbus2mqtt.yaml
upload_pre_start_file \
  "$_content_b64" \
  "config:modbus2mqtt/modbus2mqtt.yaml" \
  "modbus2mqtt config" \
  "{{ hostname }}" \
  "{{ uid }}" \
  "{{ gid }}" \
  "{{ mapped_uid }}" \
  "{{ mapped_gid }}" \
  "{{ vm_id }}"

upload_output_result "modbus2mqtt_config_written"
