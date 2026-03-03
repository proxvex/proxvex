#!/bin/sh
# Upgrade an LXC container in-place using a new OCI image.
#
# Unlike copy-upgrade, this upgrades the SAME container (source_vm_id == target vm_id).
# No new VMID is allocated.
#
# Steps:
# 1) Verify container exists and was created by oci-lxc-deployer (marker in description/notes).
# 2) Set TARGET_VMID = SOURCE_VMID (in-place).
# 3) Extract installed addons from notes.
# 4) Output vm_id and installed_addons for subsequent steps.
#
# Inputs (templated):
#   - source_vm_id (required)
#   - template_path (required; from 011-get-oci-image.json)
#   - ostype (optional; from 011-get-oci-image.json)
#   - oci_image (required; from 011-get-oci-image.json)
#
# Output:
#   - JSON to stdout: [{"id":"vm_id","value":"<vmid>"}, {"id":"installed_addons","value":"<addons>"}]

set -eu

SOURCE_VMID="{{ source_vm_id }}"
TEMPLATE_PATH="{{ template_path }}"
OCI_IMAGE_RAW="{{ oci_image }}"

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "source_vm_id is required"
fi

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Container config not found: $SOURCE_CONF"
fi

if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  fail "template_path is missing (expected from 011-get-oci-image.json)"
fi

SOURCE_DESC=$(extract_description "$SOURCE_CONF")
SOURCE_CONF_TEXT=$(cat "$SOURCE_CONF" 2>/dev/null || echo "")
SOURCE_DESC_DECODED=$(decode_url "$SOURCE_DESC")
SOURCE_CONF_TEXT_DECODED=$(decode_url "$SOURCE_CONF_TEXT")

if ! check_managed_marker "$SOURCE_DESC" "$SOURCE_DESC_DECODED" "$SOURCE_CONF_TEXT" "$SOURCE_CONF_TEXT_DECODED"; then
  fail "Container does not look like it was created by oci-lxc-deployer (missing notes marker)."
fi

# In-place upgrade: target is the same container
TARGET_VMID="$SOURCE_VMID"
log "In-place upgrade prepared: vm_id=$TARGET_VMID"

INSTALLED_ADDONS=$(extract_addons "$SOURCE_DESC$SOURCE_CONF_TEXT")
log "Installed addons: $INSTALLED_ADDONS"

printf '[{ "id": "vm_id", "value": "%s" }, { "id": "installed_addons", "value": "%s" }]' "$TARGET_VMID" "$INSTALLED_ADDONS"
