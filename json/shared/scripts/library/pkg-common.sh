#!/bin/sh
# Package Installation Common Library
#
# This library provides common functions for package management across
# Alpine Linux (apk) and Debian/Ubuntu (apt).
# It contains only function definitions - no direct execution.
#
# Main functions:
#   1. pkg_detect_os - Detects OS type (alpine, debian, ubuntu)
#   2. pkg_wait_for_network - Waits for network connectivity with retries
#   3. pkg_update_cache - Updates package cache (with skip-if-done flag)
#   4. pkg_install - Installs packages based on OS type
#   5. pkg_add_alpine_community - Enables Alpine community repository
#   6. pkg_wget_retry - wget with timeout and retry logic
#   7. pkg_curl_retry - curl with timeout and retry logic
#   8. pkg_is_installed - Checks if a package is installed
#   9. pkg_get_version_codename - Gets Debian/Ubuntu version codename
#
# Global state variables (set by functions):
#   PKG_OS_TYPE - OS type (alpine, debian, ubuntu)
#   PKG_CACHE_UPDATED - Flag indicating if cache has been updated (0=no, 1=yes)
#
# This library is automatically prepended to scripts that require
# package installation functionality.

# ============================================================================
# GLOBAL STATE
# ============================================================================
PKG_OS_TYPE=""
PKG_CACHE_UPDATED=0

# ============================================================================
# CONFIGURATION CONSTANTS
# ============================================================================
PKG_NETWORK_TIMEOUT=60       # Total seconds to wait for network
PKG_NETWORK_RETRY_DELAY=3    # Seconds between network checks
PKG_DOWNLOAD_TIMEOUT=30      # Timeout for wget/curl operations
PKG_DOWNLOAD_RETRIES=3       # Number of download retry attempts
PKG_DNS_TEST_HOST="dl-cdn.alpinelinux.org"  # Host to test DNS resolution
PKG_LOCK_FILE="/tmp/.pkg-common.lock"
PKG_LOCK_TIMEOUT=120         # Max seconds to wait for lock
PKG_LOCK_POLL_INTERVAL=2     # Seconds between lock polls

# ============================================================================
# INTERNAL: Lock helpers
# Prevents concurrent apk/apt from racing (e.g. hookscript + post_start)
# ============================================================================
_pkg_acquire_lock() {
  _lock_start=$(date +%s)
  _lock_end=$((_lock_start + PKG_LOCK_TIMEOUT))

  while [ "$(date +%s)" -lt "$_lock_end" ]; do
    # Reentrant: already own the lock
    _holder=$(cat "$PKG_LOCK_FILE" 2>/dev/null || true)
    if [ "$_holder" = "$$" ]; then
      return 0
    fi

    # Atomic: create file only if it doesn't exist (noclobber)
    if (set -C; echo $$ > "$PKG_LOCK_FILE") 2>/dev/null; then
      return 0
    fi

    # Check if the holding process is still alive
    if [ -n "$_holder" ] && ! kill -0 "$_holder" 2>/dev/null; then
      echo "Removing stale lock (PID $_holder gone)" >&2
      rm -f "$PKG_LOCK_FILE"
      continue
    fi

    sleep "$PKG_LOCK_POLL_INTERVAL"
  done

  echo "Warning: Could not acquire package lock after ${PKG_LOCK_TIMEOUT}s, proceeding anyway" >&2
  return 0
}

_pkg_release_lock() {
  _holder=$(cat "$PKG_LOCK_FILE" 2>/dev/null || true)
  if [ "$_holder" = "$$" ]; then
    rm -f "$PKG_LOCK_FILE"
  fi
}

# ============================================================================
# 1. pkg_detect_os()
# Detects OS type from /etc/os-release or falls back to package manager check
# Sets: PKG_OS_TYPE (alpine, debian, ubuntu)
# Returns: 0 on success, 1 on unknown OS
# ============================================================================
pkg_detect_os() {
  if [ -n "$PKG_OS_TYPE" ]; then
    return 0  # Already detected
  fi

  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    PKG_OS_TYPE="$ID"
  elif command -v apk >/dev/null 2>&1; then
    PKG_OS_TYPE="alpine"
  elif command -v apt-get >/dev/null 2>&1; then
    PKG_OS_TYPE="debian"
  else
    echo "Error: Unable to detect OS type" >&2
    return 1
  fi

  # Normalize and validate
  case "$PKG_OS_TYPE" in
    alpine|debian|ubuntu)
      return 0
      ;;
    *)
      echo "Error: Unsupported OS type: $PKG_OS_TYPE" >&2
      return 1
      ;;
  esac
}

