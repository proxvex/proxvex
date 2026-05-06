#!/bin/sh
# List all USB serial ports on the VE host that are not already mapped to running LXC containers
#
# This script lists all USB serial devices by:
# 1. Using lsusb to enumerate USB devices
# 2. Filtering for devices with serial/tty capabilities
# 3. Checking which devices are already mapped to running containers (using library function)
# 4. Formatting as JSON array for enumValues
#
# Output format: JSON array of objects with name and value fields
# Example:
#   [{"name":"FTDI FT232R USB UART (A9XYZ) [0403:6001] — usb-FTDI_FT232R_USB_UART_A9XYZ-if00-port0","value":"/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A9XYZ-if00-port0"}, ...]
# Uses /dev/serial/by-id symlinks for stable selection; the display name is derived from sysfs + lsusb.
#
# Requires:
#   - lsusb: USB utilities (must be installed)
#   - pct: Proxmox Container Toolkit (for checking running containers)
#
# Library: usb-device-common.sh (automatically prepended)
#
# Output: JSON to stdout (errors to stderr)

set -e

SEEN_BYID_FILE="$(mktemp 2>/dev/null || true)"
SEEN_RESOLVED_FILE="$(mktemp 2>/dev/null || true)"
if [ -z "$SEEN_BYID_FILE" ] || [ -z "$SEEN_RESOLVED_FILE" ]; then
  echo "Error: mktemp failed." >&2
  exit 1
fi

