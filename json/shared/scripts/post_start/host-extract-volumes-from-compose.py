#!/usr/bin/env python3
"""Extract volume mappings from Docker Compose file.

This script:
1. Parses docker-compose.yaml (YAML)
2. Extracts all volume mappings from services
3. Converts relative paths (./data) to volumes/<project>/data format
4. Converts named volumes to volumes/<project>/<volume-name> format
5. Converts absolute paths to container paths
6. Outputs volumes in key=value format for bind-multiple-volumes-to-lxc

Output: JSON to stdout with volumes and compose_project (errors to stderr)
"""

import json
import sys
import base64
from pathlib import Path

try:
    import yaml
except ImportError:
    print("Error: PyYAML is required. Install it with: pip install pyyaml or apt install python3-yaml", file=sys.stderr)
    sys.exit(1)

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

def parse_volume_options(volumes_input):
    """Parse existing volumes parameter to extract per-key options (e.g. permissions).

    Input format: "bootstrap:,0777\\ncerts:" or "bootstrap=/bootstrap,0777"
    Returns dict: {"bootstrap": ",0777", "certs": ""}
    """
    options = {}
    if not volumes_input or volumes_input == "NOT_DEFINED":
        return options
    for line in volumes_input.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        # Handle both "key:,opts" and "key=path,opts" formats
        if "=" in line:
            key = line.split("=")[0].strip()
            rest = line.split("=", 1)[1]
            # Extract options after path (e.g. "/bootstrap,0777" -> ",0777")
            if "," in rest:
                opts = "," + rest.split(",", 1)[1]
            else:
                opts = ""
        elif ":" in line:
            key = line.split(":")[0].strip()
            opts = line.split(":", 1)[1].strip()
            if opts and not opts.startswith(","):
                opts = "," + opts
        else:
            key = line.strip()
            opts = ""
        if key:
            options[key] = opts
    return options


