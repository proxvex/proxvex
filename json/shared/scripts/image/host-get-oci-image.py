#!/usr/bin/env python3
"""
Download OCI image from Docker Registry and import to Proxmox storage using skopeo.

This script uses skopeo to download OCI images, which supports all registry features
including S3-compatible storage (required for some Docker Hub images like phpmyadmin).

Parameters (via template variables):
  oci_image (required): OCI image reference (e.g., docker://alpine:latest, docker://phpmyadmin:latest)
  storage (required): Proxmox storage name (default: local)
  registry_username (optional): Username for registry authentication
  registry_password (optional): Password for registry authentication
  platform (optional): Target platform (e.g., linux/amd64, linux/arm64). Default: auto-detected from host via uname -m

Output (JSON to stdout):
    [{"id": "template_path", "value": "storage:vztmpl/image_tag.tar"}, {"id": "ostype", "value": "alpine"}, {"id": "arch", "value": "amd64"}, {"id": "application_id", "value": "proxvex"}, {"id": "application_name", "value": "Proxvex"}, {"id": "oci_image", "value": "ghcr.io/proxvex/proxvex:latest"}, {"id": "oci_image_tag", "value": "0.17.5"}]

All logs and progress go to stderr.

Requirements:
  - skopeo must be installed (apt install skopeo)
"""

import json
import sys
import os
import re
import subprocess
import tempfile
import shutil
import platform as platform_module
from typing import Optional, Tuple

_mirror_active = False  # Set to True if local registry mirror is detected


def get_host_arch() -> str:
    """
    Get host architecture mapped to OCI/Docker format.

    Uses uname -m (via platform.machine()) to detect the host architecture
    and maps it to the OCI format used by skopeo.

    Returns:
        Architecture string (e.g., 'amd64', 'arm64', 'arm/v7')
    """
    machine = platform_module.machine()
    arch_map = {
        'x86_64': 'amd64',
        'amd64': 'amd64',
        'aarch64': 'arm64',
        'arm64': 'arm64',
        'armv7l': 'arm/v7',
        'armv6l': 'arm/v6',
        'i386': '386',
        'i686': '386',
    }
    return arch_map.get(machine, 'amd64')


def get_proxmox_arch(oci_arch: str) -> str:
    """
    Map OCI architecture to Proxmox pct --arch format.

    Args:
        oci_arch: OCI architecture (e.g., 'amd64', 'arm64', 'arm/v7')

    Returns:
        Proxmox architecture string (e.g., 'amd64', 'arm64', 'armhf')
    """
    arch_map = {
        'amd64': 'amd64',
        'arm64': 'arm64',
        'arm/v7': 'armhf',
        'arm/v6': 'armhf',
        '386': 'i386',
    }
    return arch_map.get(oci_arch, 'amd64')

def log(message: str) -> None:
    """Print message to stderr (for logging/progress)."""
    # Always use stderr for non-JSON output (equivalent to >&2 in shell scripts)
    print(message, file=sys.stderr, flush=True)

def error(message: str, exit_code: int = 1) -> None:
    """Print error to stderr and exit."""
    log(f"Error: {message}")
    sys.exit(exit_code)

