"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for managed volumes.
"""

import os
import subprocess
import sys


def _find_pvesm() -> str:
    """Locate pvesm binary. PATH may be minimal under SSH-non-interactive."""
    import shutil
    found = shutil.which("pvesm")
    if found:
        return found
    for candidate in ("/usr/sbin/pvesm", "/sbin/pvesm", "/usr/bin/pvesm"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "pvesm"  # last-ditch: let subprocess raise FileNotFoundError


def resolve_host_volume(hostname: str, volume_key: str) -> str:
    """Resolve host-side path for a container volume.

    Resolution order:
    1. Dedicated managed volume: subvol-*-<hostname>-<key> (OCI-image apps)
    2. App managed volume subdirectory: subvol-*-<hostname>-app/<key> (docker-compose apps)
    """
    pvesm = _find_pvesm()

    # Storages to search: VOLUME_STORAGE if set (explicit override), otherwise
    # every rootdir-content storage known to pvesm. Scanning all handles mixed
    # setups (e.g. LVM-thin on github-action CI) without the caller needing to
    # know which storage holds a given volume.
    env_storage = os.environ.get("VOLUME_STORAGE")
    if env_storage:
        storages = [env_storage]
    else:
        try:
            result = subprocess.run(
                [pvesm, "status", "--content", "rootdir"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                storages = [line.split()[0] for line in result.stdout.splitlines()[1:] if line.strip()]
            else:
                storages = ["local-zfs"]
        except Exception:
            storages = ["local-zfs"]

    # Stable mount root used by vol_mount (vol-common.sh) for block-based
    # storages that don't naturally appear as a directory via pvesm path.
    # Keep in sync with VOL_MOUNT_ROOT in vol-common.sh.
    vol_mount_root = "/var/lib/pve-vol-mounts"

    def _pvesm_find(suffix: str):
        # Scan every storage in `storages` for a volid ending in suffix.
        all_lines = []
        for storage in storages:
            try:
                result = subprocess.run(
                    [pvesm, "list", storage, "--content", "rootdir"],
                    capture_output=True, text=True, timeout=5,
                )
            except FileNotFoundError as e:
                sys.stderr.write(f"[resolve_host_volume] pvesm not executable at '{pvesm}': {e}\n")
                return None
            except subprocess.TimeoutExpired:
                sys.stderr.write(f"[resolve_host_volume] '{pvesm} list {storage}' timed out\n")
                continue
            if result.returncode != 0:
                sys.stderr.write(
                    f"[resolve_host_volume] '{pvesm} list {storage}' exit={result.returncode}: "
                    f"{result.stderr.strip()[:200]}\n"
                )
                continue
            all_lines.extend(result.stdout.splitlines())

        sample = [ln for ln in all_lines[:5]]
        sys.stderr.write(
            f"[resolve_host_volume] pvesm list output ({len(all_lines)} lines) over {storages}, sample: {sample!r}\n"
        )

        match_count = 0
        for line in all_lines:
            # pvesm list returns multi-column output:
            #   VolID                                    Format  Type    Size  VMID
            #   local-zfs:subvol-506-nginx-proxvex  subvol  rootdir  ...  506
            # Match against the first column (the volid), NOT the raw line.
            parts = line.split()
            if not parts:
                continue
            volid = parts[0]
            if volid.endswith(suffix):
                match_count += 1
                # Prefer a vol_mount'ed path under VOL_MOUNT_ROOT if it exists
                # (LVM/LVM-thin case — pvesm path would return a block device).
                volname = volid.split(":", 1)[1] if ":" in volid else volid
                mounted_path = os.path.join(vol_mount_root, volname)
                if os.path.isdir(mounted_path) and os.path.ismount(mounted_path):
                    return mounted_path
                try:
                    path_result = subprocess.run(
                        [pvesm, "path", volid],
                        capture_output=True, text=True, timeout=5,
                    )
                except Exception as e:
                    sys.stderr.write(f"[resolve_host_volume] '{pvesm} path {volid}' failed: {e}\n")
                    continue
                if path_result.returncode != 0:
                    sys.stderr.write(
                        f"[resolve_host_volume] '{pvesm} path {volid}' exit={path_result.returncode}: "
                        f"{path_result.stderr.strip()[:200]}\n"
                    )
                    continue
                path = path_result.stdout.strip()
                if path and os.path.isdir(path):
                    return path
                sys.stderr.write(
                    f"[resolve_host_volume] '{pvesm} path {volid}' returned '{path}' — not a directory\n"
                )
        if match_count == 0:
            sys.stderr.write(
                f"[resolve_host_volume] no volume matched suffix '{suffix}' in '{pvesm} list {storage}' output\n"
            )
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
        sys.stderr.write(
            f"[resolve_host_volume] found {hostname}-app at {app_path}, "
            f"but no '{volume_key}' subdir (tried variants)\n"
        )

    raise RuntimeError(f"resolve_host_volume failed for {hostname}/{volume_key}")
