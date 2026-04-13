"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for managed volumes.
"""

import os
import subprocess


def resolve_host_volume(hostname: str, volume_key: str) -> str:
    """Resolve host-side path for a container volume.

    Resolution order:
    1. Dedicated managed volume: subvol-*-<hostname>-<key> (OCI-image apps)
    2. App managed volume subdirectory: subvol-*-<hostname>-app/<key> (docker-compose apps)

    Args:
        hostname: Sanitized container hostname
        volume_key: Sanitized volume key (e.g. "data", "certs", "bootstrap")

    Returns:
        Host-side path to the volume directory
    """
    storage = os.environ.get("VOLUME_STORAGE", "local-zfs")

    def _pvesm_find(suffix: str) -> str | None:
        try:
            result = subprocess.run(
                ["pvesm", "list", storage, "--content", "rootdir"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if line.rstrip().endswith(suffix):
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
        return None

    # 1. Dedicated managed volume
    path = _pvesm_find(f"{hostname}-{volume_key}")
    if path:
        return path

    # 2. App managed volume with subdirectory
    app_path = _pvesm_find(f"{hostname}-app")
    if app_path:
        for variant in [volume_key, volume_key.replace("-", "_"), volume_key.replace("_", "-")]:
            subdir = os.path.join(app_path, variant)
            if os.path.isdir(subdir):
                return subdir

    raise RuntimeError(f"resolve_host_volume failed for {hostname}/{volume_key}")
