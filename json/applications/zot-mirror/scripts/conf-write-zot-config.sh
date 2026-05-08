#!/bin/sh
# conf-write-zot-config.sh — Write the deploy-time zot_config parameter
# into /etc/zot/config.json (host-side path of the LXC's `config` volume)
# before the zot container starts. zot reads this file at boot.
#
# Inputs (template variables):
#   hostname      - Container hostname (used for volume resolution)
#   vm_id         - LXC VMID (anchors the lookup to this container's volumes)
#   zot_config    - Full zot config.json content as a multi-line string;
#                   default is set in json/applications/zot-mirror/application.json,
#                   user-overridable via the deploy form's Advanced section.
#
# Output: JSON to stdout (errors to stderr)
#   zot_config_written: "true" on success
#
# Runs on the PVE host (execute_on: ve). Uses resolve_host_volume from
# ve-global.sh (auto-sourced for ve-context scripts) to find the host-side
# mountpoint of the `config` volume — same pattern as conf-setup-oidc-client.sh.

set -e

HOSTNAME="{{ hostname }}"
VMID="{{ vm_id }}"

if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "NOT_DEFINED" ]; then
    echo "ERROR: hostname required" >&2
    echo '[]'
    exit 1
fi
if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
    echo "ERROR: vm_id required" >&2
    echo '[]'
    exit 1
fi

CONFIG_DIR=$(resolve_host_volume "$HOSTNAME" "config" "$VMID") || {
    echo "ERROR: cannot resolve config volume for $HOSTNAME (vmid=$VMID)" >&2
    echo '[]'
    exit 1
}
mkdir -p "$CONFIG_DIR"

# A quoted heredoc preserves the substituted content verbatim — no $-expansion,
# no backslash interpretation. proxvex has already replaced {{ zot_config }}
# with the deploy-param value before shipping this script to the ve.
cat > "$CONFIG_DIR/config.json" <<'ZOT_CONFIG_EOF'
{{ zot_config }}
ZOT_CONFIG_EOF

chmod 644 "$CONFIG_DIR/config.json"

# Sanity-check the result is parseable JSON. zot would fail to start
# silently otherwise (logs the error inside the LXC, but the deploy step
# would just see a non-responsive container).
if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import json,sys; json.load(open('$CONFIG_DIR/config.json'))" 2>/dev/null; then
        echo "ERROR: rendered $CONFIG_DIR/config.json is not valid JSON — check the zot_config parameter" >&2
        echo '[]'
        exit 1
    fi
elif command -v jq >/dev/null 2>&1; then
    if ! jq -e . "$CONFIG_DIR/config.json" >/dev/null 2>&1; then
        echo "ERROR: rendered $CONFIG_DIR/config.json is not valid JSON — check the zot_config parameter" >&2
        echo '[]'
        exit 1
    fi
fi

echo "Wrote zot config: $CONFIG_DIR/config.json ($(wc -c < "$CONFIG_DIR/config.json") bytes)" >&2

cat <<EOF
[
  {"id": "zot_config_written", "value": "true"}
]
EOF
