#!/usr/bin/env python3
"""Update LXC container notes with addon marker.

Adds or removes an addon marker in an existing LXC container's notes/description.
Runs on the Proxmox VE host.

Parameters (via template substitution):
  vm_id        - Container ID
  addon_id     - Addon identifier (e.g., "samba-shares")
  addon_action - "add" (default) or "remove"

Output:
  JSON with { "id": "success", "value": "true" } on success

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Note: Do NOT add "from __future__ import annotations" here - it's already in the library
and must be at the very beginning of the combined file.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, unquote

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig
# - ADDON_MARKER_RE, etc.


def get_param(name: str) -> str | None:
    """Get template parameter value, returns None if NOT_DEFINED."""
    val = "{{ " + name + " }}"
    # If template wasn't processed, the literal {{ name }} remains
    if val.startswith("{{") and val.endswith("}}"):
        return None
    if val == "NOT_DEFINED" or val == "":
        return None
    return val


def read_config_file(vm_id: str) -> str:
    """Read the LXC config file content."""
    config_path = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc")) / f"{vm_id}.conf"
    if not config_path.exists():
        raise FileNotFoundError(f"Container config not found: {config_path}")
    return config_path.read_text(encoding="utf-8", errors="replace")


def extract_description_from_config(conf_text: str) -> str:
    """Extract the description field from config, URL-decoded."""
    match = re.search(r"^description:\s*(.*)$", conf_text, re.MULTILINE)
    if not match:
        return ""

    raw_desc = match.group(1)
    # Proxmox encodes newlines as literal \n and URL-encodes special chars
    normalized = raw_desc.replace("\\n", "\n")
    decoded = unquote(normalized)
    return decoded


def build_addon_marker(addon_id: str) -> str:
    """Build the addon marker comment."""
    return f"<!-- oci-lxc-deployer:addon {addon_id} -->"


def insert_addon_marker(description: str, addon_id: str) -> str:
    """Insert addon marker into description if not already present."""
    marker = build_addon_marker(addon_id)

    # Check if marker already exists
    if f"oci-lxc-deployer:addon {addon_id}" in description:
        return description  # Already present

    lines = description.split("\n")
    result_lines = []
    marker_inserted = False

    for line in lines:
        # Insert before first ## header (visible section)
        if not marker_inserted and line.strip().startswith("##"):
            result_lines.append(marker)
            marker_inserted = True
        result_lines.append(line)

    # If no ## header found, insert before visible content or at end
    if not marker_inserted:
        # Find last marker comment and insert after it
        last_marker_idx = -1
        for i, line in enumerate(result_lines):
            if "oci-lxc-deployer:" in line and line.strip().startswith("<!--"):
                last_marker_idx = i

        if last_marker_idx >= 0:
            result_lines.insert(last_marker_idx + 1, marker)
        else:
            # No markers found, prepend to start
            result_lines.insert(0, marker)

    return "\n".join(result_lines)


def remove_addon_marker(description: str, addon_id: str) -> str:
    """Remove addon marker from description if present."""
    marker_text = f"oci-lxc-deployer:addon {addon_id}"

    if marker_text not in description:
        return description  # Not present, nothing to do

    lines = description.split("\n")
    result_lines = [line for line in lines if marker_text not in line]
    return "\n".join(result_lines)


def update_container_description(vm_id: str, new_description: str) -> None:
    """Update the container description using pct set."""
    result = subprocess.run(
        ["pct", "set", vm_id, "--description", new_description],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pct set failed: {result.stderr}")


def main() -> None:
    vm_id = get_param("vm_id")
    addon_id = get_param("addon_id")
    addon_action = get_param("addon_action") or "add"

    if not vm_id:
        print("Error: vm_id is required", file=sys.stderr)
        sys.exit(1)

    if not addon_id:
        print("Error: addon_id is required", file=sys.stderr)
        sys.exit(1)

    try:
        # Read current config
        conf_text = read_config_file(vm_id)

        # Extract and decode description
        current_desc = extract_description_from_config(conf_text)

        if addon_action == "remove":
            # Remove addon marker
            if f"oci-lxc-deployer:addon {addon_id}" not in current_desc:
                print(f"Addon marker not found for {addon_id}, skipping", file=sys.stderr)
                print(json.dumps([{"id": "success", "value": "true"}]))
                return

            new_desc = remove_addon_marker(current_desc, addon_id)
            update_container_description(vm_id, new_desc)
            print(f"Removed addon marker for {addon_id} from container {vm_id}", file=sys.stderr)

        else:
            # Add addon marker (default)
            if f"oci-lxc-deployer:addon {addon_id}" in current_desc:
                print(f"Addon marker already exists for {addon_id}, skipping", file=sys.stderr)
                print(json.dumps([{"id": "success", "value": "true"}]))
                return

            new_desc = insert_addon_marker(current_desc, addon_id)
            update_container_description(vm_id, new_desc)
            print(f"Added addon marker for {addon_id} to container {vm_id}", file=sys.stderr)

        print(json.dumps([{"id": "success", "value": "true"}]))

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
