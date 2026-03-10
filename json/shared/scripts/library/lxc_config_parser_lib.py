"""LXC Config Parser Library.

Parses Proxmox LXC configuration files including:
- Notes/description with oci-lxc-deployer markers
- ID mappings (lxc.idmap)
- Mount points, hostname, and other config

This is a library - import and use the functions, do not execute directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote


# --- Regex patterns for notes/description parsing ---

MANAGED_RE = re.compile(r"(?:oci-lxc-deployer):managed", re.IGNORECASE)
OCI_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):oci-image\s+(.+?)\s*-->", re.IGNORECASE)
OCI_VISIBLE_RE = re.compile(r"^\s*OCI image:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
HOSTNAME_RE = re.compile(r"^hostname:\s*(.+?)\s*$", re.MULTILINE)
APP_ID_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):application-id\s+(.+?)\s*-->", re.IGNORECASE)
APP_NAME_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):application-name\s+(.+?)\s*-->", re.IGNORECASE)
APP_ID_VISIBLE_RE = re.compile(r"^\s*#?\s*Application\s+ID\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
APP_NAME_VISIBLE_RE = re.compile(r"^\s*#?\s*##\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
VERSION_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):version\s+(.+?)\s*-->", re.IGNORECASE)
ADDON_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):addon\s+(.+?)\s*-->", re.IGNORECASE)
DEPLOYER_INSTANCE_RE = re.compile(r"(?:oci-lxc-deployer):deployer-instance", re.IGNORECASE)
USERNAME_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):username\s+(.+?)\s*-->", re.IGNORECASE)
UID_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):uid\s+(.+?)\s*-->", re.IGNORECASE)
GID_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):gid\s+(.+?)\s*-->", re.IGNORECASE)
STACK_NAME_MARKER_RE = re.compile(r"(?:oci-lxc-deployer):stack-name\s+(.+?)\s*-->", re.IGNORECASE)

# --- Regex patterns for LXC config parsing ---

# lxc.idmap: u 0 100000 65536
IDMAP_RE = re.compile(r"^lxc\.idmap:\s*([ug])\s+(\d+)\s+(\d+)\s+(\d+)\s*$", re.MULTILINE)

# mp0: /mnt/pve/storage/volumes/config,mp=/config
MOUNTPOINT_RE = re.compile(r"^mp(\d+):\s*(.+?),mp=(.+?)(?:,(.*))?$", re.MULTILINE)

# description: URL-encoded or plain text
DESCRIPTION_RE = re.compile(r"^description:\s*(.*)$", re.MULTILINE)

# memory: 512
MEMORY_RE = re.compile(r"^memory:\s*(\d+)\s*$", re.MULTILINE)

# cores: 2
CORES_RE = re.compile(r"^cores:\s*(\d+)\s*$", re.MULTILINE)

# rootfs: local-lvm:vm-123-disk-0,size=4G
ROOTFS_RE = re.compile(r"^rootfs:\s*([^:]+):([^,]+)(?:,size=(\d+)([GMK]?))?", re.MULTILINE)

# net0: name=eth0,bridge=vmbr0,hwaddr=...,ip=10.0.0.100/24,gw=10.0.0.1,...
NET_BRIDGE_RE = re.compile(r"^net\d+:.*bridge=([^,\s]+)", re.MULTILINE)
NET_IP_RE = re.compile(r"^net\d+:.*\bip=([^,\s]+)", re.MULTILINE)
NET_GW_RE = re.compile(r"^net\d+:.*\bgw=([^,\s]+)", re.MULTILINE)


@dataclass
class IdMapping:
    """Represents an lxc.idmap entry."""
    type: str  # 'u' for uid, 'g' for gid
    container_start: int
    host_start: int
    range_size: int


@dataclass
class MountPoint:
    """Represents an LXC mount point (mp0, mp1, etc.)."""
    index: int
    source: str
    target: str
    options: str | None = None


@dataclass
class LxcConfig:
    """Parsed LXC configuration."""
    # Raw config text
    raw_text: str = ""
    decoded_text: str = ""

    # Basic properties
    hostname: str | None = None
    is_managed: bool = False
    is_deployer_instance: bool = False

    # Application info from notes
    oci_image: str | None = None
    application_id: str | None = None
    application_name: str | None = None
    version: str | None = None
    addons: list[str] = field(default_factory=list)

    # User/permission info from notes (for addon reconfiguration)
    username: str | None = None
    uid: str | None = None
    gid: str | None = None

    # Stack info from notes (for dependency discovery)
    stack_name: str | None = None

    # LXC config entries
    id_mappings: list[IdMapping] = field(default_factory=list)
    mount_points: list[MountPoint] = field(default_factory=list)

    # Container resource settings (from LXC config)
    memory: int | None = None  # in MB
    cores: int | None = None
    rootfs_storage: str | None = None
    disk_size: str | None = None  # e.g. "4G"
    bridge: str | None = None
    static_ip: str | None = None  # e.g. "10.0.0.100/24" (None if "dhcp")
    static_gw: str | None = None  # e.g. "10.0.0.1"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result: dict[str, Any] = {
            "is_managed": self.is_managed,
        }
        if self.is_deployer_instance:
            result["is_deployer_instance"] = True
        if self.hostname:
            result["hostname"] = self.hostname
        if self.oci_image:
            result["oci_image"] = self.oci_image
        if self.application_id:
            result["application_id"] = self.application_id
        if self.application_name:
            result["application_name"] = self.application_name
        if self.version:
            result["version"] = self.version
        if self.addons:
            result["addons"] = self.addons
        if self.username:
            result["username"] = self.username
        if self.uid:
            result["uid"] = self.uid
        if self.gid:
            result["gid"] = self.gid
        if self.stack_name:
            result["stack_name"] = self.stack_name
        if self.memory is not None:
            result["memory"] = self.memory
        if self.cores is not None:
            result["cores"] = self.cores
        if self.rootfs_storage:
            result["rootfs_storage"] = self.rootfs_storage
        if self.disk_size:
            result["disk_size"] = self.disk_size
        if self.bridge:
            result["bridge"] = self.bridge
        if self.static_ip:
            result["static_ip"] = self.static_ip
        if self.static_gw:
            result["static_gw"] = self.static_gw
        if self.id_mappings:
            result["id_mappings"] = [
                {
                    "type": m.type,
                    "container_start": m.container_start,
                    "host_start": m.host_start,
                    "range_size": m.range_size,
                }
                for m in self.id_mappings
            ]
        if self.mount_points:
            result["mount_points"] = [
                {
                    "index": mp.index,
                    "source": mp.source,
                    "target": mp.target,
                    "options": mp.options,
                }
                for mp in self.mount_points
            ]
        return result


def _extract_from_patterns(text: str, patterns: list[re.Pattern[str]]) -> str | None:
    """Try multiple patterns and return the first match."""
    for pattern in patterns:
        m = pattern.search(text)
        if m:
            val = m.group(1).strip()
            if val:
                return val
    return None


def _extract_all_matches(text: str, pattern: re.Pattern[str]) -> list[str]:
    """Extract all matches from a pattern."""
    matches = pattern.findall(text)
    return [m.strip() for m in matches if m.strip()]


def _normalize_config_text(conf_text: str) -> str:
    """Normalize config text by expanding escaped newlines."""
    # Proxmox LXC config "description:" lines often encode newlines as literal "\\n"
    return conf_text.replace("\\n", "\n")


def _decode_config_text(conf_text: str) -> str:
    """URL-decode config text (for description field)."""
    return unquote(conf_text)


def parse_id_mappings(conf_text: str) -> list[IdMapping]:
    """Parse lxc.idmap entries from config text."""
    mappings = []
    for match in IDMAP_RE.finditer(conf_text):
        mappings.append(IdMapping(
            type=match.group(1),
            container_start=int(match.group(2)),
            host_start=int(match.group(3)),
            range_size=int(match.group(4)),
        ))
    return mappings


def parse_mount_points(conf_text: str) -> list[MountPoint]:
    """Parse mp0, mp1, etc. mount point entries."""
    mount_points = []
    for match in MOUNTPOINT_RE.finditer(conf_text):
        mount_points.append(MountPoint(
            index=int(match.group(1)),
            source=match.group(2),
            target=match.group(3),
            options=match.group(4) if match.group(4) else None,
        ))
    return sorted(mount_points, key=lambda mp: mp.index)


def parse_lxc_config(conf_text: str) -> LxcConfig:
    """Parse a complete LXC configuration file.

    Args:
        conf_text: Raw content of the .conf file

    Returns:
        LxcConfig object with all parsed data
    """
    config = LxcConfig()
    config.raw_text = conf_text

    # Normalize and decode for notes parsing
    normalized = _normalize_config_text(conf_text)
    decoded = _decode_config_text(normalized)
    config.decoded_text = decoded

    # Check if managed
    config.is_managed = bool(
        MANAGED_RE.search(normalized) or MANAGED_RE.search(decoded)
    )

    # Check if deployer instance
    config.is_deployer_instance = bool(
        DEPLOYER_INSTANCE_RE.search(normalized) or DEPLOYER_INSTANCE_RE.search(decoded)
    )

    # Parse hostname (from config, not notes)
    hostname_match = HOSTNAME_RE.search(normalized)
    if hostname_match:
        config.hostname = hostname_match.group(1).strip() or None

    # Parse OCI image from notes
    config.oci_image = (
        _extract_from_patterns(decoded, [OCI_MARKER_RE, OCI_VISIBLE_RE]) or
        _extract_from_patterns(normalized, [OCI_MARKER_RE, OCI_VISIBLE_RE])
    )

    # Parse application info from notes
    config.application_id = (
        _extract_from_patterns(decoded, [APP_ID_MARKER_RE, APP_ID_VISIBLE_RE]) or
        _extract_from_patterns(normalized, [APP_ID_MARKER_RE, APP_ID_VISIBLE_RE])
    )

    config.application_name = (
        _extract_from_patterns(decoded, [APP_NAME_MARKER_RE, APP_NAME_VISIBLE_RE]) or
        _extract_from_patterns(normalized, [APP_NAME_MARKER_RE, APP_NAME_VISIBLE_RE])
    )

    config.version = (
        _extract_from_patterns(decoded, [VERSION_MARKER_RE]) or
        _extract_from_patterns(normalized, [VERSION_MARKER_RE])
    )

    # Parse addons from notes (can have multiple)
    addons_decoded = _extract_all_matches(decoded, ADDON_MARKER_RE)
    addons_normalized = _extract_all_matches(normalized, ADDON_MARKER_RE)
    # Combine and deduplicate while preserving order
    seen = set()
    config.addons = []
    for addon in addons_decoded + addons_normalized:
        if addon not in seen:
            seen.add(addon)
            config.addons.append(addon)

    # Parse user/permission info from notes (for addon reconfiguration)
    config.username = (
        _extract_from_patterns(decoded, [USERNAME_MARKER_RE]) or
        _extract_from_patterns(normalized, [USERNAME_MARKER_RE])
    )
    config.uid = (
        _extract_from_patterns(decoded, [UID_MARKER_RE]) or
        _extract_from_patterns(normalized, [UID_MARKER_RE])
    )
    config.gid = (
        _extract_from_patterns(decoded, [GID_MARKER_RE]) or
        _extract_from_patterns(normalized, [GID_MARKER_RE])
    )

    # Parse stack name from notes
    config.stack_name = (
        _extract_from_patterns(decoded, [STACK_NAME_MARKER_RE]) or
        _extract_from_patterns(normalized, [STACK_NAME_MARKER_RE])
    )

    # Parse LXC config entries (from raw/normalized, not decoded)
    config.id_mappings = parse_id_mappings(normalized)
    config.mount_points = parse_mount_points(normalized)

    # Parse container resource settings from LXC config
    memory_match = MEMORY_RE.search(normalized)
    if memory_match:
        config.memory = int(memory_match.group(1))

    cores_match = CORES_RE.search(normalized)
    if cores_match:
        config.cores = int(cores_match.group(1))

    rootfs_match = ROOTFS_RE.search(normalized)
    if rootfs_match:
        config.rootfs_storage = rootfs_match.group(1)
        size_val = rootfs_match.group(3)
        size_unit = rootfs_match.group(4) or "G"
        if size_val:
            config.disk_size = f"{size_val}{size_unit}"

    bridge_match = NET_BRIDGE_RE.search(normalized)
    if bridge_match:
        config.bridge = bridge_match.group(1)

    ip_match = NET_IP_RE.search(normalized)
    if ip_match:
        ip_val = ip_match.group(1)
        if ip_val.lower() != "dhcp":
            config.static_ip = ip_val

    gw_match = NET_GW_RE.search(normalized)
    if gw_match:
        config.static_gw = gw_match.group(1)

    return config


def is_managed_container(conf_text: str) -> bool:
    """Quick check if a config file represents a managed container."""
    normalized = _normalize_config_text(conf_text)
    decoded = _decode_config_text(normalized)
    return bool(MANAGED_RE.search(normalized) or MANAGED_RE.search(decoded))
