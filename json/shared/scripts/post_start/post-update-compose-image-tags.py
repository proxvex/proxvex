#!/usr/bin/env python3
"""Update Docker Compose image tags in-place on the persistent volume.

Reads the existing docker-compose.yaml, updates image tags based on
target_versions parameter, and writes it back. All other content
(hardening changes, env vars, volumes, etc.) is preserved.

Runs inside the LXC container (execute_on: lxc).

Requires:
  - target_versions: Comma-separated "service=version" pairs
                     (e.g. "traefik=v3.7,zitadel=v4.13.0")
  - compose_project: Docker Compose project name

Output: JSON to stdout (errors to stderr)
"""

import json
import os
import re
import sys

TARGET_VERSIONS = "{{ target_versions }}"
COMPOSE_PROJECT = "{{ compose_project }}"


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def find_compose_file(project_dir: str) -> str | None:
    for name in ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]:
        path = os.path.join(project_dir, name)
        if os.path.isfile(path):
            return path
    return None


def parse_target_versions(raw: str) -> dict[str, str]:
    """Parse 'service1=version1,service2=version2' into dict."""
    result = {}
    for part in raw.split(","):
        part = part.strip()
        if "=" in part:
            svc, ver = part.split("=", 1)
            svc = svc.strip()
            ver = ver.strip()
            if svc and ver:
                result[svc] = ver
    return result


def short_name_from_image(image_str: str) -> str:
    """Extract short service name from image string.

    'ghcr.io/zitadel/zitadel:v4.12.3' -> 'zitadel'
    'traefik:v3.6' -> 'traefik'
    """
    # Remove tag/digest
    if "@" in image_str:
        image_str = image_str.split("@")[0]
    if ":" in image_str:
        parts = image_str.rsplit(":", 1)
        if "/" not in parts[1]:
            image_str = parts[0]

    return image_str.rsplit("/", 1)[-1]


def update_image_tags(content: str, versions: dict[str, str]) -> str:
    """Update image: lines in compose content based on target versions.

    Preserves all formatting, comments, and non-image content.
    """
    lines = content.split("\n")
    updated_lines = []

    for line in lines:
        match = re.match(r"^(\s+image:\s+)(.+?)(\s*)$", line)
        if match:
            prefix = match.group(1)
            image_str = match.group(2).strip().strip("'\"")
            trailing = match.group(3)

            short = short_name_from_image(image_str)

            if short in versions:
                new_version = versions[short]

                # Replace the tag in the image string
                if "@" in image_str:
                    # Digest format — replace with tag
                    base = image_str.split("@")[0]
                    new_image = f"{base}:{new_version}"
                elif ":" in image_str:
                    parts = image_str.rsplit(":", 1)
                    if "/" not in parts[1]:
                        new_image = f"{parts[0]}:{new_version}"
                    else:
                        new_image = f"{image_str}:{new_version}"
                else:
                    new_image = f"{image_str}:{new_version}"

                eprint(f"  Updated {short}: {image_str} -> {new_image}")
                updated_lines.append(f"{prefix}{new_image}{trailing}")
                continue

        updated_lines.append(line)

    return "\n".join(updated_lines)


def main() -> None:
    if not TARGET_VERSIONS or TARGET_VERSIONS == "NOT_DEFINED":
        eprint("No target_versions set, skipping")
        print(json.dumps([{"id": "image_tags_updated", "value": "false"}]))
        return

    if not COMPOSE_PROJECT or COMPOSE_PROJECT == "NOT_DEFINED":
        eprint("No compose_project set, skipping")
        print(json.dumps([{"id": "image_tags_updated", "value": "false"}]))
        return

    versions = parse_target_versions(TARGET_VERSIONS)
    if not versions:
        eprint("No valid version entries in target_versions")
        print(json.dumps([{"id": "image_tags_updated", "value": "false"}]))
        return

    eprint(f"Target versions: {versions}")

    project_dir = f"/opt/docker-compose/{COMPOSE_PROJECT}"
    compose_file = find_compose_file(project_dir)

    if not compose_file:
        eprint(f"ERROR: No compose file found in {project_dir}")
        sys.exit(1)

    eprint(f"Updating image tags in {compose_file}")

    with open(compose_file, "r") as f:
        content = f.read()

    updated = update_image_tags(content, versions)

    with open(compose_file, "w") as f:
        f.write(updated)

    eprint("Image tags updated successfully")
    print(json.dumps([{"id": "image_tags_updated", "value": "true"}]))


if __name__ == "__main__":
    main()
