"""OCI image version resolution library.

Resolves the actual version of an OCI image using skopeo.

Resolution strategy:
1. Cache lookup (test-mode cache or production cache)
2. OCI labels (org.opencontainers.image.version, io.hass.version, etc.)
3. Image tag (if not "latest")
4. Digest matching: compare the digest of "latest" against versioned remote tags

Cache files:
- /tmp/.oci-version-cache.json          — test override (highest priority)
- /var/cache/oci-lxc-deployer/version-cache.json — production cache (24h TTL)

Requires skopeo to be available on the host.
"""

import json
import os
import re
import subprocess
import sys
import time
from typing import Optional

# ============================================================================
# Cache configuration
# ============================================================================
_CACHE_TEST_PATH = "/tmp/.oci-version-cache.json"
_CACHE_PROD_PATH = "/var/cache/oci-lxc-deployer/version-cache.json"
_CACHE_TTL = 86400       # 24 hours
_CACHE_PRUNE_AGE = 604800  # 7 days

_cache: Optional[dict] = None  # lazy-loaded, once per script run


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


# ============================================================================
# Cache helpers
# ============================================================================

def _load_cache() -> dict:
    """Load cache from disk (test path has priority). Lazy, once per run."""
    global _cache
    if _cache is not None:
        return _cache

    for path in (_CACHE_TEST_PATH, _CACHE_PROD_PATH):
        try:
            with open(path, "r") as f:
                _cache = json.load(f)
                if _is_test_mode():
                    _log(f"Using test cache: {path}")
                return _cache
        except Exception:
            continue

    _cache = {"_meta": {}, "versions": {}, "inspect": {}, "tags": {}}
    return _cache


def _save_cache() -> None:
    """Persist cache to production path (skip in test mode). Atomic write."""
    if _cache is None or _is_test_mode():
        return

    # Prune old entries
    now = time.time()
    for section in ("inspect", "tags"):
        store = _cache.get(section, {})
        keys_to_remove = [
            k for k, v in store.items()
            if isinstance(v, dict) and now - v.get("_ts", 0) > _CACHE_PRUNE_AGE
        ]
        for k in keys_to_remove:
            del store[k]

    try:
        cache_dir = os.path.dirname(_CACHE_PROD_PATH)
        os.makedirs(cache_dir, exist_ok=True)
        tmp_path = _CACHE_PROD_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(_cache, f)
        os.rename(tmp_path, _CACHE_PROD_PATH)
    except Exception:
        pass  # best-effort


def _is_test_mode() -> bool:
    """Check if cache is in test mode (pre-populated by test infrastructure)."""
    return (_cache or {}).get("_meta", {}).get("mode") == "test"


def _cache_get_inspect(image_ref: str) -> Optional[dict]:
    """Get cached inspect result if fresh enough."""
    cache = _load_cache()
    entry = cache.get("inspect", {}).get(image_ref)
    if not entry or not isinstance(entry, dict):
        return None
    # Test mode: never expire
    if _is_test_mode():
        return entry
    # Production: check TTL
    if time.time() - entry.get("_ts", 0) > _CACHE_TTL:
        return None
    return entry


def _cache_set_inspect(image_ref: str, data: dict) -> None:
    """Store inspect result in cache."""
    cache = _load_cache()
    cache.setdefault("inspect", {})[image_ref] = {**data, "_ts": time.time()}
    _save_cache()


def _cache_get_tags(image_repo: str) -> Optional[list]:
    """Get cached tag list if fresh enough."""
    cache = _load_cache()
    entry = cache.get("tags", {}).get(image_repo)
    if not entry or not isinstance(entry, dict):
        return None
    if _is_test_mode():
        return entry.get("tags", [])
    if time.time() - entry.get("_ts", 0) > _CACHE_TTL:
        return None
    return entry.get("tags", [])


def _cache_set_tags(image_repo: str, tags: list) -> None:
    """Store tag list in cache."""
    cache = _load_cache()
    cache.setdefault("tags", {})[image_repo] = {"tags": tags, "_ts": time.time()}
    _save_cache()


def _cache_get_version(image_ref: str) -> Optional[str]:
    """Get cached resolved version (direct lookup)."""
    cache = _load_cache()
    return cache.get("versions", {}).get(image_ref)


