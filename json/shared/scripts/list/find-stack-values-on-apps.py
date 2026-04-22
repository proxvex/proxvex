#!/usr/bin/env python3
"""Scan managed containers for a specific stack's variable values.

Used by the "Restore from Applications" flow: given a stack_id and a list of
variable names, walks all managed containers whose notes reference that stack
and reports what value each expected variable has on the container side.

Resolution order per variable:
  1. lxc.environment.<VAR>=<value> in /etc/pve/lxc/<vmid>.conf  (primary)
  2. Any services[*].environment entry in the container's docker-compose.yml
     (fallback, docker-compose apps only)

Per hostname only the running container is considered. Multiple running
containers sharing the same hostname produce an error entry (caller must
resolve the ambiguity).

Requires lxc_config_parser_lib.py and ve-global.py prepended via library.

Template variables:
  stack_id:  Stack ID to match (required, format: <stacktype>_<name>)
  var_names: Newline-separated list of variable names to look up (required)

Output:
  scan_results: JSON-encoded {
      "containers": [{ "vm_id", "hostname", "values": { <var>: { "value", "source" } } }],
      "errors":     [ "human-readable error strings" ]
  }
"""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Tuple

# Prepended libraries:
#   - parse_lxc_config(conf_text) -> LxcConfig
#   - is_managed_container(conf_text) -> bool
#   - resolve_host_volume(hostname, volume_key) -> str

LXC_ENV_RE = re.compile(r"^lxc\.environment:\s*([^=\s]+)=(.*)$", re.MULTILINE)


def pct_status(vmid: int) -> str:
    try:
        r = subprocess.run(
            ["pct", "status", str(vmid)],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return ""
        out = r.stdout.strip()
        return out.split("status:", 1)[1].strip() if "status:" in out else ""
    except Exception:
        return ""


def parse_lxc_env(conf_text: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    for m in LXC_ENV_RE.finditer(conf_text):
        env[m.group(1)] = m.group(2)
    return env


def read_compose_env(hostname: str) -> Dict[str, str]:
    """Flatten all env vars from all services across all compose files under
    the host's oci-deployer volume. Silent best-effort."""
    try:
        vol = resolve_host_volume(hostname, "oci-deployer")  # noqa: F821
    except Exception:
        return {}

    compose_root = Path(vol) / "docker-compose"
    if not compose_root.is_dir():
        return {}

    try:
        import yaml
    except ImportError:
        return {}

    wanted_names = {"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"}
    result: Dict[str, str] = {}

    for cf in compose_root.rglob("*.y*ml"):
        if cf.name not in wanted_names:
            continue
        try:
            with open(cf, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
        except Exception:
            continue
        services = (data or {}).get("services", {}) or {}
        for _svc_name, svc in services.items():
            env = (svc or {}).get("environment")
            if isinstance(env, dict):
                for k, v in env.items():
                    if k not in result and v is not None:
                        result[k] = str(v)
            elif isinstance(env, list):
                for item in env:
                    if isinstance(item, str) and "=" in item:
                        k, v = item.split("=", 1)
                        if k not in result:
                            result[k] = v
    return result


def main() -> None:
    stack_id = "{{ stack_id }}"
    var_names_raw = "{{ var_names }}"

    errors: List[str] = []

    if not stack_id or stack_id == "NOT_DEFINED":
        print(json.dumps([{"id": "scan_results", "value": json.dumps({
            "containers": [],
            "errors": ["stack_id parameter is required"],
        })}]))
        return

    var_names = [v for v in var_names_raw.splitlines() if v.strip()] if var_names_raw and var_names_raw != "NOT_DEFINED" else []

    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    # Phase 1: find all managed containers referencing this stack
    matching: List[Tuple[int, str, str]] = []  # (vm_id, hostname, raw_conf_text)

    if base_dir.is_dir():
        for conf_path in sorted(base_dir.glob("*.conf"), key=lambda p: p.name):
            vmid_str = conf_path.stem
            if not vmid_str.isdigit():
                continue
            try:
                conf_text = conf_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            if not is_managed_container(conf_text):  # noqa: F821
                continue
            cfg = parse_lxc_config(conf_text)  # noqa: F821
            cfg_stack = cfg.stack_id or cfg.stack_name or ""
            if cfg_stack != stack_id:
                continue
            if not cfg.hostname:
                continue
            matching.append((int(vmid_str), cfg.hostname, conf_text))

    # Phase 2: group by hostname, pick the running one; multiple running → error
    by_hostname: Dict[str, List[Tuple[int, str, str]]] = {}
    for item in matching:
        by_hostname.setdefault(item[1], []).append(item)

    selected: List[Tuple[int, str, str]] = []
    for hostname, candidates in by_hostname.items():
        if len(candidates) == 1:
            vm_id, hn, conf = candidates[0]
            status = pct_status(vm_id)
            if status == "running":
                selected.append(candidates[0])
            # If the only candidate is stopped, fall through silently —
            # caller sees it as "no value for this hostname", which will
            # either be satisfied by other hostnames or marked missing.
        else:
            running = [c for c in candidates if pct_status(c[0]) == "running"]
            if len(running) > 1:
                vm_ids = ", ".join(str(c[0]) for c in running)
                errors.append(
                    f"Multiple running containers share hostname '{hostname}' (vmids: {vm_ids}); cannot pick a source."
                )
                continue
            if len(running) == 1:
                selected.append(running[0])

    # Phase 3: for each selected container, read variable values
    results: List[Dict] = []
    for vm_id, hostname, conf_text in selected:
        env = parse_lxc_env(conf_text)
        compose_env: Dict[str, str] = {}
        compose_loaded = False

        values: Dict[str, Dict[str, str]] = {}
        for var in var_names:
            if var in env:
                values[var] = {"value": env[var], "source": "lxc"}
                continue
            if not compose_loaded:
                compose_env = read_compose_env(hostname)
                compose_loaded = True
            if var in compose_env:
                values[var] = {"value": compose_env[var], "source": "compose"}

        results.append({
            "vm_id": vm_id,
            "hostname": hostname,
            "values": values,
        })

    print(json.dumps([{"id": "scan_results", "value": json.dumps({
        "containers": results,
        "errors": errors,
    })}]))


if __name__ == "__main__":
    main()
