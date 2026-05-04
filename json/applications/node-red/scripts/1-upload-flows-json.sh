#!/bin/sh
# Upload file: flows.json (optional)
set -eu

upload_pre_start_file \
  "{{ upload_flows_json_content }}" \
  "{{ upload_flows_json_destination }}" \
  "flows.json" \
  "{{ hostname }}" \
  "{{ uid }}" \
  "{{ gid }}" \
  "{{ mapped_uid }}" \
  "{{ mapped_gid }}" \
  "{{ vm_id }}"

upload_output_result "upload_flows_json_uploaded"
