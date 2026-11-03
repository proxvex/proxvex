#!/usr/bin/env python3
"""List proxvex-managed LXC containers that are unfinished rebuilds.

A reconfigure/upgrade clones the source container (create-ct-clone.sh) and
only at the end replaces it (replace-ct.sh). If the task stops in between,
the new container exists next to an unreplaced source. Such a container is
found by:
  - tag: the PVE tag proxvex-rebuild-of-<source>, set at clone time and
    removed by replace-ct.sh, or
  - zfs-origin: its rootfs is a ZFS clone (`@oci-clone-<epoch>`) of an
    existing, unlocked, unreplaced managed container — covers containers
    cloned before the tag existed, or
  - hostname: several unreplaced, unlocked containers share a hostname
    (two running, or several of which one runs) and neither of the above
    links them.

Either way the source must still exist and not be marked replaced (an entry
with a missing source is kept only for the tag, so it can be cleared).

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` and
`${LXC_MANAGER_PVE_STORAGE_CFG:-/etc/pve/storage.cfg}` (env overrides for
tests). `pct status` and `zfs get` are best effort: without them statuses are
"unknown" and only tags are detected.

Outputs a single VeExecution output id `unfinished_rebuilds` whose value is a
JSON string representing an array of objects:
  { vm_id, hostname?, status, source_vm_id, source_hostname?, source_status,
    source_exists, detected_by, replaced, superseded_by?, cloned_at? }

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Note: Do NOT add "from __future__ import annotations" here - it's already in the
library and must be at the very beginning of the combined file.
"""

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig
# - is_managed_container(conf_text) -> bool

REBUILD_TAG_RE = re.compile(r"^proxvex-rebuild-of-(\d+)$")
CLONE_ORIGIN_RE = re.compile(r"/subvol-(\d+)-disk-\d+@oci-clone-(\d+)$")


def main_section(conf_text: str) -> str:
    """Config lines before the first [snapshot] section."""
    lines = []
    for line in conf_text.splitlines():
        if line.startswith("["):
            break
        lines.append(line)
    return "\n".join(lines)


def conf_value(section: str, key: str):
    for line in section.splitlines():
        if line.startswith(key + ":"):
            return line.split(":", 1)[1].strip()
    return None


def rebuild_tag_source(section: str):
    tags = conf_value(section, "tags") or ""
    for tag in re.split(r"[;, ]+", tags):
        m = REBUILD_TAG_RE.match(tag)
        if m:
            return m.group(1)
    return None


def zfs_pools(storage_cfg: Path) -> dict:
    """Map zfspool storage id -> pool dataset."""
    pools: dict = {}
    try:
        text = storage_cfg.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return pools
    current = None
    for line in text.splitlines():
        header = re.match(r"^(\w+):\s*(\S+)", line)
        if header:
            current = header.group(2) if header.group(1) == "zfspool" else None
            continue
        prop = re.match(r"^\s+pool\s+(\S+)", line)
        if current and prop:
            pools[current] = prop.group(1)
    return pools


def run(cmd: list):
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    return res.stdout.strip() if res.returncode == 0 else None


def pct_status(vmid: str) -> str:
    out = run(["pct", "status", vmid])
    if out and out.startswith("status:"):
        return out.split(":", 1)[1].strip()
    return "unknown"


def rootfs_origin(section: str, pools: dict):
    """(source vmid, clone epoch) when the rootfs is an oci-clone ZFS clone."""
    rootfs = conf_value(section, "rootfs")
    if not rootfs:
        return None
    volid = rootfs.split(",", 1)[0]
    if ":" not in volid:
        return None
    storage, volume = volid.split(":", 1)
    pool = pools.get(storage)
    if not pool:
        return None
    origin = run(["zfs", "get", "-H", "-o", "value", "origin", "%s/%s" % (pool, volume)])
    m = CLONE_ORIGIN_RE.search(origin or "")
    return (m.group(1), int(m.group(2))) if m else None


def main() -> None:
    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))
    storage_cfg = Path(os.environ.get("LXC_MANAGER_PVE_STORAGE_CFG", "/etc/pve/storage.cfg"))
    pools = zfs_pools(storage_cfg)

    # vmid -> (main section, parsed config) for every managed container
    managed: dict = {}
    if base_dir.is_dir():
        for conf_path in sorted(base_dir.glob("*.conf"), key=lambda p: p.name):
            vmid = conf_path.stem
            if not vmid.isdigit():
                continue
            try:
                conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            if not is_managed_container(conf_text):
                continue
            managed[vmid] = (main_section(conf_text), parse_lxc_config(conf_text))

    entries: list = []
    for vmid, (section, config) in managed.items():
        source = rebuild_tag_source(section)
        detected_by = "tag"
        cloned_at = None
        origin = rootfs_origin(section, pools)
        if origin and (source is None or origin[0] == source):
            cloned_at = origin[1]
        if source is None:
            if not origin or origin[0] == vmid or origin[0] not in managed:
                continue
            source_config = managed[origin[0]][1]
            # A locked source is being handled elsewhere (self-upgrade,
            # replaced-container cleanup, locked-container list).
            if source_config.lock:
                continue
            source = origin[0]
            detected_by = "zfs-origin"
        source_entry = managed.get(source)
        if source_entry and source_entry[1].replaced_at:
            continue

        item: dict = {
            "vm_id": int(vmid),
            "status": pct_status(vmid),
            "source_vm_id": int(source),
            "source_exists": source_entry is not None,
            "source_status": pct_status(source) if source_entry else "missing",
            "detected_by": detected_by,
            "replaced": bool(config.replaced_at),
        }
        if config.hostname:
            item["hostname"] = config.hostname
        if source_entry and source_entry[1].hostname:
            item["source_hostname"] = source_entry[1].hostname
        if cloned_at is not None:
            item["cloned_at"] = datetime.fromtimestamp(cloned_at, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        entries.append(item)

    # hostname: several unreplaced containers share a hostname (two running,
    # or several of which one runs) without a tag or ZFS origin linking them
    # — e.g. clones on non-ZFS storage made before the tag existed. The
    # running one (several running: the highest vmid) counts as the new
    # container, the others as its sources.
    linked = {e["vm_id"] for e in entries} | {e["source_vm_id"] for e in entries}
    by_hostname: dict = {}
    for vmid, (_section, config) in managed.items():
        if config.hostname and not config.replaced_at and not config.lock:
            by_hostname.setdefault(config.hostname, []).append(vmid)
    for hostname, members in by_hostname.items():
        unlinked = [m for m in members if int(m) not in linked]
        if len(members) < 2 or not unlinked:
            continue
        statuses = {m: pct_status(m) for m in members}
        running = [m for m in members if statuses[m] == "running"]
        keeper = max(running or members, key=int)
        sources = [m for m in unlinked if m != keeper]
        if keeper in unlinked and not sources:
            sources = [max((m for m in members if m != keeper), key=int)]
        for source in sources:
            entries.append({
                "vm_id": int(keeper),
                "status": statuses[keeper],
                "source_vm_id": int(source),
                "source_exists": True,
                "source_status": statuses[source],
                "detected_by": "hostname",
                "replaced": False,
                "hostname": hostname,
                "source_hostname": hostname,
            })

    # A newer rebuild of an entry's container (chain source -> new -> newer):
    # the newer one has to be finished first.
    for item in entries:
        for other in entries:
            if other["source_vm_id"] == item["vm_id"]:
                item["superseded_by"] = other["vm_id"]

    print(json.dumps([{"id": "unfinished_rebuilds", "value": json.dumps(entries)}]))


if __name__ == "__main__":
    main()