# ============================================================================
# 2. pkg_wait_for_network([timeout])
# Waits until DNS/network is ready with retries
# Arguments:
#   timeout - Optional timeout in seconds (default: PKG_NETWORK_TIMEOUT)
# Returns: 0 on success, 1 on timeout
# ============================================================================
pkg_wait_for_network() {
  _timeout="${1:-$PKG_NETWORK_TIMEOUT}"
  _start_time=$(date +%s)
  _end_time=$((_start_time + _timeout))
  _retry=1

  echo "Waiting for network connectivity..." >&2

  while [ "$(date +%s)" -lt "$_end_time" ]; do
    # Test 1: Check if resolv.conf exists and has nameservers
    if [ ! -f /etc/resolv.conf ]; then
      echo "  Retry $_retry: /etc/resolv.conf not found, waiting ${PKG_NETWORK_RETRY_DELAY}s..." >&2
      sleep "$PKG_NETWORK_RETRY_DELAY"
      _retry=$((_retry + 1))
      continue
    fi

    if ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
      echo "  Retry $_retry: No nameserver in resolv.conf, waiting ${PKG_NETWORK_RETRY_DELAY}s..." >&2
      sleep "$PKG_NETWORK_RETRY_DELAY"
      _retry=$((_retry + 1))
      continue
    fi

    # Test 2: Try DNS resolution using available tools
    if command -v getent >/dev/null 2>&1; then
      if getent hosts "$PKG_DNS_TEST_HOST" >/dev/null 2>&1; then
        echo "Network is ready (DNS resolution succeeded)" >&2
        return 0
      fi
    elif command -v nslookup >/dev/null 2>&1; then
      if nslookup "$PKG_DNS_TEST_HOST" >/dev/null 2>&1; then
        echo "Network is ready (DNS resolution succeeded)" >&2
        return 0
      fi
    elif command -v ping >/dev/null 2>&1; then
      # Fallback: try ping with short timeout
      if ping -c 1 -W 2 "$PKG_DNS_TEST_HOST" >/dev/null 2>&1; then
        echo "Network is ready (ping succeeded)" >&2
        return 0
      fi
    else
      # No DNS tools available, assume network is ready if resolv.conf exists
      echo "Network check: no DNS tools available, assuming ready" >&2
      return 0
    fi

    echo "  Retry $_retry: DNS not responding, waiting ${PKG_NETWORK_RETRY_DELAY}s..." >&2
    sleep "$PKG_NETWORK_RETRY_DELAY"
    _retry=$((_retry + 1))
  done

  echo "Error: Network not available after ${_timeout}s" >&2
  return 1
}

# ============================================================================
# 3. pkg_update_cache([force])
# Updates package manager cache (apk update / apt-get update)
# Arguments:
#   force - If "true", update even if already done (default: false)
# Returns: 0 on success, non-zero on error
# ============================================================================
pkg_update_cache() {
  _force="${1:-false}"

  # Skip if already updated (unless forced)
  if [ "$PKG_CACHE_UPDATED" = "1" ] && [ "$_force" != "true" ]; then
    echo "Package cache already updated, skipping" >&2
    return 0
  fi

  pkg_detect_os || return 1
  pkg_wait_for_network || return 1

  _pkg_acquire_lock
  echo "Updating package cache for $PKG_OS_TYPE..." >&2

  _rc=0
  case "$PKG_OS_TYPE" in
    alpine)
      if apk update >&2; then
        PKG_CACHE_UPDATED=1
      else
        _rc=1
      fi
      ;;
    debian|ubuntu)
      export DEBIAN_FRONTEND=noninteractive
      if apt-get update -qq >&2; then
        PKG_CACHE_UPDATED=1
      else
        _rc=1
      fi
      ;;
  esac

  _pkg_release_lock

  if [ "$_rc" -ne 0 ]; then
    echo "Error: Failed to update package cache" >&2
    return 1
  fi
  return 0
}

