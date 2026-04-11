#!/usr/bin/env python3
"""Find running containers by application_id.

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` for containers that:
- contain the oci-lxc-deployer managed marker
- match the specified application_id

Only checks status for matching containers (not all), then returns only running ones.

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Template variables:
  - application_id: The application ID to search for (required)

Output:
  - containers: JSON array of running containers with vm_id and application_id
"""

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig
# - is_managed_container(conf_text) -> bool


def get_status(vmid: int) -> str | None:
    """Get container status via pct status."""
    try:
        result = subprocess.run(
            ["pct", "status", str(vmid)],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        out = result.stdout.strip()
        # Expected format: "status: running" or "status: stopped"
        if "status:" in out:
            return out.split("status:", 1)[1].strip() or None
        return out or None
    except Exception:
        return None


def main() -> None:
    app_id = "{{ application_id }}"
    stack_id_filter = "{{ stack_id }}"
    if not app_id or app_id == "NOT_DEFINED":
        print(json.dumps([{"id": "error", "value": "application_id parameter is required"}]))
        return
    if stack_id_filter == "NOT_DEFINED":
        stack_id_filter = ""

    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    # Phase 1: Find all containers matching the application_id (no status check yet)
    matching: list[dict] = []

    if base_dir.is_dir():
        for conf_path in sorted(base_dir.glob("*.conf"), key=lambda p: p.name):
            vmid_str = conf_path.stem
            if not vmid_str.isdigit():
                continue

            try:
                conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            # Quick check before full parsing
            if not is_managed_container(conf_text):
                continue

            # Full parse to get application_id
            config = parse_lxc_config(conf_text)

            if config.application_id == app_id:
                # If stack_id filter is set, only match containers in the same stack
                if stack_id_filter:
                    # Extract base name from stack_id for cross-stacktype matching
                    # e.g. "postgres_ssl" and "oidc_ssl" share base "ssl"
                    config_stack = config.stack_name or ""
                    config_base = config_stack.split("_", 1)[1] if "_" in config_stack else config_stack
                    filter_base = stack_id_filter.split("_", 1)[1] if "_" in stack_id_filter else stack_id_filter
                    if config_base != filter_base:
                        continue
                matching.append({
                    "vm_id": int(vmid_str),
                    "application_id": config.application_id,
                    "hostname": config.hostname,
                })

    # Phase 2: Check status only for matching containers
    running: list[dict] = []

    if matching:
        if len(matching) == 1:
            # Single container - no need for thread pool
            status = get_status(matching[0]["vm_id"])
            if status == "running":
                matching[0]["status"] = status
                running.append(matching[0])
        else:
            # Multiple containers - use thread pool
            vmids = [item["vm_id"] for item in matching]
            with ThreadPoolExecutor(max_workers=min(4, len(matching))) as executor:
                statuses = list(executor.map(get_status, vmids))
            for item, status in zip(matching, statuses):
                if status == "running":
                    item["status"] = status
                    running.append(item)

    # Return output in VeExecution format: IOutput[]
    print(json.dumps([{"id": "containers", "value": json.dumps(running)}]))


if __name__ == "__main__":
    main()