def check_skopeo() -> bool:
    """Check if skopeo is available."""
    try:
        result = subprocess.run(['which', 'skopeo'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            # Verify it's actually skopeo
            version_result = subprocess.run(['skopeo', '--version'], capture_output=True, text=True, timeout=5)
            if version_result.returncode == 0:
                return True
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

def parse_image_ref(oci_image: str) -> str:
    """
    Parse and normalize OCI image reference for skopeo.
    
    Returns docker:// formatted image reference.
    Examples:
      alpine:latest -> docker://alpine:latest
      docker://alpine:latest -> docker://alpine:latest
      docker://user/image:tag -> docker://user/image:tag
      oci://ghcr.io/owner/repo:tag -> docker://ghcr.io/owner/repo:tag
    """
    # Remove protocol prefix if present
    image_ref = re.sub(r'^[^:]+://', '', oci_image)
    
    # Add docker:// prefix (skopeo accepts docker:// for all registries)
    if not image_ref.startswith('docker://'):
        # Check if it's already a full registry URL
        if '/' in image_ref and ('.' in image_ref.split('/')[0] or ':' in image_ref.split('/')[0]):
            # Has explicit registry (e.g., ghcr.io/image:tag)
            return f"docker://{image_ref}"
        else:
            # Docker Hub image (e.g., alpine:latest or user/image:tag)
            return f"docker://{image_ref}"
    
    return image_ref

# extract_version_from_inspect is provided by oci_version_lib.py (prepended)
# as extract_version_from_labels(). For backwards compatibility:
def extract_version_from_inspect(inspect_output: dict) -> str:
    return extract_version_from_labels(inspect_output)

def extract_application_name_from_inspect(inspect_output: dict) -> Optional[str]:
    """
    Extract application name from skopeo inspect output.

    Tries to find name in Labels:
    - org.opencontainers.image.title
    - io.hass.name

    Returns the extracted name, or None if not found.
    """
    try:
        labels = inspect_output.get('Labels', {})
        if not labels:
            return None

        # Try common name label fields (in order of preference)
        name_fields = [
            'org.opencontainers.image.title',
            'io.hass.name',
        ]

        for field in name_fields:
            if field in labels:
                name = labels[field]
                if name and name.strip():
                    return name.strip()

        return None
    except Exception:
        return None

def detect_ostype_from_inspect(inspect_output: dict) -> str:
    """
    Detect operating system type from skopeo inspect output.
    
    Returns ostype compatible with Proxmox (alpine, debian, ubuntu, fedora, centos).
    """
    try:
        # Check architecture
        arch = inspect_output.get('Architecture', 'amd64')
        
        # Try to detect from labels
        labels = inspect_output.get('Labels', {})
        if labels:
            # Check common label fields
            os_name = labels.get('org.opencontainers.image.title', '').lower()
            description = labels.get('org.opencontainers.image.description', '').lower()
            combined = f"{os_name} {description}"
            
            # Check for known distributions
            if 'alpine' in combined or 'alpine' in labels.get('io.hass.base.name', '').lower():
                return 'alpine'
            elif 'debian' in combined:
                return 'debian'
            elif 'ubuntu' in combined:
                return 'ubuntu'
            elif 'fedora' in combined:
                return 'fedora'
            elif 'centos' in combined or 'rocky' in combined:
                return 'centos'
        
        # Check base image name
        base_name = inspect_output.get('Labels', {}).get('io.hass.base.name', '').lower()
        if 'alpine' in base_name:
            return 'alpine'
        elif 'debian' in base_name:
            return 'debian'
        elif 'ubuntu' in base_name:
            return 'ubuntu'
        
        # Default to alpine (most common for container images)
        return 'alpine'
    except Exception:
        return 'alpine'

def skopeo_inspect(image_ref: str, username: Optional[str] = None, password: Optional[str] = None) -> dict:
    """Inspect image using skopeo and return JSON output."""
    cmd = ['skopeo', 'inspect', '--format', '{{json .}}']

    # Disable TLS verification when using a local registry mirror
    if _mirror_active:
        cmd.append('--tls-verify=false')

    # Add authentication if provided
    if username and password:
        cmd.extend(['--creds', f'{username}:{password}'])
    elif username:
        # Password might be empty, use credentials anyway
        cmd.extend(['--creds', f'{username}'])
    
    cmd.append(image_ref)
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        log(f"Warning: Timeout inspecting image {image_ref}")
        return None
    except subprocess.CalledProcessError as e:
        log(f"Warning: Failed to inspect image {image_ref}: {e.stderr.strip()}")
        return None
    except json.JSONDecodeError as e:
        log(f"Warning: Failed to parse inspect output for {image_ref}: {e}")
        return None

def skopeo_copy(image_ref: str, output_path: str, username: Optional[str] = None, 
                password: Optional[str] = None, platform: Optional[str] = None) -> None:
    """
    Copy image using skopeo to oci-archive format (tarball).
    
    The format is specified by the 'oci-archive:' prefix in the destination URL,
    not by the --format flag.
    
    Args:
        image_ref: Source image reference (docker://image:tag)
        output_path: Output path for oci-archive tarball
        username: Registry username (optional)
        password: Registry password (optional)
        platform: Target platform (e.g., linux/amd64) (optional)
    """
    cmd = ['skopeo', 'copy']

    # Disable TLS verification when using a local registry mirror (self-signed cert)
    if _mirror_active:
        cmd.append('--src-tls-verify=false')

    # Add platform override (platform is always set at this point, either from param or auto-detected)
    if platform:
        # Parse platform (e.g., linux/amd64 -> arch=amd64, os=linux)
        if '/' in platform:
            os_type, arch = platform.split('/', 1)
            cmd.extend(['--override-os', os_type, '--override-arch', arch])
        else:
            # Assume linux if only arch specified
            cmd.extend(['--override-os', 'linux', '--override-arch', platform])
    
    # Add authentication if provided
    if username and password:
        cmd.extend(['--creds', f'{username}:{password}'])
    elif username:
        cmd.extend(['--creds', f'{username}'])
    
    # Use oci-archive: prefix (creates a tarball) - format is determined by the prefix, not --format flag
    cmd.extend([image_ref, f'oci-archive:{output_path}'])
    
    log(f"Downloading image with skopeo...")
    try:
        # skopeo copy outputs progress to stderr, which is fine
        # Capture both stdout and stderr to prevent any output from going to stdout
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800, check=True)
        # Log any stdout/stderr output from skopeo to stderr (not stdout)
        if result.stdout:
            log(f"skopeo stdout: {result.stdout}")
        if result.stderr:
            log(f"skopeo stderr: {result.stderr}")
        log("Image downloaded successfully")
    except subprocess.TimeoutExpired:
        error(f"Timeout downloading image {image_ref}")
    except subprocess.CalledProcessError as e:
        error(f"Failed to download image {image_ref}: {e}")

def import_to_proxmox(storage: str, tarball_path: str, image_name: str, tag: str) -> str:
    """
    Import OCI tarball to Proxmox storage.
    
    Proxmox stores OCI images in the vztmpl cache directory of the storage.
    For local storage, this is typically /var/lib/vz/template/cache/
    
    Returns the template path in format: storage:vztmpl/image_tag.tar
    """
    # Extract image name for filename (last component)
    image_base = image_name.split('/')[-1]
    # Create filename: image_tag.tar (replace : with _ if tag contains it)
    safe_tag = tag.replace(':', '_').replace('/', '_')
    filename = f"{image_base}_{safe_tag}.tar"
    
    # Try to determine storage path
    if storage == "local":
        storage_dir = "/var/lib/vz/template/cache"
    else:
        # Try to get storage path from pvesm status
        try:
            result = subprocess.run(['pvesm', 'status', '-storage', storage], 
                                  capture_output=True, text=True, check=True)
            # For non-local storage, use /mnt/pve/<storage>/template/cache
            storage_dir = f"/mnt/pve/{storage}/template/cache"
        except (subprocess.CalledProcessError, FileNotFoundError):
            # Fallback to local path structure
            storage_dir = f"/var/lib/vz/template/cache"
            log(f"Warning: Could not determine storage path for {storage}, using {storage_dir}")
    
    # Ensure storage directory exists
    os.makedirs(storage_dir, mode=0o755, exist_ok=True)
    
    # Copy tarball to storage directory
    dest_path = os.path.join(storage_dir, filename)
    log(f"Copying OCI tarball to {dest_path}")
    try:
        shutil.copy(tarball_path, dest_path)
        os.chmod(dest_path, 0o644)  # Set permissions
    except PermissionError:
        error(f"Permission denied: Cannot write to {dest_path}. Script needs root or storage access.")
    except Exception as e:
        error(f"Failed to copy tarball to storage: {str(e)}")
    
    # Return template path in Proxmox format
    template_path = f"{storage}:vztmpl/{filename}"
    return template_path

def ensure_ca(deployer_url: str, ve_context: str) -> None:
    """Ensure the deployer CA certificate is trusted on the host.

    Downloads the CA cert from the deployer and installs it so that skopeo
    trusts TLS connections to a local registry mirror (registry-1.docker.io).
    """
    ca_path = "/usr/local/share/ca-certificates/proxvex-ca.crt"
    if os.path.isfile(ca_path):
        return  # Already installed

    if not deployer_url or not ve_context:
        return  # No deployer info available

    ca_url = f"{deployer_url}/api/{ve_context}/ve/certificates/ca/download"
    log(f"Installing deployer CA certificate from {ca_url}")
    try:
        result = subprocess.run(
            ["curl", "-fsSL", "-k", "-o", ca_path, ca_url],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            log(f"Warning: Could not download CA certificate: {result.stderr.strip()}")
            return
        subprocess.run(["update-ca-certificates"], capture_output=True, timeout=10)
        log("CA certificate installed successfully")
    except Exception as e:
        log(f"Warning: CA certificate installation failed: {e}")


def _is_private_ip(ip: str) -> bool:
    """Return True if ip is in RFC1918 / link-local private ranges."""
    try:
        parts = [int(p) for p in ip.split(".")]
        if len(parts) != 4:
            return False
        a, b = parts[0], parts[1]
        if a == 10:
            return True
        if a == 172 and 16 <= b <= 31:
            return True
        if a == 192 and b == 168:
            return True
        return False
    except (ValueError, IndexError):
        return False


def ensure_registry_mirror_hosts() -> bool:
    """Detect whether a local registry mirror is reachable.

    Two activation paths:
      1. The registry hostnames (registry-1.docker.io / ghcr.io) already
         resolve to a private IP — e.g. via dnsmasq redirect or a pre-existing
         /etc/hosts entry. Nothing to write; just flag the mirror active.
      2. A `docker-registry-mirror` host resolves on the network. Add
         /etc/hosts entries so the registry hostnames point at its IP.

    Returns True if a local mirror is considered active.
    """
    import socket
    hosts_path = "/etc/hosts"
    marker = "# proxvex: registry mirror"
    mirror_hosts = ["registry-1.docker.io", "index.docker.io"]

    # Path 1: registry hostnames already point to a private IP (mirror via DNS).
    try:
        ip = socket.gethostbyname("registry-1.docker.io")
        if _is_private_ip(ip):
            log(f"Registry mirror active via DNS: registry-1.docker.io -> {ip}")
            return True
    except socket.gaierror:
        pass

    # Path 2: explicit `docker-registry-mirror` host — patch /etc/hosts.
    try:
        with open(hosts_path, "r") as f:
            if marker in f.read():
                return True  # Already configured

        try:
            ip = socket.gethostbyname("docker-registry-mirror")
        except socket.gaierror:
            return False

        entries = f"{ip} {' '.join(mirror_hosts)}  {marker}\n"
        with open(hosts_path, "a") as f:
            f.write(entries)
        log(f"Added /etc/hosts: {ip} -> {', '.join(mirror_hosts)}")
        return True
    except Exception as e:
        log(f"Warning: Could not update /etc/hosts for registry mirror: {e}")
        return False


def main() -> None:
    """Main function."""
    # Check if skopeo is available
    if not check_skopeo():
        error("skopeo is required but not found. Please install it with: apt install skopeo")

    # Ensure deployer CA is trusted (for local registry mirror)
    deployer_url = "{{ deployer_base_url }}"
    ve_context = "{{ ve_context_key }}"
    if deployer_url and deployer_url != "NOT_DEFINED" and ve_context and ve_context != "NOT_DEFINED":
        ensure_ca(deployer_url, ve_context)

    # Ensure Docker Hub hostnames resolve to local mirror (if present)
    # If mirror is active, disable TLS verification (mirror uses self-signed cert)
    global _mirror_active
    _mirror_active = ensure_registry_mirror_hosts()

    # Get parameters from template variables
    oci_image = "{{ oci_image }}"
    storage = "{{ storage }}"
    registry_username = "{{ registry_username }}"
    registry_password = "{{ registry_password }}"
    platform = "{{ platform }}"
    application_id = "{{ application_id }}"
    target_versions = "{{ target_versions }}"
    
    # Check if template variables were not substituted
    # VariableResolver returns "NOT_DEFINED" when a variable is not found
    # We only check for "NOT_DEFINED" to avoid issues with variable substitution
    # (other checks like oci_image == "{{ oci_image }}" would be replaced by the resolver)
    if not oci_image or oci_image == "NOT_DEFINED":
        error("oci_image parameter is required!")
    
    # Normalize optional parameters (only check for NOT_DEFINED, as other checks would be replaced)
    if not storage or storage == "NOT_DEFINED":
        storage = 'local'  # Default
    
    if not registry_username or registry_username == "NOT_DEFINED":
        registry_username = None
    elif registry_username.strip() == "":
        registry_username = None
    
    if not registry_password or registry_password == "NOT_DEFINED":
        registry_password = None
    elif registry_password.strip() == "":
        registry_password = None
    
    if not platform or platform == "NOT_DEFINED" or platform.strip() == "":
        # Auto-detect host architecture as default
        platform = f'linux/{get_host_arch()}'
        log(f"Auto-detected host platform: {platform}")
    
    # Apply target_versions override (for version-specific upgrades)
    # Format: "main=v1.2.3" — for oci-image apps, "main" maps to the single image
    if target_versions and target_versions != "NOT_DEFINED" and target_versions.strip():
        for part in target_versions.split(","):
            part = part.strip()
            if "=" in part:
                svc, ver = part.split("=", 1)
                if svc.strip() == "main" and ver.strip():
                    # Replace tag in oci_image
                    if ":" in oci_image:
                        oci_image = oci_image.rsplit(":", 1)[0] + ":" + ver.strip()
                    else:
                        oci_image = oci_image + ":" + ver.strip()
                    log(f"Applied target version: {ver.strip()} -> {oci_image}")
                    break

    log(f"Downloading OCI image: {oci_image}")
    if platform:
        log(f"Target platform: {platform}")

    # Parse and normalize image reference
    image_ref = parse_image_ref(oci_image)
    log(f"Image reference: {image_ref}")

    # Extract image name and tag for filename
    image_with_tag = image_ref.replace('docker://', '')
    if ':' in image_with_tag:
        image, tag = image_with_tag.rsplit(':', 1)
    else:
        image = image_with_tag
        tag = "latest"

    # Normalize application_id (optional) - derive from image name if not provided.
    # The literal `{{ application_id }}` check that used to live here was broken:
    # the variable resolver substitutes the placeholder inside the *comparison*
    # string too, so it always matched and the override fired even when the
    # caller did pass an application_id.
    if (
        not application_id
        or application_id == "NOT_DEFINED"
        or not application_id.strip()
    ):
        application_id = image.split('/')[-1]
    
    # Check if image already exists in storage (before download)
    try:
        result = subprocess.run(['pveam', 'list', storage], capture_output=True, text=True, check=True)
        image_base = image.split('/')[-1]
        safe_tag = tag.replace(':', '_').replace('/', '_').replace('\\', '_')
        search_pattern = f"{image_base}_{safe_tag}"
        
        # Check for exact match in pveam output
        lines = result.stdout.split('\n')
        for line in lines:
            if search_pattern in line and '.tar' in line:
                template_path = line.split()[0]  # First field is storage:path
                if search_pattern in template_path:
                    log(f"OCI image already exists: {template_path}")
                    
                    # Detect ostype and version — inspect may fail (rate limit), use defaults
                    log("Inspecting image to detect ostype and application name...")
                    inspect_output = skopeo_inspect(image_ref, registry_username, registry_password)
                    ostype = detect_ostype_from_inspect(inspect_output) if inspect_output else "alpine"
                    application_name = extract_application_name_from_inspect(inspect_output) or "" if inspect_output else ""
                    actual_tag = tag
                    if tag == "latest" or tag.lower() == "latest":
                        resolved = resolve_image_version(f"{image}:{tag}")
                        if resolved and resolved != "unknown":
                            actual_tag = resolved

                    # Extract arch from platform for Proxmox
                    oci_arch = platform.split('/')[-1] if '/' in platform else platform
                    proxmox_arch = get_proxmox_arch(oci_arch)

                    output = [
                        {"id": "template_path", "value": template_path},
                        {"id": "ostype", "value": ostype},
                        {"id": "arch", "value": proxmox_arch},
                        {"id": "application_id", "value": application_id},
                        {"id": "application_name", "value": application_name},
                        {"id": "oci_image", "value": oci_image},
                        {"id": "oci_image_tag", "value": actual_tag}
                    ]
                    print(json.dumps(output))
                    sys.exit(0)
    except (subprocess.CalledProcessError, FileNotFoundError):
        # pveam not available or storage not accessible, continue with download
        log("pveam not available or storage not accessible, continuing with download...")
    
    # Inspect image to extract version (for "latest" tag) and detect ostype
    log("Inspecting image...")
    inspect_output = skopeo_inspect(image_ref, registry_username, registry_password)

    # Resolve version (labels -> digest matching) via oci_version_lib
    actual_tag = tag
    if tag == "latest" or tag.lower() == "latest":
        resolved = resolve_image_version(f"{image}:{tag}")
        if resolved and resolved != "unknown":
            actual_tag = resolved
            log(f"Resolved version: {actual_tag}")

    # Detect ostype and application name (fallback to defaults if inspect failed)
    ostype = detect_ostype_from_inspect(inspect_output) if inspect_output else "alpine"
    log(f"Detected ostype: {ostype}")
    application_name = (extract_application_name_from_inspect(inspect_output) or "") if inspect_output else ""
    if application_name:
        log(f"Extracted application name: {application_name}")

    # Check again if image with actual_tag (extracted version) already exists
    if actual_tag != tag:
        try:
            result = subprocess.run(['pveam', 'list', storage], capture_output=True, text=True, check=True)
            image_base = image.split('/')[-1]
            safe_tag = actual_tag.replace(':', '_').replace('/', '_').replace('\\', '_')
            search_pattern = f"{image_base}_{safe_tag}"

            lines = result.stdout.split('\n')
            for line in lines:
                if search_pattern in line and '.tar' in line:
                    template_path = line.split()[0]
                    if search_pattern in template_path:
                        log(f"OCI image already exists (with extracted version): {template_path} (version: {actual_tag})")
                        # Extract arch from platform for Proxmox
                        oci_arch = platform.split('/')[-1] if '/' in platform else platform
                        proxmox_arch = get_proxmox_arch(oci_arch)

                        output = [
                            {"id": "template_path", "value": template_path},
                            {"id": "ostype", "value": ostype},
                            {"id": "arch", "value": proxmox_arch},
                            {"id": "application_id", "value": application_id},
                            {"id": "application_name", "value": application_name},
                            {"id": "oci_image", "value": oci_image},
                            {"id": "oci_image_tag", "value": actual_tag}
                        ]
                        print(json.dumps(output))
                        sys.exit(0)
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass  # Continue with download
    
    # Download image with skopeo
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create temporary tarball path
        image_base = image.split('/')[-1]
        safe_tag = actual_tag.replace(':', '_').replace('/', '_')
        tarball_filename = f"{image_base}_{safe_tag}.tar"
        tarball_path = os.path.join(tmpdir, tarball_filename)
        
        log(f"Image with version {actual_tag} not found in storage, starting download...")
        skopeo_copy(image_ref, tarball_path, registry_username, registry_password, platform)
        
        # Import to Proxmox storage
        log(f"Importing to Proxmox storage: {storage}")
        template_path = import_to_proxmox(storage, tarball_path, image, actual_tag)
        
        log(f"OCI image successfully imported: {template_path}")
    
    # Extract arch from platform for Proxmox
    oci_arch = platform.split('/')[-1] if '/' in platform else platform
    proxmox_arch = get_proxmox_arch(oci_arch)

    # Output JSON
    output = [
        {"id": "template_path", "value": template_path},
        {"id": "ostype", "value": ostype},
        {"id": "arch", "value": proxmox_arch},
        {"id": "application_id", "value": application_id},
        {"id": "application_name", "value": application_name},
        {"id": "oci_image", "value": oci_image},
        {"id": "oci_image_tag", "value": actual_tag}
    ]
    print(json.dumps(output))
    sys.exit(0)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log("Interrupted by user")
        sys.exit(130)
    except Exception as e:
        error(f"Unexpected error: {str(e)}", 1)
