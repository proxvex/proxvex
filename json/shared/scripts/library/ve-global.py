"""Global VE host library - auto-injected into all execute_on:ve Python scripts.

Provides volume path resolution for managed volumes.
"""

import os
import shutil
import subprocess
import sys


def _find_pvesm() -> str:
    """Locate pvesm binary. PATH may be minimal under SSH-non-interactive."""
    found = shutil.which("pvesm")
    if found:
        return found
    for candidate in ("/usr/sbin/pvesm", "/sbin/pvesm", "/usr/bin/pvesm"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "pvesm"  # last-ditch: let subprocess raise FileNotFoundError


def _find_pct() -> str:
    """Locate pct binary."""
    found = shutil.which("pct")
    if found:
        return found
    for candidate in ("/usr/sbin/pct", "/sbin/pct", "/usr/bin/pct"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "pct"


def find_vmid_by_hostname(hostname: str) -> str | None:
    """Look up the unique VMID that matches <hostname> in `pct list`.

    Useful for cross-container scripts (e.g. an OIDC client that needs to
    write into the Zitadel container's volume) that have a hostname but no
    vmid in their template variables.

    Returns:
        VMID string on exactly one match (running preferred over stopped).
        None if no container matches.

    Raises:
        RuntimeError if multiple containers share the hostname.

    Why fail loudly on multi-match: previously this returned the lowest-VMID
    match silently, which masked leftover containers from earlier runs and
    produced wrong-credential downstream failures (e.g. zitadel resolving to
    a stale postgres VMID and pulling the wrong POSTGRES_PASSWORD secret).
    """
    if not hostname:
        return None
    pct = _find_pct()
    try:
        result = subprocess.run(
            [pct, "list"], capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    running: list[str] = []
    others: list[str] = []
    for line in result.stdout.splitlines()[1:]:  # skip header
        parts = line.split()
        if len(parts) < 3:
            continue
        # pct list: VMID Status [Lock] Name — name is the last token.
        name = parts[-1]
        status = parts[1]
        if name != hostname:
            continue
        (running if status == "running" else others).append(parts[0])

    if len(running) > 1:
        raise RuntimeError(
            f"find_vmid_by_hostname: multiple running containers match hostname "
            f"{hostname!r}: {', '.join(running)} — remove duplicates before retrying"
        )
    if len(running) == 1:
        return running[0]

    if len(others) > 1:
        raise RuntimeError(
            f"find_vmid_by_hostname: multiple containers match hostname "
            f"{hostname!r}: {', '.join(others)} — remove duplicates before retrying"
        )
    if len(others) == 1:
        return others[0]
    return None


def _attached_volids(vmid: str) -> list[str]:
    """Return the list of volume IDs attached to <vmid> per pct config.

    pct config output looks like:
        rootfs: local-zfs:subvol-507-disk-0,size=1G
        mp0: local-zfs:subvol-507-proxvex-config,mp=/config,...
    We extract the first comma-separated token after the colon (the volid).
    """
    pct = _find_pct()
    try:
        result = subprocess.run(
            [pct, "config", str(vmid)],
            capture_output=True, text=True, timeout=5,
        )
    except Exception as e:
        sys.stderr.write(
            f"[resolve_host_volume] pct config {vmid} failed: {e}\n"
        )
        return []
    if result.returncode != 0:
        sys.stderr.write(
            f"[resolve_host_volume] pct config {vmid} exit={result.returncode}: "
            f"{result.stderr.strip()[:200]}\n"
        )
        return []

    volids = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        head, _, rest = line.partition(":")
        if not (head == "rootfs" or (head.startswith("mp") and head[2:].isdigit())):
            continue
        rest = rest.strip()
        volid = rest.split(",", 1)[0].strip()
        if volid:
            volids.append(volid)
    return volids


def resolve_host_volume(hostname: str, volume_key: str, vm_id) -> str:
    """Resolve host-side path for a container volume.

    vm_id is REQUIRED. The lookup is restricted to volumes attached to that
    container's pct config. This prevents picking up orphaned volumes from
    previously destroyed or stopped containers that share the same hostname
    — adopting such a volume is silent data corruption.

    Resolution order within the attached set:
    1. Dedicated managed volume: <hostname>-<volume_key> (OCI-image apps)
    2. App managed volume subdirectory: <hostname>-app/<volume_key> (docker-compose apps)
    """
    if not hostname or not volume_key or vm_id in (None, ""):
        raise RuntimeError(
            f"resolve_host_volume requires hostname, volume_key, vm_id "
            f"(got hostname={hostname!r} volume_key={volume_key!r} vm_id={vm_id!r})"
        )

    pvesm = _find_pvesm()
    vol_mount_root = "/var/lib/pve-vol-mounts"  # keep in sync with vol-common.sh

    attached = _attached_volids(str(vm_id))
    if not attached:
        raise RuntimeError(
            f"resolve_host_volume: vmid {vm_id} has no attached volumes "
            f"(does the container exist?)"
        )

    def _resolve_path(volid: str) -> str | None:
        """Resolve a volid to a host-side directory."""
        vname = volid.split(":", 1)[1] if ":" in volid else volid

        mounted_path = os.path.join(vol_mount_root, vname)
        if os.path.isdir(mounted_path) and os.path.ismount(mounted_path):
            return mounted_path

        try:
            path_result = subprocess.run(
                [pvesm, "path", volid],
                capture_output=True, text=True, timeout=5,
            )
        except Exception as e:
            sys.stderr.write(f"[resolve_host_volume] '{pvesm} path {volid}' failed: {e}\n")
            return None
        if path_result.returncode != 0:
            sys.stderr.write(
                f"[resolve_host_volume] '{pvesm} path {volid}' exit={path_result.returncode}: "
                f"{path_result.stderr.strip()[:200]}\n"
            )
            return None
        path = path_result.stdout.strip()
        if path and os.path.isdir(path):
            return path
        sys.stderr.write(
            f"[resolve_host_volume] '{pvesm} path {volid}' returned '{path}' — not a directory\n"
        )
        return None

    # 1. Dedicated managed volume
    suffix = f"{hostname}-{volume_key}"
    for volid in attached:
        if volid.endswith(suffix):
            path = _resolve_path(volid)
            if path:
                return path

    # 2. App managed volume with subdirectory
    app_suffix = f"{hostname}-app"
    for volid in attached:
        if volid.endswith(app_suffix):
            app_path = _resolve_path(volid)
            if not app_path:
                continue
            for variant in [volume_key, volume_key.replace("-", "_"), volume_key.replace("_", "-")]:
                subdir = os.path.join(app_path, variant)
                if os.path.isdir(subdir):
                    return subdir
            sys.stderr.write(
                f"[resolve_host_volume] found {hostname}-app at {app_path}, "
                f"but no '{volume_key}' subdir (tried variants)\n"
            )

    raise RuntimeError(
        f"resolve_host_volume failed for {hostname}/{volume_key} (vmid {vm_id})"
    )
