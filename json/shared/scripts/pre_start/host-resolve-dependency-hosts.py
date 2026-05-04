#!/usr/bin/env python3
"""Resolve dependency hostnames from LXC container notes.

Scans `/etc/pve/lxc/*.conf` for containers that:
- are managed by proxvex
- match a dependency's application_id
- belong to the same stack (stack_name)

For each found dependency, outputs `<APP_ID_UPPER>_HOST` with the container's hostname.

Fails (exit 1) if any dependency is not found or not running.

Requires lxc_config_parser_lib.py to be prepended via library parameter.

Template variables:
  - app_dependencies: JSON array of dependencies, e.g. [{"application": "postgres"}]
  - stack_name: Primary stack name (legacy, still used as fallback)
  - all_stack_names: JSON array of all selected stack IDs for multi-stack matching
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# Library functions are prepended - these are available:
# - parse_lxc_config(conf_text) -> LxcConfig
# - is_managed_container(conf_text) -> bool


DEPS_RAW = '{{ app_dependencies }}'
STACK_NAME_RAW = '{{ stack_id }}'
ALL_STACK_NAMES_RAW = '{{ all_stack_ids }}'


def get_status(vmid: int) -> str | None:
    """Get container status via pct status."""
    try:
        result = subprocess.run(
            ["pct", "status", str(vmid)],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        out = result.stdout.strip()
        if "status:" in out:
            return out.split("status:", 1)[1].strip() or None
        return out or None
    except Exception:
        return None


def main() -> None:
    # Parse dependencies
    if not DEPS_RAW or DEPS_RAW == "NOT_DEFINED":
        # No dependencies — nothing to resolve
        print(json.dumps([]))
        return

    try:
        deps = json.loads(DEPS_RAW)
    except json.JSONDecodeError:
        print("ERROR: Failed to parse app_dependencies: %s" % DEPS_RAW, file=sys.stderr)
        sys.exit(1)

    if not deps:
        print(json.dumps([]))
        return

    stack_name = STACK_NAME_RAW if STACK_NAME_RAW != "NOT_DEFINED" else ""

    # Build set of all stack names (multi-stack support)
    all_stack_names: set[str] = set()
    if ALL_STACK_NAMES_RAW and ALL_STACK_NAMES_RAW != "NOT_DEFINED":
        try:
            parsed = json.loads(ALL_STACK_NAMES_RAW)
            if isinstance(parsed, list):
                all_stack_names = {s for s in parsed if s}
        except json.JSONDecodeError:
            pass
    if stack_name:
        all_stack_names.add(stack_name)

    # Build set of needed application_ids
    needed = {dep["application"] for dep in deps if "application" in dep}
    if not needed:
        print(json.dumps([]))
        return

    if not all_stack_names and needed:
        print(
            "ERROR: Dependencies require a stack_name but none is set. "
            "Ensure the application or its addons define a stacktype and a matching stack is selected.",
            file=sys.stderr,
        )
        sys.exit(1)

    base_dir = Path(os.environ.get("LXC_MANAGER_PVE_LXC_DIR", "/etc/pve/lxc"))

    # Phase 1: Scan configs for matching containers
    # Key: application_id -> {vm_id, hostname}
    found: dict[str, dict] = {}

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

            if config.application_id not in needed:
                continue

            # Match stack: container must declare membership in any of the
            # selected stack IDs. Multi-stack containers (e.g. zitadel covers
            # postgres+oidc+cloudflare) list one stack id per stacktype.
            config_stack_ids = list(config.stack_ids or [])
            if not any(sid in all_stack_names for sid in config_stack_ids):
                continue

            if not config.hostname:
                print(
                    "WARNING: Container %s (app=%s) has no hostname, skipping"
                    % (vmid_str, config.application_id),
                    file=sys.stderr,
                )
                continue

            # Only consider running containers (skip stopped/old ones)
            status = get_status(int(vmid_str))
            if status != "running":
                print(
                    "Skipping %s (VMID %s, app=%s): status=%s"
                    % (config.hostname, vmid_str, config.application_id, status or "unknown"),
                    file=sys.stderr,
                )
                continue

            # Strip CIDR suffix (e.g. "192.168.4.40/24" → "192.168.4.40").
            # static_ip can also be "dhcp" — in that case there's no usable IP
            # to share, so leave it empty and let downstream callers fall back
            # to the hostname.
            ip_value = ""
            if config.static_ip and "/" in config.static_ip:
                ip_value = config.static_ip.split("/", 1)[0]
            elif config.static_ip and config.static_ip != "dhcp":
                ip_value = config.static_ip

            found[config.application_id] = {
                "vm_id": int(vmid_str),
                "hostname": config.hostname,
                "ip": ip_value,
                "version": config.version or "",
            }

            # Stop scanning if all dependencies found
            if found.keys() >= needed:
                break

    # Phase 1b: Retry without stack filter for missing dependencies.
    # Handles cases where a dependency runs in a different stack
    # (e.g. gptwol/reconf-oidc needs zitadel from stack "default").
    missing = needed - found.keys()
    if missing and base_dir.is_dir():
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
            if config.application_id not in missing:
                continue
            if not config.hostname:
                continue
            status = get_status(int(vmid_str))
            if status != "running":
                continue
            print(
                "WARNING: Dependency %s found in different stack (%s), using anyway"
                % (config.application_id, ",".join(config.stack_ids or []) or "unknown"),
                file=sys.stderr,
            )
            ip_value = ""
            if config.static_ip and "/" in config.static_ip:
                ip_value = config.static_ip.split("/", 1)[0]
            elif config.static_ip and config.static_ip != "dhcp":
                ip_value = config.static_ip
            found[config.application_id] = {
                "vm_id": int(vmid_str),
                "hostname": config.hostname,
                "ip": ip_value,
                "version": config.version or "",
            }
            if found.keys() >= needed:
                break

    # Phase 2: Check for missing dependencies
    missing = needed - found.keys()
    if missing:
        print(
            "ERROR: Dependency containers not found for: %s (stacks=%s)"
            % (", ".join(sorted(missing)), ", ".join(sorted(all_stack_names)) or "default"),
            file=sys.stderr,
        )
        sys.exit(1)

    # Phase 3: Output resolved hostnames, IPs and versions.
    # `_HOST` carries the container hostname (for code paths that need a
    # name, e.g. TLS hostname verification). `_IP` carries the dependency's
    # static IP when available — useful for compose `extra_hosts` entries
    # so docker's embedded DNS can resolve the dependency name even when
    # the host's upstream DNS can't.
    outputs = []
    for app_id, info in found.items():
        prefix = app_id.upper().replace("-", "_")
        outputs.append({"id": "%s_HOST" % prefix, "value": info["hostname"]})
        if info.get("ip"):
            outputs.append({"id": "%s_IP" % prefix, "value": info["ip"]})
        if info["version"]:
            outputs.append({"id": "%s_VERSION" % prefix, "value": info["version"]})
        print(
            "Resolved dependency: %s_HOST=%s _IP=%s version=%s (VMID %d)"
            % (prefix, info["hostname"], info.get("ip") or "n/a", info["version"] or "n/a", info["vm_id"]),
            file=sys.stderr,
        )

    print(json.dumps(outputs))


if __name__ == "__main__":
    main()
