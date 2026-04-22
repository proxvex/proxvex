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
import sys
from pathlib import Path
from typing import Dict, List, Tuple

# Prepended libraries:
#   - parse_lxc_config(conf_text) -> LxcConfig
#   - is_managed_container(conf_text) -> bool
#   - resolve_host_volume(hostname, volume_key) -> str

LXC_ENV_RE = re.compile(r"^lxc\.environment:\s*([^=\s]+)=(.*)$", re.MULTILINE)
# Matches shell-style KEY=VALUE or export KEY=VALUE, with optional single/double
# quotes around the value. Used for on-start-env scripts (on_start.d/*.sh).
SH_VAR_RE = re.compile(
    r"""^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S*))\s*$""",
    re.MULTILINE,
)


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


def read_on_start_env(hostname: str) -> Dict[str, str]:
    """Flatten all KEY=VALUE assignments from every shell script under
    the host's oci-deployer/on_start.d/ directory. Silent best-effort.

    These scripts are written by stack-refresh with replacement method
    `on-start-env` and contain lines like `CF_API_TOKEN="xxx"`.
    """
    try:
        vol = resolve_host_volume(hostname, "oci-deployer")  # noqa: F821
    except Exception as e:
        sys.stderr.write(
            f"[stack-restore-scan] read_on_start_env({hostname}): "
            f"resolve_host_volume failed: {type(e).__name__}: {e}\n"
        )
        return {}

    root = Path(vol) / "on_start.d"
    if not root.is_dir():
        sys.stderr.write(
            f"[stack-restore-scan] read_on_start_env({hostname}): "
            f"on_start.d dir missing or not a dir at {root}\n"
        )
        return {}

    sh_files = sorted(root.rglob("*.sh"))
    sys.stderr.write(
        f"[stack-restore-scan] read_on_start_env({hostname}): "
        f"scanning {len(sh_files)} .sh file(s) under {root}: "
        f"{[f.name for f in sh_files]}\n"
    )

    result: Dict[str, str] = {}
    for sh in sh_files:
        try:
            with open(sh, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except Exception as e:
            sys.stderr.write(
                f"[stack-restore-scan] read_on_start_env({hostname}): "
                f"failed to read {sh}: {e}\n"
            )
            continue
        matches_in_file = 0
        for m in SH_VAR_RE.finditer(text):
            key = m.group(1)
            # One of groups 2/3/4 holds the value depending on quoting style.
            value = m.group(2) if m.group(2) is not None else (
                m.group(3) if m.group(3) is not None else (m.group(4) or "")
            )
            matches_in_file += 1
            if key not in result:
                result[key] = value
        sys.stderr.write(
            f"[stack-restore-scan] read_on_start_env({hostname}): "
            f"{sh.name}: {matches_in_file} KEY=VALUE match(es)\n"
        )
    return result


def _get_rootfs_path(vm_id: int) -> str:
    """Resolve the host-side path to a container's rootfs subvol via pct+pvesm."""
    try:
        r = subprocess.run(
            ["pct", "config", str(vm_id)],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return ""
    if r.returncode != 0:
        return ""
    rootfs_volid = ""
    for line in r.stdout.splitlines():
        if line.startswith("rootfs:"):
            # rootfs: local-zfs:subvol-510-disk-0,size=4G
            rootfs_volid = line.split("rootfs:", 1)[1].strip().split(",", 1)[0]
            break
    if not rootfs_volid:
        return ""
    import shutil
    pvesm = shutil.which("pvesm") or "/usr/sbin/pvesm"
    try:
        r2 = subprocess.run(
            [pvesm, "path", rootfs_volid],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return ""
    if r2.returncode != 0:
        return ""
    return r2.stdout.strip()


def _scan_compose_dir(compose_root: Path, hostname: str, label: str) -> Dict[str, str]:
    """Parse all docker-compose*.yml files under compose_root, flatten env vars."""
    try:
        import yaml
    except ImportError:
        sys.stderr.write(
            f"[stack-restore-scan] read_compose_env({hostname},{label}): "
            f"PyYAML not installed — cannot parse compose files\n"
        )
        return {}

    wanted_names = {"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"}
    all_yaml = list(compose_root.rglob("*.y*ml"))
    matching = [cf for cf in all_yaml if cf.name in wanted_names]
    sys.stderr.write(
        f"[stack-restore-scan] read_compose_env({hostname},{label}): "
        f"found {len(matching)} compose file(s) under {compose_root}: "
        f"{[str(cf.relative_to(compose_root)) for cf in matching]}\n"
    )

    result: Dict[str, str] = {}
    for cf in matching:
        try:
            with open(cf, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
        except Exception as e:
            sys.stderr.write(
                f"[stack-restore-scan] read_compose_env({hostname},{label}): "
                f"failed to parse {cf}: {type(e).__name__}: {e}\n"
            )
            continue
        services = (data or {}).get("services", {}) or {}
        keys_in_file = set()
        for _svc_name, svc in services.items():
            env = (svc or {}).get("environment")
            if isinstance(env, dict):
                for k, v in env.items():
                    keys_in_file.add(k)
                    if k not in result and v is not None:
                        result[k] = str(v)
            elif isinstance(env, list):
                for item in env:
                    if isinstance(item, str) and "=" in item:
                        k, v = item.split("=", 1)
                        keys_in_file.add(k)
                        if k not in result:
                            result[k] = v
        sys.stderr.write(
            f"[stack-restore-scan] read_compose_env({hostname},{label}): "
            f"{cf.name}: {len(keys_in_file)} env key(s), services={list(services.keys())}\n"
        )
    return result


def read_compose_env(hostname: str, vm_id: int) -> Dict[str, str]:
    """Flatten env vars from all docker-compose files the container uses.

    Two sources are tried in order:
      1. The container's oci-deployer managed volume under ``docker-compose/``
         (used by simple compose apps that persist the file in a volume).
      2. The container's rootfs at ``/opt/docker-compose/`` (zitadel, gitea
         and similar deploy their compose into the rootfs at this path —
         see json/applications/zitadel/scripts/post-setup-deployer-in-zitadel.sh).

    The first source that yields a non-empty env dict wins.
    """
    # Source 1: oci-deployer managed volume
    try:
        vol = resolve_host_volume(hostname, "oci-deployer")  # noqa: F821
        compose_root = Path(vol) / "docker-compose"
        if compose_root.is_dir():
            result = _scan_compose_dir(compose_root, hostname, "oci-deployer-vol")
            if result:
                return result
        else:
            sys.stderr.write(
                f"[stack-restore-scan] read_compose_env({hostname}): "
                f"no docker-compose/ dir in oci-deployer volume at {compose_root}\n"
            )
    except Exception as e:
        sys.stderr.write(
            f"[stack-restore-scan] read_compose_env({hostname}): "
            f"oci-deployer volume unavailable: {type(e).__name__}: {e}\n"
        )

    # Source 2: container rootfs /opt/docker-compose/
    rootfs_path = _get_rootfs_path(vm_id)
    if not rootfs_path:
        sys.stderr.write(
            f"[stack-restore-scan] read_compose_env({hostname},rootfs): "
            f"could not resolve rootfs path for vm {vm_id}\n"
        )
        return {}
    compose_root = Path(rootfs_path) / "opt" / "docker-compose"
    if not compose_root.is_dir():
        sys.stderr.write(
            f"[stack-restore-scan] read_compose_env({hostname},rootfs): "
            f"no compose dir at {compose_root}\n"
        )
        return {}
    return _scan_compose_dir(compose_root, hostname, "rootfs")


def main() -> None:
    stack_id = "{{ stack_id }}"
    var_names_raw = "{{ var_names }}"
    consumer_apps_raw = "{{ consumer_apps }}"
    consumer_addons_raw = "{{ consumer_addons }}"

    errors: List[str] = []

    if not stack_id or stack_id == "NOT_DEFINED":
        print(json.dumps([{"id": "scan_results", "value": json.dumps({
            "containers": [],
            "errors": ["stack_id parameter is required"],
        })}]))
        return

    var_names = (
        [v.strip() for v in var_names_raw.split(",") if v.strip()]
        if var_names_raw and var_names_raw != "NOT_DEFINED"
        else []
    )

    # Consumer apps/addons: containers whose application_id ∈ consumer_apps OR
    # whose addons ∩ consumer_addons is non-empty ALSO count as sources for
    # the stack — even if their primary stack-id marker refers to something
    # else (e.g. nginx uses cloudflare via addon-acme but is bound to
    # postgres_production as its primary stack).
    def _split_csv(raw: str) -> List[str]:
        if not raw or raw == "NOT_DEFINED":
            return []
        return [item.strip() for item in raw.split(",") if item.strip()]
    consumer_apps = set(_split_csv(consumer_apps_raw))
    consumer_addons = set(_split_csv(consumer_addons_raw))

    sys.stderr.write(f"[stack-restore-scan] stack_id={stack_id} var_names={var_names} consumer_apps={sorted(consumer_apps)} consumer_addons={sorted(consumer_addons)}\n")

    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    # Phase 1: find all managed containers that reference this stack — either
    # directly (stack_id marker) or indirectly (application_id / addon is a
    # declared consumer of the stacktype).
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
            cfg_app_id = cfg.application_id or ""
            cfg_addons = set(cfg.addons or [])

            direct_match = cfg_stack == stack_id
            app_match = cfg_app_id in consumer_apps
            addon_match = bool(cfg_addons & consumer_addons)

            if not (direct_match or app_match or addon_match):
                sys.stderr.write(f"[stack-restore-scan] vm {vmid_str}: skip (stack_id='{cfg_stack}', app_id='{cfg_app_id}', addons={sorted(cfg_addons)})\n")
                continue
            if not cfg.hostname:
                sys.stderr.write(f"[stack-restore-scan] vm {vmid_str}: skip (no hostname)\n")
                continue
            reason_parts = []
            if direct_match: reason_parts.append("stack_id")
            if app_match: reason_parts.append(f"app:{cfg_app_id}")
            if addon_match: reason_parts.append(f"addon:{','.join(sorted(cfg_addons & consumer_addons))}")
            sys.stderr.write(f"[stack-restore-scan] vm {vmid_str} ({cfg.hostname}): match via {'+'.join(reason_parts)}\n")
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

    # Phase 3: for each selected container, read variable values.
    # Lookup order per variable: LXC env → on_start.d scripts → docker-compose.
    def _mask(value: str) -> str:
        if not value:
            return "<empty>"
        if len(value) <= 4:
            return f"<len={len(value)}>"
        return f"{value[:4]}…<len={len(value)}>"

    results: List[Dict] = []
    for vm_id, hostname, conf_text in selected:
        env = parse_lxc_env(conf_text)
        on_start_env: Dict[str, str] = {}
        on_start_loaded = False
        compose_env: Dict[str, str] = {}
        compose_loaded = False

        values: Dict[str, Dict[str, str]] = {}
        for var in var_names:
            if var in env:
                values[var] = {"value": env[var], "source": "lxc"}
                sys.stderr.write(f"[stack-restore-scan] vm {vm_id}: found '{var}' in lxc.environment ({_mask(env[var])})\n")
                continue
            if not on_start_loaded:
                on_start_env = read_on_start_env(hostname)
                on_start_loaded = True
                sys.stderr.write(f"[stack-restore-scan] vm {vm_id}: on_start.d keys = {sorted(on_start_env.keys())}\n")
            if var in on_start_env:
                values[var] = {"value": on_start_env[var], "source": "on-start"}
                sys.stderr.write(f"[stack-restore-scan] vm {vm_id}: found '{var}' in on_start.d ({_mask(on_start_env[var])})\n")
                continue
            if not compose_loaded:
                compose_env = read_compose_env(hostname, vm_id)
                compose_loaded = True
                sys.stderr.write(f"[stack-restore-scan] vm {vm_id}: compose env keys = {sorted(compose_env.keys())}\n")
            if var in compose_env:
                values[var] = {"value": compose_env[var], "source": "compose"}
                sys.stderr.write(f"[stack-restore-scan] vm {vm_id}: found '{var}' in compose ({_mask(compose_env[var])})\n")
                continue
            sys.stderr.write(f"[stack-restore-scan] vm {vm_id}: '{var}' NOT FOUND (lxc/on-start/compose all checked)\n")

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