def _cache_set_version(image_ref: str, version: str) -> None:
    """Store resolved version in cache."""
    cache = _load_cache()
    cache.setdefault("versions", {})[image_ref] = version
    _save_cache()


# ============================================================================
# Skopeo wrappers (with cache)
# ============================================================================

def oci_skopeo_inspect(image_ref: str, timeout: int = 30) -> Optional[dict]:
    """Inspect an image via skopeo. Returns parsed JSON or None on failure.
    Uses cache to avoid redundant API calls."""
    cached = _cache_get_inspect(image_ref)
    if cached is not None:
        return cached

    # Test mode: don't call skopeo, return None (forces graceful fallback)
    if _is_test_mode():
        return None

    cmd = ["skopeo", "inspect", "--override-os", "linux", "--override-arch", "amd64"]
    ref = image_ref if image_ref.startswith("docker://") else f"docker://{image_ref}"
    cmd.append(ref)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        _cache_set_inspect(image_ref, data)
        return data
    except Exception:
        return None


def skopeo_list_tags(image_repo: str, timeout: int = 30) -> list[str]:
    """List all tags for an image repository via skopeo. Uses cache."""
    cached = _cache_get_tags(image_repo)
    if cached is not None:
        return cached

    # Test mode: don't call skopeo
    if _is_test_mode():
        return []

    ref = image_repo if image_repo.startswith("docker://") else f"docker://{image_repo}"
    try:
        result = subprocess.run(
            ["skopeo", "list-tags", ref],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            return []
        data = json.loads(result.stdout)
        tags = data.get("Tags", [])
        _cache_set_tags(image_repo, tags)
        return tags
    except Exception:
        return []


# ============================================================================
# Version extraction helpers
# ============================================================================

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


def _clean_tag(tag: str) -> str:
    """Strip leading 'v' from a version tag."""
    if tag.lower().startswith("v") and len(tag) > 1:
        return tag[1:]
    return tag


# ============================================================================
# Main resolution functions
# ============================================================================

def resolve_version_by_digest(
    image_repo: str,
    latest_digest: str,
    local_tags: Optional[list[str]] = None,
) -> Optional[str]:
    """Match the digest of 'latest' against versioned tags."""
    # Step 1: Check local tags first (fast)
    if local_tags:
        for tag in local_tags:
            if tag == "latest":
                continue
            data = oci_skopeo_inspect(f"{image_repo}:{tag}")
            if data and data.get("Digest") == latest_digest:
                clean = _clean_tag(tag)
                _log(f"Resolved latest -> {clean} via local digest match")
                return clean

    # Step 2: Check top remote version tags
    _log(f"Checking remote tags for {image_repo}...")
    all_tags = skopeo_list_tags(image_repo)
    candidates = _pick_candidate_tags(all_tags)

    for tag in candidates:
        data = oci_skopeo_inspect(f"{image_repo}:{tag}")
        if data and data.get("Digest") == latest_digest:
            clean = _clean_tag(tag)
            _log(f"Resolved latest -> {clean} via remote digest match")
            return clean

    return None


def resolve_image_version(
    image_ref: str,
    local_tags: Optional[list[str]] = None,
) -> str:
    """Resolve the actual version of an OCI image.

    Returns resolved version string, or "unknown" if resolution fails.
    """
    # Split repo:tag
    if ":" in image_ref:
        repo, tag = image_ref.rsplit(":", 1)
    else:
        repo, tag = image_ref, "latest"

    # Non-latest tag: use it directly
    if tag != "latest":
        return _clean_tag(tag)

    # Check version cache first (direct hit, no skopeo needed)
    cached_version = _cache_get_version(image_ref)
    if cached_version:
        _log(f"Resolved version from cache: {cached_version}")
        return cached_version

    # Inspect the image
    data = oci_skopeo_inspect(f"{repo}:{tag}")
    if not data:
        return "unknown"

    # Try labels first
    version = extract_version_from_labels(data)
    if version:
        _log(f"Resolved version from labels: {version}")
        _cache_set_version(image_ref, version)
        return version

    # Try digest matching
    digest = data.get("Digest")
    if digest:
        version = resolve_version_by_digest(repo, digest, local_tags)
        if version:
            _cache_set_version(image_ref, version)
            return version

    return "unknown"
