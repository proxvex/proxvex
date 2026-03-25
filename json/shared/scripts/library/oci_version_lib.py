"""OCI image version resolution library.

Resolves the actual version of an OCI image using skopeo.

Resolution strategy:
1. OCI labels (org.opencontainers.image.version, io.hass.version, etc.)
2. Image tag (if not "latest")
3. Digest matching: compare the digest of "latest" against versioned remote tags

Requires skopeo to be available on the host.
"""

import json
import re
import subprocess
import sys
from typing import Optional


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def oci_skopeo_inspect(image_ref: str, timeout: int = 30) -> Optional[dict]:
    """Inspect an image via skopeo. Returns parsed JSON or None on failure."""
    cmd = ["skopeo", "inspect", "--override-os", "linux", "--override-arch", "amd64"]
    ref = image_ref if image_ref.startswith("docker://") else f"docker://{image_ref}"
    cmd.append(ref)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except Exception:
        return None


def skopeo_list_tags(image_repo: str, timeout: int = 30) -> list[str]:
    """List all tags for an image repository via skopeo."""
    ref = image_repo if image_repo.startswith("docker://") else f"docker://{image_repo}"
    try:
        result = subprocess.run(
            ["skopeo", "list-tags", ref],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            return []
        data = json.loads(result.stdout)
        return data.get("Tags", [])
    except Exception:
        return []


def extract_version_from_labels(inspect_output: dict) -> Optional[str]:
    """Extract version from image labels (multiple common fields)."""
    labels = inspect_output.get("Labels") or {}
    if not labels:
        return None

    version_fields = [
        "org.opencontainers.image.version",
        "io.hass.version",
        "org.opencontainers.image.revision",
        "version",
    ]

    for field in version_fields:
        if field in labels:
            version = labels[field]
            if version and version.strip():
                version = version.strip()
                # Remove leading 'v' for consistency
                if version.lower().startswith("v") and len(version) > 1:
                    version = version[1:]
                return version
    return None


def _pick_candidate_tags(all_tags: list[str], limit: int = 5) -> list[str]:
    """Pick the most likely version tags from a list, sorted descending."""
    version_re = re.compile(r"^v?\d+[\d.]*$")
    versioned = [t for t in all_tags if version_re.match(t)]

    def sort_key(t: str) -> list[int]:
        clean = t.lstrip("v")
        try:
            return [int(x) for x in clean.split(".")]
        except ValueError:
            return [0]

    versioned.sort(key=sort_key, reverse=True)
    return versioned[:limit]


def resolve_version_by_digest(
    image_repo: str,
    latest_digest: str,
    local_tags: Optional[list[str]] = None,
) -> Optional[str]:
    """Match the digest of 'latest' against versioned tags.

    Args:
        image_repo: Image repository (e.g. "postgres", "postgrest/postgrest")
        latest_digest: Digest of the :latest image (from skopeo inspect)
        local_tags: Optional list of locally available version tags to check first
    """
    # Step 1: Check local tags first (fast — typically 1-2 API calls)
    if local_tags:
        for tag in local_tags:
            if tag == "latest":
                continue
            data = oci_skopeo_inspect(f"{image_repo}:{tag}")
            if data and data.get("Digest") == latest_digest:
                clean = tag.lstrip("v") if tag.lower().startswith("v") and len(tag) > 1 else tag
                _log(f"Resolved latest -> {clean} via local digest match")
                return clean

    # Step 2: Check top remote version tags
    _log(f"Checking remote tags for {image_repo}...")
    all_tags = skopeo_list_tags(image_repo)
    candidates = _pick_candidate_tags(all_tags)

    for tag in candidates:
        data = oci_skopeo_inspect(f"{image_repo}:{tag}")
        if data and data.get("Digest") == latest_digest:
            clean = tag.lstrip("v") if tag.lower().startswith("v") and len(tag) > 1 else tag
            _log(f"Resolved latest -> {clean} via remote digest match")
            return clean

    return None


def resolve_image_version(
    image_ref: str,
    local_tags: Optional[list[str]] = None,
) -> str:
    """Resolve the actual version of an OCI image.

    Args:
        image_ref: Full image reference (e.g. "postgres:latest", "postgrest/postgrest:latest")
        local_tags: Optional list of locally available version tags (for faster matching)

    Returns:
        Resolved version string, or "unknown" if resolution fails
    """
    # Split repo:tag
    if ":" in image_ref:
        repo, tag = image_ref.rsplit(":", 1)
    else:
        repo, tag = image_ref, "latest"

    # Non-latest tag: use it directly
    if tag != "latest":
        # Clean up leading 'v'
        if tag.lower().startswith("v") and len(tag) > 1:
            return tag[1:]
        return tag

    # Inspect the image
    data = oci_skopeo_inspect(f"{repo}:{tag}")
    if not data:
        return "unknown"

    # Try labels first
    version = extract_version_from_labels(data)
    if version:
        _log(f"Resolved version from labels: {version}")
        return version

    # Try digest matching
    digest = data.get("Digest")
    if digest:
        version = resolve_version_by_digest(repo, digest, local_tags)
        if version:
            return version

    return "unknown"
