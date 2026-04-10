"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for Proxmox-managed volumes.
"""

import os
import subprocess


def resolve_host_volume(shared_volpath: str, hostname: str, volume_key: str) -> str:
    """Resolve host-side path for a container volume.

    Resolution order:
    1. Proxmox-managed volume via pvesm path
    2. Legacy fallback: shared_volpath/volumes/hostname/key

    Args:
        shared_volpath: Base path for shared volumes (may be empty for managed volumes)
        hostname: Sanitized container hostname
        volume_key: Sanitized volume key (e.g. "data", "certs", "bootstrap")

    Returns:
        Host-side path to the volume directory
    """
    volname = f"{hostname}-{volume_key}"
    storage = os.environ.get("VOLUME_STORAGE", "local-zfs")

    # Try to find managed volume via pvesm
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

    # Legacy fallback
    if shared_volpath and shared_volpath != "NOT_DEFINED":
        return os.path.join(shared_volpath, "volumes", hostname, volume_key)

    raise RuntimeError(f"resolve_host_volume failed for {hostname}/{volume_key}")
