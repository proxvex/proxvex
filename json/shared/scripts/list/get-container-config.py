#!/usr/bin/env python3
"""Get configuration for a single LXC container.

Reads /etc/pve/lxc/{vm_id}.conf and parses it using lxc_config_parser_lib.py.
Returns container configuration as VeExecution output.

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Note: Do NOT add "from __future__ import annotations" here - it's already in the library
and must be at the very beginning of the combined file.
"""

import json
import os
from pathlib import Path

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig


def main() -> None:
    vm_id = "{{ previous_vm_id }}"
    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))
    conf_path = base_dir / f"{vm_id}.conf"

    if not conf_path.exists():
        print(json.dumps([{"id": "config", "value": "{}"}]))
        return

    conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
    config = parse_lxc_config(conf_text)
    result = config.to_dict()
    result["vm_id"] = int(vm_id)

    print(json.dumps([{"id": "config", "value": json.dumps(result)}]))


if __name__ == "__main__":
    main()