cleanup() {
  rm -f "$SEEN_BYID_FILE" "$SEEN_RESOLVED_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# USB devices are optional: a host with no serial adapters or no usb stack
# is a perfectly valid deploy target. Treat each missing prerequisite as
# "no devices available" and emit an empty enum list (`[]`), not an error.
# This keeps applications like modbus2mqtt installable without an attached
# USB adapter — `host_device_path` will simply have no enum values, the
# parameter stays empty, and templates gated by
# `skip_if_all_missing: ["host_device_path"]` (e.g. 110-conf-map-serial)
# auto-skip.
if ! command -v lsusb >/dev/null 2>&1; then
  echo "Note: lsusb not available — assuming no USB devices on this host." >&2
  printf '[]'
  exit 0
fi

if [ ! -d "/sys/bus/usb/devices" ]; then
  echo "Note: /sys/bus/usb/devices missing — assuming no USB devices on this host." >&2
  printf '[]'
  exit 0
fi

# Prefer stable identifiers exposed by udev-generated symlinks. Absence of
# the by-id directory means no serial adapters are currently plugged in.
if [ ! -d "/dev/serial/by-id" ]; then
  echo "Note: /dev/serial/by-id missing — no USB serial adapters plugged in." >&2
  printf '[]'
  exit 0
fi

FIRST=true
printf '['

json_escape() {
  # Escape backslashes + double quotes for JSON string context
  echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

normalize_display() {
  # Make strings human-friendly: underscores to spaces, collapse whitespace, trim
  echo "$1" | tr '_' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}

sysfs_usb_vidpid_from_tty() {
  # Resolve /dev/ttyUSB* or /dev/ttyACM* to a USB device VID:PID via sysfs.
  # Returns empty string if it can't be determined.
  _resolved="$1"
  _tty_base=$(basename "$_resolved")
  _sys_tty="/sys/class/tty/${_tty_base}/device"
  _p=$(readlink -f "$_sys_tty" 2>/dev/null || echo "")
  [ -z "$_p" ] && return 0

  while [ -n "$_p" ] && [ "$_p" != "/" ]; do
    if [ -f "$_p/idVendor" ] && [ -f "$_p/idProduct" ]; then
      _vid=$(cat "$_p/idVendor" 2>/dev/null | tr -d '\n\r' | tr 'A-F' 'a-f')
      _pid=$(cat "$_p/idProduct" 2>/dev/null | tr -d '\n\r' | tr 'A-F' 'a-f')
      if echo "${_vid}:${_pid}" | grep -Eq '^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$'; then
        echo "${_vid}:${_pid}"
        return 0
      fi
      return 0
    fi
    _p=$(dirname "$_p")
  done

  return 0
}

lsusb_lookup_desc() {
  # Best-effort lookup of a human-friendly device description via lsusb.
  # Returns empty string if not found.
  _vid="$1"
  _pid="$2"
  [ -z "$_vid" ] && return 0
  [ -z "$_pid" ] && return 0
  if ! command -v lsusb >/dev/null 2>&1; then
    return 0
  fi

  # Example: "Bus 001 Device 002: ID 1a86:7523 QinHeng Electronics CH340 serial converter"
  lsusb -d "${_vid}:${_pid}" 2>/dev/null \
    | head -n 1 \
    | sed -E 's/^.*ID[[:space:]]+[0-9a-fA-F]{4}:[0-9a-fA-F]{4}[[:space:]]+//'
}

strip_vendor_prefix() {
  # Remove common vendor prefixes from lsusb descriptions.
  # This is heuristic by design; if it doesn't match, it keeps the original.
  echo "$1" | sed -E \
    -e 's/^[^ ]+[[:space:]]+Electronics[[:space:]]+//' \
    -e 's/^[^ ]+[[:space:]]+Corp\.[[:space:]]+//' \
    -e 's/^[^ ]+[[:space:]]+Technology[[:space:]]+Inc\.[[:space:]]+//' \
    -e 's/^[^ ]+[[:space:]]+Inc\.[[:space:]]+//' \
    -e 's/^[^ ]+[[:space:]]+Ltd\.[[:space:]]+//'
}

for BYID in /dev/serial/by-id/*; do
  [ ! -e "$BYID" ] && continue
  [ ! -L "$BYID" ] && continue

  # De-duplicate by-id paths (shouldn't normally happen, but keep output stable)
  if grep -Fqx "$BYID" "$SEEN_BYID_FILE" 2>/dev/null; then
    continue
  fi
  printf '%s\n' "$BYID" >>"$SEEN_BYID_FILE"

  RESOLVED=$(readlink -f "$BYID" 2>/dev/null || echo "")
  [ -z "$RESOLVED" ] && continue

  # De-duplicate resolved target device nodes (aliases can exist)
  if grep -Fqx "$RESOLVED" "$SEEN_RESOLVED_FILE" 2>/dev/null; then
    continue
  fi
  printf '%s\n' "$RESOLVED" >>"$SEEN_RESOLVED_FILE"

  case "$RESOLVED" in
    /dev/ttyUSB*|/dev/ttyACM*)
      ;;
    *)
      continue
      ;;
  esac

  # Output JSON object (name = symlink basename, value = full path)
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    printf ','
  fi

  BYID_BASE=$(basename "$BYID")
  BYID_BASE_DISPLAY=$(normalize_display "$BYID_BASE")
  NAME_TEXT=""
  DESC_TEXT=""

  TTY_SHORT=$(basename "$RESOLVED")
  [ -n "$TTY_SHORT" ] && DESC_TEXT="$TTY_SHORT"

  VIDPID=$(sysfs_usb_vidpid_from_tty "$RESOLVED" | tr -d '\n\r')
  if echo "$VIDPID" | grep -Eq '^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$'; then
    VID=${VIDPID%:*}
    PID=${VIDPID#*:}
    LSUSB_DESC=$(lsusb_lookup_desc "$VID" "$PID" | tr -d '\n\r')
    LSUSB_DESC_STRIPPED=$(strip_vendor_prefix "$LSUSB_DESC")
    LSUSB_DESC_D=$(normalize_display "$LSUSB_DESC_STRIPPED")

    TTY_SHORT=$(basename "$RESOLVED")
    DESC_TEXT="[$VID:$PID]"
    [ -n "$TTY_SHORT" ] && DESC_TEXT="${DESC_TEXT} — ${TTY_SHORT}"

    if [ -n "$LSUSB_DESC_D" ]; then
      NAME_TEXT="$LSUSB_DESC_D"
    else
      NAME_TEXT="$BYID_BASE_DISPLAY"
    fi
  fi

  # Final fallback: derive something readable from the by-id string.
  if [ -z "$NAME_TEXT" ]; then
    FALLBACK="$BYID_BASE"
    FALLBACK="${FALLBACK#usb-}"
    FALLBACK="${FALLBACK%%-if*}"
    FALLBACK=$(normalize_display "$FALLBACK")
    if [ -n "$FALLBACK" ] && [ "$FALLBACK" != "$BYID_BASE" ]; then
      NAME_TEXT="$FALLBACK — $BYID_BASE_DISPLAY"
    else
      NAME_TEXT="$BYID_BASE_DISPLAY"
    fi
  fi

  ESCAPED_NAME=$(json_escape "$NAME_TEXT")
  ESCAPED_DESC=$(json_escape "$DESC_TEXT")
  printf '{"name":"%s","value":"%s","description":"%s"}' "$ESCAPED_NAME" "$BYID" "$ESCAPED_DESC"
done

printf ']'
printf '\n'
exit 0