# ============================================================================
# 4. pkg_install(packages...)
# Installs packages based on detected OS type
# Arguments:
#   packages - Space-separated list of package names
# Returns: 0 on success, non-zero on error
# ============================================================================
pkg_install() {
  _packages="$*"

  if [ -z "$_packages" ]; then
    echo "Error: No packages specified" >&2
    return 1
  fi

  pkg_detect_os || return 1

  _pkg_acquire_lock

  # Update cache while holding the lock (skip if already done)
  if [ "$PKG_CACHE_UPDATED" != "1" ]; then
    pkg_wait_for_network || { _pkg_release_lock; return 1; }
    echo "Updating package cache for $PKG_OS_TYPE..." >&2
    case "$PKG_OS_TYPE" in
      alpine) apk update >&2 && PKG_CACHE_UPDATED=1 ;;
      debian|ubuntu) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >&2 && PKG_CACHE_UPDATED=1 ;;
    esac
  fi

  echo "Installing packages: $_packages" >&2

  _rc=0
  case "$PKG_OS_TYPE" in
    alpine)
      # shellcheck disable=SC2086
      apk add --no-cache $_packages >&2 || _rc=$?
      ;;
    debian|ubuntu)
      export DEBIAN_FRONTEND=noninteractive
      # shellcheck disable=SC2086
      apt-get install -y --no-install-recommends $_packages >&2 || _rc=$?
      ;;
  esac

  _pkg_release_lock
  return $_rc
}

# ============================================================================
# 5. pkg_add_alpine_community()
# Enables Alpine community repository
# Returns: 0 on success, non-zero on error
# ============================================================================
pkg_add_alpine_community() {
  pkg_detect_os || return 1

  if [ "$PKG_OS_TYPE" != "alpine" ]; then
    echo "Warning: pkg_add_alpine_community only applies to Alpine Linux" >&2
    return 0
  fi

  if [ ! -f /etc/alpine-release ]; then
    echo "Error: /etc/alpine-release not found" >&2
    return 1
  fi

  _alpine_version=$(cut -d. -f1,2 < /etc/alpine-release)
  _community_url="http://dl-cdn.alpinelinux.org/alpine/v${_alpine_version}/community"

  if [ -f /etc/apk/repositories ]; then
    # Check if community is already enabled (not commented)
    if grep -q "^[^#].*community" /etc/apk/repositories 2>/dev/null; then
      echo "Alpine community repository already enabled" >&2
      return 0
    fi

    # Check if community is commented out
    if grep -q "^#.*community" /etc/apk/repositories 2>/dev/null; then
      # Uncomment community line
      sed -i 's|^#\(.*community\)|\1|' /etc/apk/repositories
      echo "Enabled commented Alpine community repository" >&2
    else
      # Add community repository
      echo "$_community_url" >> /etc/apk/repositories
      echo "Added Alpine community repository: $_community_url" >&2
    fi
  else
    echo "Error: /etc/apk/repositories not found" >&2
    return 1
  fi

  # Force cache update after repo change
  PKG_CACHE_UPDATED=0
  pkg_update_cache
}

# ============================================================================
# 6. pkg_wget_retry(url, output_file)
# Download file using wget with timeout and retry logic
# Arguments:
#   url - URL to download
#   output_file - Path to save downloaded file
# Returns: 0 on success, non-zero on error
# ============================================================================
pkg_wget_retry() {
  _url="$1"
  _output_file="$2"
  _retry=1

  if [ -z "$_url" ] || [ -z "$_output_file" ]; then
    echo "Error: pkg_wget_retry requires url and output_file" >&2
    return 1
  fi

  pkg_wait_for_network || return 1

  while [ "$_retry" -le "$PKG_DOWNLOAD_RETRIES" ]; do
    echo "Downloading $_url (attempt $_retry/$PKG_DOWNLOAD_RETRIES)..." >&2

    if wget -T "$PKG_DOWNLOAD_TIMEOUT" -q -O "$_output_file" "$_url" 2>&1; then
      echo "Download successful" >&2
      return 0
    fi

    echo "  Download failed, retrying in ${PKG_NETWORK_RETRY_DELAY}s..." >&2
    sleep "$PKG_NETWORK_RETRY_DELAY"
    _retry=$((_retry + 1))
  done

  echo "Error: Failed to download $_url after $PKG_DOWNLOAD_RETRIES attempts" >&2
  return 1
}

