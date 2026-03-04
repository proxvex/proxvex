#!/usr/bin/env python3
"""List managed OCI containers from Proxmox LXC config files.

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` (env override supported for tests)
for containers that:
- contain the oci-lxc-deployer managed marker
- contain an OCI image marker or visible OCI image line

Outputs a single VeExecution output id `containers` whose value is a JSON string
representing an array of objects: { vm_id, hostname?, oci_image, icon, addons?, ... }.

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Note: Do NOT add "from __future__ import annotations" here - it's already in the library
and must be at the very beginning of the combined file.
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
    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    containers: list[dict] = []

    if base_dir.is_dir():
        # Stable order by vmid
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

            # Full parse
            config = parse_lxc_config(conf_text)

            if not config.oci_image:
                continue

            item = {
                "vm_id": int(vmid_str),
                "oci_image": config.oci_image,
                "icon": "",
            }
            if config.hostname:
                item["hostname"] = config.hostname
            if config.application_id:
                item["application_id"] = config.application_id
            if config.application_name:
                item["application_name"] = config.application_name
            if config.version:
                item["version"] = config.version
            if config.is_deployer_instance:
                item["is_deployer_instance"] = True
            if config.addons:
                item["addons"] = config.addons
            # User/permission info for addon reconfiguration
            if config.username:
                item["username"] = config.username
            if config.uid:
                item["uid"] = config.uid
            if config.gid:
                item["gid"] = config.gid
            # Container resource settings
            if config.memory is not None:
                item["memory"] = config.memory
            if config.cores is not None:
                item["cores"] = config.cores
            if config.rootfs_storage:
                item["rootfs_storage"] = config.rootfs_storage
            if config.disk_size:
                item["disk_size"] = config.disk_size
            if config.bridge:
                item["bridge"] = config.bridge
            # Mount points for existing volumes display
            if config.mount_points:
                item["mount_points"] = [
                    {"source": mp.source, "target": mp.target}
                    for mp in config.mount_points
                ]
                # Convert mount points to volumes format (name=path)
                # Volume name is last component of source path
                vol_lines = []
                for mp in config.mount_points:
                    vol_name = mp.source.rstrip("/").rsplit("/", 1)[-1]
                    vol_lines.append(f"{vol_name}={mp.target}")
                if vol_lines:
                    item["volumes"] = "\n".join(vol_lines)

            containers.append(item)

    if containers:
        max_workers = min(8, len(containers))
        vmids = [item["vm_id"] for item in containers]
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            statuses = list(executor.map(get_status, vmids))
        for item, status in zip(containers, statuses):
            if status:
                item["status"] = status

    # Return output in VeExecution format: IOutput[]
    print(json.dumps([{"id": "containers", "value": json.dumps(containers)}]))


if __name__ == "__main__":
    main()
