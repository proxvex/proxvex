#!/bin/sh
# Write modbus2mqtt YAML config into the managed `config` volume before
# the LXC starts. Replaces the REST-upload pattern that failed because
# modbus2mqtt only exposes its admin HTTPS endpoint *after* a config file
# is loaded — so /api/health never came up to receive the upload.
set -eu

upload_pre_start_file \
  "{{ upload_modbus2mqtt_config_content }}" \
  "config:modbus2mqtt/modbus2mqtt.yaml" \
  "modbus2mqtt config" \
  "{{ hostname }}" \
  "{{ uid }}" \
  "{{ gid }}" \
  "{{ mapped_uid }}" \
  "{{ mapped_gid }}" \
  "{{ vm_id }}"

upload_output_result "modbus2mqtt_config_written"
