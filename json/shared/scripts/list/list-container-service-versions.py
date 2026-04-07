#!/usr/bin/env python3
"""Extract service names and image versions from a Docker Compose file.

Runs on VE host, reads docker-compose.yaml from a running container via
pct exec, and outputs a JSON array of { service, image, currentVersion }.

Requires:
  - vm_id: Container ID
  - compose_project: Docker Compose project name (directory name)

Output: JSON to stdout (errors to stderr)
"""

import json
import os
import re
import subprocess
import sys

VM_ID = "{{ vm_id }}"
COMPOSE_PROJECT = "{{ compose_project }}"


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def read_compose_from_container(vm_id: str, compose_project: str) -> str | None:
    """Read compose file content from running container via pct exec."""
    compose_dir = f"/opt/docker-compose/{compose_project}"
    for name in ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]:
        path = f"{compose_dir}/{name}"
        try:
            result = subprocess.run(
                ["pct", "exec", vm_id, "--", "cat", path],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout
        except Exception:
            continue
    return None


def extract_service_image(image_str: str) -> tuple[str, str, str]:
    """Extract (service_short_name, image_without_tag, version_tag) from image string.

    Examples:
      "traefik:v3.6"                     -> ("traefik", "traefik", "v3.6")
      "ghcr.io/zitadel/zitadel:v4.12.3"  -> ("zitadel", "ghcr.io/zitadel/zitadel", "v4.12.3")
      "nginx"                             -> ("nginx", "nginx", "latest")
    """
    image_str = image_str.strip().strip("'\"")

    if "@" in image_str:
        image_part = image_str.split("@")[0]
        tag = "digest"
    elif ":" in image_str:
        parts = image_str.rsplit(":", 1)
        if "/" in parts[1]:
            image_part = image_str
            tag = "latest"
        else:
            image_part = parts[0]
            tag = parts[1]
    else:
        image_part = image_str
        tag = "latest"

    short_name = image_part.rsplit("/", 1)[-1]
    return short_name, image_part, tag


def parse_compose_services(content: str) -> list[dict]:
    """Parse service image entries from compose file content."""
    services = []
    current_service = None
    in_services_block = False
    service_indent = None

    for line in content.split("\n"):
        stripped = line.rstrip()

        if re.match(r"^services:\s*$", stripped):
            in_services_block = True
            continue

        if not in_services_block:
            continue

        if stripped and not stripped[0].isspace() and not stripped.startswith("#"):
            in_services_block = False
            continue

        match = re.match(r"^(\s+)(\S+):\s*$", stripped)
        if match:
            indent = len(match.group(1))
            if service_indent is None:
                service_indent = indent
            if indent == service_indent:
                current_service = match.group(2)
                continue

        if current_service:
            img_match = re.match(r"^\s+image:\s+(.+)$", stripped)
            if img_match:
                image_str = img_match.group(1).strip()
                if "{{" in image_str:
                    continue
                short_name, image, version = extract_service_image(image_str)
                services.append({
                    "service": short_name,
                    "image": image,
                    "currentVersion": version,
                })

    return services


def main() -> None:
    if not COMPOSE_PROJECT or COMPOSE_PROJECT == "NOT_DEFINED":
        eprint("No compose_project set")
        print(json.dumps([{"id": "service_versions", "value": "[]"}]))
        return

    if not VM_ID or VM_ID == "NOT_DEFINED":
        eprint("No vm_id set")
        print(json.dumps([{"id": "service_versions", "value": "[]"}]))
        return

    eprint(f"Reading compose file from container {VM_ID}, project {COMPOSE_PROJECT}")

    content = read_compose_from_container(VM_ID, COMPOSE_PROJECT)
    if not content:
        eprint(f"No compose file found in container {VM_ID}")
        print(json.dumps([{"id": "service_versions", "value": "[]"}]))
        return

    services = parse_compose_services(content)
    eprint(f"Found {len(services)} service(s)")
    print(json.dumps([{"id": "service_versions", "value": json.dumps(services)}]))


if __name__ == "__main__":
    main()
