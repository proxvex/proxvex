#!/bin/sh
# Disable the Samba addon.
#
# Removes on-start drop-in script and stops smbd/nmbd daemons.
#
# Output: errors to stderr only

echo "Disabling Samba addon..." >&2

# Remove the on-start drop-in script
rm -f /etc/lxc-oci-deployer/on_start.d/smbd.sh
echo "Removed on_start.d/smbd.sh" >&2

# Stop samba daemons if running
if pgrep -x smbd >/dev/null 2>&1; then
  echo "Stopping smbd..." >&2
  pkill smbd 2>/dev/null || true
fi
if pgrep -x nmbd >/dev/null 2>&1; then
  echo "Stopping nmbd..." >&2
  pkill nmbd 2>/dev/null || true
fi

echo "Samba addon disabled" >&2
