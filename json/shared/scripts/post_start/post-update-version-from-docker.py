#!/usr/bin/env python3
"""Update LXC notes version from the actual Docker image after pull.

For single-service apps: identifies the main image and writes one version.
For multi-service docker-compose apps: resolves all service versions and
writes them as comma-separated list (e.g. "zitadel-api:v4.12.3, traefik:v3.6").

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


def get_all_images(vmid: str) -> list[str]:
    """Get all Docker images in the container (excluding <none>)."""
    output = docker_exec(vmid, "docker images --format {{.Repository}}:{{.Tag}}")
    if not output:
        return []
    return [line for line in output.split("\n") if line and "<none>" not in line]


def find_main_image(images: list[str], app_id: str) -> str | None:
    """Find the main Docker image matching the application_id."""
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


def get_service_name(image: str) -> str:
    """Extract short service name from image reference (e.g. 'ghcr.io/zitadel/zitadel:v4' -> 'zitadel')."""
    return image.rsplit("/", 1)[-1].split(":")[0]


def resolve_all_versions(vmid: str, images: list[str]) -> list[tuple[str, str]]:
    """Resolve versions for all images. Returns list of (service_name, version)."""
    results = []
    for image in images:
        service = get_service_name(image)
        version = get_version(vmid, image)
        print(f"  {service}: {version}", file=sys.stderr)
        results.append((service, version))
    return results


def format_version_string(service_versions: list[tuple[str, str]]) -> str:
    """Format version string for notes.

    Single service: just the version (e.g. "v4.12.3")
    Multiple services: "service1:version1, service2:version2"
    """
    if len(service_versions) == 1:
        return service_versions[0][1]
    return ", ".join(f"{svc}:{ver}" for svc, ver in service_versions)


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

    # Also update the visible header: "# AppName (version)" or "# AppName"
    # In PVE config, description is URL-encoded: %23=#, %28=(, %29=)
    app_name = config.application_name or config.application_id or ""
    if app_name:
        encoded_version = quote(version, safe="")
        encoded_name = quote(app_name, safe="")
        # Match: %23 AppName (%28old_version%29) — with optional version part
        header_pattern = r"%23\s+" + re.escape(encoded_name) + r"(?:\s+%28[^%]*(?:%[0-9A-Fa-f]{2}[^%]*)*%29)?"
        header_new = "%%23 %s %%28%s%%29" % (encoded_name, encoded_version)
        conf_text = re.sub(header_pattern, header_new, conf_text)

    conf_path.write_text(conf_text, encoding="utf-8")
    print(f"Updated version in LXC notes: {version}", file=sys.stderr)


def main() -> None:
    vmid = _normalize(VM_ID_RAW)
    app_id = _normalize(APP_ID_RAW)

    if not vmid or not app_id:
        print(json.dumps([]))
        return

    images = get_all_images(vmid)
    if not images:
        print(f"No Docker images found for {app_id}", file=sys.stderr)
        print(json.dumps([{"id": "app_version", "value": "unknown"}]))
        return

    print(f"Found {len(images)} image(s), resolving versions...", file=sys.stderr)
    service_versions = resolve_all_versions(vmid, images)

    version_string = format_version_string(service_versions)
    print(f"Version string: {version_string}", file=sys.stderr)

    update_notes_version(vmid, version_string)

    print(json.dumps([{"id": "app_version", "value": version_string}]))


if __name__ == "__main__":
    main()