def main():
    # Get parameters from template variables
    compose_file_base64 = "{{ compose_file }}"
    compose_project = "{{ compose_project }}"
    hostname = "{{ hostname }}"
    existing_volumes = "{{ volumes }}"
    
    # Use hostname as default if compose_project is not set
    if not compose_project or compose_project == "NOT_DEFINED" or compose_project == "":
        if hostname and hostname != "NOT_DEFINED":
            compose_project = hostname
        else:
            compose_project = "default"
    
    # Decode base64 compose file
    try:
        compose_file_content = base64.b64decode(compose_file_base64).decode('utf-8')
    except Exception as e:
        eprint(f"Error: Failed to decode compose file: {e}")
        sys.exit(1)
    
    # Parse YAML
    try:
        compose_data = yaml.safe_load(compose_file_content)
    except Exception as e:
        eprint(f"Error: Failed to parse YAML: {e}")
        sys.exit(1)
    
    if not compose_data:
        eprint("Error: Empty or invalid compose file")
        sys.exit(1)
    
    # Extract project name from compose file if not provided
    if compose_project == "default" and "name" in compose_data:
        compose_project = compose_data["name"]
    elif compose_project == "default":
        # Try to extract from x-project-name or use first service name
        if "services" in compose_data and compose_data["services"]:
            first_service = list(compose_data["services"].keys())[0]
            compose_project = first_service.replace("_", "-")
    
    # Parse existing volume options from application.json (e.g. permissions)
    volume_options = parse_volume_options(existing_volumes)
    if volume_options:
        eprint(f"Existing volume options: {volume_options}")

    def append_volume(key, container_path_normalized):
        """Append volume entry, merging options from existing volumes parameter."""
        opts = volume_options.get(key, "")
        volumes_list.append(f"{key}={container_path_normalized}{opts}")

    volumes_list = []
    volume_names = set()
    compose_uid = None

    # Extract volumes and user from services
    if "services" in compose_data:
        for service_name, service_config in compose_data["services"].items():
            # Extract first numeric user found (for volume ownership)
            if compose_uid is None and "user" in service_config:
                user_val = str(service_config["user"]).strip().strip('"').strip("'")
                # Check if it's a numeric UID (possibly with :GID)
                uid_part = user_val.split(":")[0]
                if uid_part.isdigit():
                    compose_uid = uid_part
                    eprint(f"Found user UID {compose_uid} in service '{service_name}'")

            if "volumes" in service_config:
                for volume_spec in service_config["volumes"]:
                    # Parse volume specification
                    # Format can be:
                    # - "host_path:container_path"
                    # - "host_path:container_path:ro" (read-only)
                    # - "./data:/app/data" (relative path)
                    # - "volume_name:/app/data" (named volume)
                    # - "/absolute/path:/app/data" (absolute path)
                    
                    # Split by colon (but be careful with Windows paths and read-only flag)
                    parts = volume_spec.split(":")
                    
                    if len(parts) < 2:
                        eprint(f"Warning: Invalid volume specification '{volume_spec}', skipping")
                        continue
                    
                    host_path = parts[0]
                    container_path = parts[1]
                    # parts[2] would be "ro" or "rw" if present
                    
                    # Skip if it's a named volume reference (no slash in host_path)
                    if host_path and "/" not in host_path and host_path not in ["", "."]:
                        # Check if it's defined in top-level volumes section
                        if "volumes" in compose_data and host_path in compose_data["volumes"]:
                            # Named volume - create path under volumes/<project>/<volume-name>
                            volume_key = host_path
                            volume_names.add(volume_key)
                            container_path_normalized = container_path.lstrip("/")
                            append_volume(volume_key, container_path_normalized)
                        else:
                            # Unknown named volume, skip or create default path
                            volume_key = host_path
                            volume_names.add(volume_key)
                            container_path_normalized = container_path.lstrip("/")
                            append_volume(volume_key, container_path_normalized)
                    elif host_path.startswith("./"):
                        # Relative path - convert to volumes/<project>/<name>
                        # ./data -> volumes/<project>/data
                        relative_name = host_path[2:].rstrip("/")
                        if not relative_name:
                            relative_name = "data"
                        # Keep directory structure but use as volume key
                        volume_key = relative_name.replace("/", "_")
                        container_path_normalized = container_path.lstrip("/")
                        append_volume(volume_key, container_path_normalized)
                    elif host_path.startswith("/"):
                        # Absolute path - use last component as key
                        volume_key = Path(host_path).name or "data"
                        container_path_normalized = container_path.lstrip("/")
                        append_volume(volume_key, container_path_normalized)
                    else:
                        # Other format, try to use as-is
                        volume_key = host_path.replace("/", "_").replace(".", "_") or "data"
                        container_path_normalized = container_path.lstrip("/")
                        append_volume(volume_key, container_path_normalized)
    
    # Always include compose directory as a persistent volume.
    # This ensures docker-compose files survive container upgrades
    # and are accessible from the VE host (e.g. for addon reconfigure).
    append_volume("compose", "opt/docker-compose")

    # Persist Docker storage directory so images survive container recreation.
    # During upgrades, images can be pre-pulled in the old container and
    # reused by the new container without re-downloading.
    append_volume("docker", "var/lib/docker")

    # Remove duplicates while preserving order
    seen = set()
    unique_volumes = []
    for vol in volumes_list:
        key = vol.split("=")[0]
        if key not in seen:
            seen.add(key)
            unique_volumes.append(vol)
    
    volumes_output = "\n".join(unique_volumes)
    
    eprint(f"Extracted {len(unique_volumes)} volume(s) from compose file")
    eprint(f"Project name: {compose_project}")
    
    # Output JSON
    # Only output compose_project if it was computed (not already set by set-parameters.json)
    # Check if compose_project was empty/not defined and we computed it from hostname
    original_compose_project = "{{ compose_project }}"
    output = [{"id": "volumes", "value": volumes_output}]
    
    # Only output compose_project if it was computed from hostname (was empty/not defined)
    if (not original_compose_project or
        original_compose_project == "NOT_DEFINED" or
        original_compose_project == ""):
        output.append({"id": "compose_project", "value": compose_project})

    # Output UID/GID for volume ownership on host (only if found in compose)
    if compose_uid:
        output.append({"id": "uid", "value": compose_uid})
        output.append({"id": "gid", "value": compose_uid})

    print(json.dumps(output))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        eprint(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
