"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for both bind-mount and managed-volume layouts.
"""

import os


def resolve_host_volume(shared_volpath: str, hostname: str, volume_key: str) -> str:
    """Resolve host-side path for a container volume.

    Args:
        shared_volpath: Base path for shared volumes (output from template 150)
        hostname: Sanitized container hostname
        volume_key: Sanitized volume key (e.g. "data", "certs", "bootstrap")

    Returns:
        Host-side path to the volume directory
    """
    # Future: check if managed volume exists and resolve via pvesm
    return os.path.join(shared_volpath, "volumes", hostname, volume_key)
