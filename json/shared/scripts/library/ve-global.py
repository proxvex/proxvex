"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for managed and bind-mount volumes.
"""

import os
import subprocess


def resolve_host_volume(hostname: str, volume_key: str) -> str:
    """Resolve host-side path for a container volume.

    Resolution order:
    1. Proxmox-managed volume via pvesm path (OCI-image apps)
    2. Bind-mount directory at /mnt/volumes/<hostname>/<key> (docker-compose apps)

    Args:
        hostname: Sanitized container hostname
        volume_key: Sanitized volume key (e.g. "data", "certs", "bootstrap")

    Returns:
        Host-side path to the volume directory
    """
    volname = f"{hostname}-{volume_key}"
    storage = os.environ.get("VOLUME_STORAGE", "local-zfs")

    # 1. Try Proxmox-managed volume
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

    # 2. Fallback: bind-mount directory (docker-compose apps)
    bind_path = f"/mnt/volumes/{hostname}/{volume_key}"
    if os.path.isdir(bind_path):
        return bind_path

    raise RuntimeError(f"resolve_host_volume failed for {hostname}/{volume_key}")