# ============================================================================
# 7. pkg_curl_retry(url, [output_file])
# Download/fetch using curl with timeout and retry logic
# Arguments:
#   url - URL to fetch
#   output_file - Optional: Path to save (if omitted, outputs to stdout)
# Returns: 0 on success, non-zero on error
# ============================================================================
pkg_curl_retry() {
  _url="$1"
  _output_file="${2:-}"
  _retry=1
  _output_opt=""

  if [ -z "$_url" ]; then
    echo "Error: pkg_curl_retry requires url" >&2
    return 1
  fi

  if [ -n "$_output_file" ]; then
    _output_opt="-o $_output_file"
  fi

  pkg_wait_for_network || return 1

  while [ "$_retry" -le "$PKG_DOWNLOAD_RETRIES" ]; do
    echo "Fetching $_url (attempt $_retry/$PKG_DOWNLOAD_RETRIES)..." >&2

    # shellcheck disable=SC2086
    if curl -fsSL --connect-timeout "$PKG_DOWNLOAD_TIMEOUT" \
         --max-time $((PKG_DOWNLOAD_TIMEOUT * 2)) $_output_opt "$_url" 2>&1; then
      return 0
    fi

    echo "  Fetch failed, retrying in ${PKG_NETWORK_RETRY_DELAY}s..." >&2
    sleep "$PKG_NETWORK_RETRY_DELAY"
    _retry=$((_retry + 1))
  done

  echo "Error: Failed to fetch $_url after $PKG_DOWNLOAD_RETRIES attempts" >&2
  return 1
}

# ============================================================================
# 8. pkg_is_installed(package)
# Check if a package is installed
# Arguments:
#   package - Package name to check
# Returns: 0 if installed, 1 if not
# ============================================================================
pkg_is_installed() {
  _package="$1"

  pkg_detect_os || return 1

  case "$PKG_OS_TYPE" in
    alpine)
      apk info -e "$_package" >/dev/null 2>&1
      ;;
    debian|ubuntu)
      dpkg -l "$_package" 2>/dev/null | grep -q "^ii"
      ;;
  esac
}

# ============================================================================
# 9. pkg_get_version_codename()
# Get the version codename for Debian/Ubuntu (e.g., bookworm, bullseye)
# Outputs: version codename to stdout
# Returns: 0 on success, 1 on error
# ============================================================================
pkg_get_version_codename() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [ -n "${VERSION_CODENAME:-}" ]; then
      echo "$VERSION_CODENAME"
      return 0
    fi
  fi

  if [ -f /etc/debian_version ]; then
    _version=$(cat /etc/debian_version)
    case "$_version" in
      *bookworm*) echo "bookworm" ;;
      *bullseye*) echo "bullseye" ;;
      *buster*) echo "buster" ;;
      *) echo "stable" ;;
    esac
    return 0
  fi

  return 1
}

# ============================================================================
# 10. pkg_set_alpine_mirror(mirror_url)
# Sets the Alpine package mirror URL
# Arguments:
#   mirror_url - Full URL to mirror (e.g., "http://mirror.example.com/alpine")
# Returns: 0 on success, non-zero on error
# ============================================================================
pkg_set_alpine_mirror() {
  _mirror_url="$1"

  pkg_detect_os || return 1

  if [ "$PKG_OS_TYPE" != "alpine" ]; then
    echo "Warning: pkg_set_alpine_mirror only applies to Alpine Linux" >&2
    return 0
  fi

  if [ -z "$_mirror_url" ]; then
    echo "Error: Mirror URL is required" >&2
    return 1
  fi

  if [ ! -f /etc/alpine-release ]; then
    echo "Error: /etc/alpine-release not found" >&2
    return 1
  fi

  _alpine_version=$(cut -d. -f1,2 < /etc/alpine-release)

  # Create new repositories file with mirror
  cat > /etc/apk/repositories <<EOF
${_mirror_url}/v${_alpine_version}/main
${_mirror_url}/v${_alpine_version}/community
EOF

  echo "Set Alpine mirror to: $_mirror_url" >&2

  # Force cache update after mirror change
  PKG_CACHE_UPDATED=0
  return 0
}
