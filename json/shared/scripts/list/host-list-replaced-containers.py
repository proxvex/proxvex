#!/usr/bin/env python3
"""List proxvex-managed LXC containers that are marked as replaced.

Scans `${LXC_MANAGER_PVE_LXC_DIR:-/etc/pve/lxc}/*.conf` (env override supported
for tests). A container is included only when it carries BOTH markers:
  - <!-- proxvex:managed -->
  - <!-- proxvex:replaced-at <ISO8601> -->

Outputs a single VeExecution output id `replaced_containers` whose value is a
JSON string representing an array of objects:
  { vm_id, hostname?, replaced_at, replaced_by?, lock? }

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Note: Do NOT add "from __future__ import annotations" here - it's already in the
library and must be at the very beginning of the combined file.
"""

import json
import os
from pathlib import Path

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig
# - is_managed_container(conf_text) -> bool


def main() -> None:
    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    containers: list[dict] = []

    if base_dir.is_dir():
        for conf_path in sorted(base_dir.glob("*.conf"), key=lambda p: p.name):
            vmid_str = conf_path.stem
            if not vmid_str.isdigit():
                continue

            try:
                conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            if not is_managed_container(conf_text):
                continue

            config = parse_lxc_config(conf_text)
            if not config.replaced_at:
                continue

            item: dict = {
                "vm_id": int(vmid_str),
                "replaced_at": config.replaced_at,
            }
            if config.hostname:
                item["hostname"] = config.hostname
            if config.replaced_by:
                item["replaced_by"] = config.replaced_by
            if config.lock:
                item["lock"] = config.lock
            containers.append(item)

    print(json.dumps([{"id": "replaced_containers", "value": json.dumps(containers)}]))


if __name__ == "__main__":
    main()
