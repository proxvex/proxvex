#!/usr/bin/env python3
"""Update LXC notes version from the actual Docker image after pull.

Identifies the main service image by matching the application_id
against the image name (between "/" and ":").

Selection rules:
1. Exact match: text after last "/" and before ":" equals application_id
2. Contains: text after last "/" and before ":" contains application_id (unique match)
3. Fallback: "unknown"

Version source: OCI label org.opencontainers.image.version, fallback to image tag.

Requires lxc_config_parser_lib.py to be prepended via library parameter.
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, unquote

# Template variables
VM_ID_RAW = "{{ vm_id }}"
APP_ID_RAW = "{{ application_id }}"


def _normalize(val: str) -> str | None:
    if not val or val == "NOT_DEFINED":
        return None
    return val.strip()


def docker_exec(vmid: str, cmd: str) -> str | None:
    """Run a command inside the container's docker."""
    try:
        result = subprocess.run(
            ["pct", "exec", vmid, "--", *cmd.split()],
            capture_output=True, text=True, timeout=15,
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        return None


def find_main_image(vmid: str, app_id: str) -> str | None:
    """Find the main Docker image matching the application_id."""
    output = docker_exec(vmid, "docker images --format {{.Repository}}:{{.Tag}}")
    if not output:
        return None

    images = [line for line in output.split("\n") if line and "<none>" not in line]

    # Rule 1: exact match — name after last "/" and before ":" equals app_id
    for img in images:
        name_part = img.rsplit("/", 1)[-1].split(":")[0]
        if name_part == app_id:
            return img

    # Rule 2: contains app_id (must be unique)
    matches = []
    for img in images:
        name_part = img.rsplit("/", 1)[-1].split(":")[0]
        if app_id in name_part:
            matches.append(img)
    if len(matches) == 1:
        return matches[0]

    # Rule 3: no match
    return None


def get_version(vmid: str, image: str) -> str:
    """Get version using oci_version_lib (labels, tag, digest matching).

    Also tries docker inspect inside the container as first attempt,
    since the local image may have labels not visible to skopeo.
    """
    # Try OCI label via docker inspect inside container first
    label = docker_exec(
        vmid,
        f"docker inspect {image} --format {{{{index .Config.Labels \"org.opencontainers.image.version\"}}}}",
    )
    if label and label != "<no value>":
        return label

    # Delegate to oci_version_lib (labels, tag, digest matching via skopeo)
    return resolve_image_version(image)


def update_notes_version(vmid: str, version: str) -> None:
    """Update the version marker in LXC notes."""
    conf_path = Path(f"/etc/pve/lxc/{vmid}.conf")
    if not conf_path.exists():
        return

    conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
    config = parse_lxc_config(conf_text)

    if config.version == version:
        print(f"Version already up to date: {version}", file=sys.stderr)
        return

    # Replace version in the URL-encoded description
    encoded_old = "oci-lxc-deployer%%3Aversion %s" % quote(config.version or "", safe="")
    encoded_new = "oci-lxc-deployer%%3Aversion %s" % quote(version, safe="")

    if encoded_old in conf_text:
        conf_text = conf_text.replace(encoded_old, encoded_new)
    elif "oci-lxc-deployer%3Aversion" in conf_text:
        # Fallback: regex replace
        conf_text = re.sub(
            r"oci-lxc-deployer%3Aversion\s+[^\s<]+",
            "oci-lxc-deployer%%3Aversion %s" % quote(version, safe=""),
            conf_text,
        )

    conf_path.write_text(conf_text, encoding="utf-8")
    print(f"Updated version in LXC notes: {version}", file=sys.stderr)


def main() -> None:
    vmid = _normalize(VM_ID_RAW)
    app_id = _normalize(APP_ID_RAW)

    if not vmid or not app_id:
        print(json.dumps([]))
        return

    image = find_main_image(vmid, app_id)
    if not image:
        print(f"Could not identify main image for {app_id}", file=sys.stderr)
        print(json.dumps([{"id": "app_version", "value": "unknown"}]))
        return

    print(f"Main image: {image}", file=sys.stderr)

    version = get_version(vmid, image)
    print(f"Resolved version: {version}", file=sys.stderr)

    update_notes_version(vmid, version)

    print(json.dumps([{"id": "app_version", "value": version}]))


if __name__ == "__main__":
    main()
