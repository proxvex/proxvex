"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for Proxmox-managed volumes.
"""

import os
import subprocess


def resolve_host_volume(hostname: str, volume_key: str) -> str:
    """Resolve host-side path for a container volume via pvesm.

    Args:
        hostname: Sanitized container hostname
        volume_key: Sanitized volume key (e.g. "data", "certs", "bootstrap")

    Returns:
        Host-side path to the volume directory
    """
    volname = f"{hostname}-{volume_key}"
    storage = os.environ.get("VOLUME_STORAGE", "local-zfs")

    try:
        result = subprocess.run(
            ["pvesm", "list", storage, "--content", "rootdir"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if volname in line:
                    volid = line.split()[0]
                    path_result = subprocess.run(
                        ["pvesm", "path", volid],
                        capture_output=True, text=True, timeout=5,
                    )
                    if path_result.returncode == 0:
                        path = path_result.stdout.strip()
                        if path and os.path.isdir(path):
                            return path
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    raise RuntimeError(f"resolve_host_volume failed for {hostname}/{volume_key}")
