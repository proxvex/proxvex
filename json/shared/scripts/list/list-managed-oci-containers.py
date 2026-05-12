#!/usr/bin/env python3
"""List managed OCI containers from Proxmox LXC config files.

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` (env override supported for tests)
for containers that:
- contain the proxvex managed marker
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
from pathlib import Path

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig
# - is_managed_container(conf_text) -> bool


def get_all_statuses(timeout: float = 8.0) -> dict[int, str]:
    """Return {vmid: status} for every container known to pct.

    Calling `pct status <vmid>` per container is slow on a real cluster
    (~1.6s per call) and stalls on any container that holds a transient
    lock (migrate, backup, snapshot) — the dependency-check dialog then
    times out or surfaces "unknown" warnings for unrelated VMs. `pct list`
    is a single cluster-state lookup that returns every container's status
    in one ~2s call, regardless of how many containers there are and
    regardless of per-container locks.

    Output format (header + space-padded columns):
        VMID       Status     Lock         Name
        500        running                 postgres
        504        stopped    migrate      gitea

    The Lock column is always empty for unlocked containers, so splitting
    on whitespace gives `[vmid, status, ...]` — we only need the first
    two columns.
    """
    try:
        result = subprocess.run(
            ["pct", "list"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception:
        return {}
    if result.returncode != 0:
        return {}

    statuses: dict[int, str] = {}
    for raw in result.stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2 or not parts[0].isdigit():
            continue  # header row or unexpected format
        try:
            statuses[int(parts[0])] = parts[1]
        except ValueError:
            continue
    return statuses


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

            # Managed containers without an oci_image marker are typically
            # docker-compose apps (multiple images, no single one to record).
            # Keep them if they carry an application_id so the UI can still
            # list them.
            if not config.oci_image and not config.application_id:
                continue

            item = {
                "vm_id": int(vmid_str),
                "oci_image": config.oci_image or "",
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
            if config.stack_ids:
                item["stack_ids"] = list(config.stack_ids)
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
        all_statuses = get_all_statuses()
        # Always set a status so consumers (dep-check matching, UI) can
        # distinguish "really stopped" from "couldn't determine". "unknown"
        # only fires if `pct list` itself failed or omitted the VM (rare —
        # the conf exists but the cluster manager has not picked it up yet).
        for item in containers:
            item["status"] = all_statuses.get(item["vm_id"], "unknown")

    # Return output in VeExecution format: IOutput[]
    print(json.dumps([{"id": "containers", "value": json.dumps(containers)}]))


if __name__ == "__main__":
    main()
