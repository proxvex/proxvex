#!/bin/sh
# Update /etc/hosts entries for a given hostname and optional IPv4/IPv6
#
# This script updates /etc/hosts by:
# 1. Adding or updating hostname entries with IPv4/IPv6 addresses
# 2. Removing old entries if IPs are not provided
# 3. Ensuring proper formatting of /etc/hosts file
#
# Requires:
#   - hostname: Container hostname (from context)
#   - static_ip: IPv4 address (optional)
#   - static_ip6: IPv6 address (optional)
#
# Behavior:
# - If hostname already appears, lines are updated or removed per rules below
# - If one of the IPs is present, edit the line
#
# Output: JSON to stdout (errors to stderr)
exec >&2
# - If only one IP is present, remove the line
# - If both present and one differs, edit the line to new values
# - Remove line completely if neither IPv4 nor IPv6 remains

HOSTS_FILE="/etc/hosts"
HN="{{ hostname }}"
IP4="{{ static_ip }}"
IP6="{{ static_ip6 }}"

if [ -z "$HN" ]; then
  echo "No hostname provided" >&2
  exit 2
fi

# Ensure we work on a temp file and move back to avoid partial writes
TMP_FILE=$(mktemp /tmp/etchosts.XXXXXX) || exit 1
cp "$HOSTS_FILE" "$TMP_FILE" || exit 1

# Function: normalize spaces (collapse multiple spaces to single tab when writing)
normalize_line() {
  echo "$1" | awk '{$1=$1}1'
}

# Collect existing lines that mention the hostname
MATCHING_LINES=$(grep -nE "\b$HN\b" "$TMP_FILE" || true)

# Helper to decide if a line contains an IP
contains_ip() {
  echo "$1" | grep -Eq "(^|[[:space:]])([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]{1,2}))?" && return 0
  echo "$1" | grep -Eq "(^|[[:space:]])([0-9a-fA-F:]+)(/([0-9]{1,3}))?" && return 0
  return 1
}

edit_or_remove_line() {
  LINENUM="$1"
  LINE="$2"

  HAS4=false; HAS6=false
  echo "$LINE" | grep -Eq "(^|[[:space:]])([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]{1,2}))?" && HAS4=true
  echo "$LINE" | grep -Eq "(^|[[:space:]])([0-9a-fA-F:]+)(/([0-9]{1,3}))?" && HAS6=true

  NEWLINE=""
  # Build new desired line according to provided IPs
  if [ -n "$IP4" ] && [ -n "$IP6" ]; then
    NEWLINE="$IP4\t$HN\n$IP6\t$HN"
  elif [ -n "$IP4" ]; then
    NEWLINE="$IP4\t$HN"
  elif [ -n "$IP6" ]; then
    NEWLINE="$IP6\t$HN"
  else
    NEWLINE=""
  fi

  if [ -z "$NEWLINE" ]; then
    # Remove the existing line entirely
    sed -i "${LINENUM}d" "$TMP_FILE"
    return
  fi

  # Decide if we should edit or remove based on presence
  if [ "$HAS4" = true ] && [ "$HAS6" = true ]; then
    # Both present; if one differs, edit to new values
    # Replace the line with new one(s)
    sed -i "${LINENUM}s/.*/$IP4\t$HN/" "$TMP_FILE"
    # add IPv6 entry on next line
    sed -i "${LINENUM}a\
$IP6\t$HN\
" "$TMP_FILE"
  elif [ "$HAS4" = true ] && [ -n "$IP4" ]; then
    sed -i "${LINENUM}s/.*/$IP4\t$HN/" "$TMP_FILE"
  elif [ "$HAS6" = true ] && [ -n "$IP6" ]; then
    sed -i "${LINENUM}s/.*/$IP6\t$HN/" "$TMP_FILE"
  else
    # Only one IP present but not in new values -> remove line
    sed -i "${LINENUM}d" "$TMP_FILE"
  fi
}

if [ -n "$MATCHING_LINES" ]; then
  # Process each matching line
  echo "$MATCHING_LINES" | while IFS=":" read -r LINENUM CONTENT; do
    edit_or_remove_line "$LINENUM" "$CONTENT"
  done
else
  # No existing hostname lines; add new entries if any IPs provided
  if [ -n "$IP4" ]; then
    echo "$IP4\t$HN" >> "$TMP_FILE"
  fi
  if [ -n "$IP6" ]; then
    echo "$IP6\t$HN" >> "$TMP_FILE"
  fi
fi

# Move back
cp "$TMP_FILE" "$HOSTS_FILE" && rm -f "$TMP_FILE"

echo "Updated /etc/hosts for $HN" >&2
exit 0
