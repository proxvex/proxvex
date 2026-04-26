#!/bin/sh
# Write /etc/proxvex/reload_certificates so the acme-renew loop
# (post-install-acme-renew-on-start.sh) can trigger a graceful nginx reload
# after issuing or renewing a TLS certificate.
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

# For reconfigure: volumes keep the previous container's hostname (set by
# 150-conf-create-storage-volumes-for-lxc.sh), but {{ hostname }} carries the
# scenario's intended new hostname. Look up the actual container hostname via
# pct config so the lookup matches the on-disk volume suffix.
ACTUAL_HOST=""
if [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  ACTUAL_HOST=$(pct config "$VM_ID" 2>/dev/null | awk '/^hostname:/ {print $2; exit}' || true)
fi
[ -z "$ACTUAL_HOST" ] && ACTUAL_HOST="$HOSTNAME"

SAFE_HOST=$(echo "$ACTUAL_HOST" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
VOLUME_DIR=$(resolve_host_volume "$SAFE_HOST" "proxvex")

if [ ! -d "$VOLUME_DIR" ]; then
  echo "Volume directory not found: $VOLUME_DIR" >&2
  exit 0
fi

HOOK_FILE="$VOLUME_DIR/reload_certificates"
cat > "$HOOK_FILE" <<'HOOK'
#!/bin/sh
# Called by the acme-renew loop after a certificate is installed or renewed.
exec nginx -s reload
HOOK
chmod 755 "$HOOK_FILE"

# Align ownership with the volume directory (parent is chowned to the
# mapped app user by template 150).
VOL_OWNER=$(stat -c '%u:%g' "$VOLUME_DIR" 2>/dev/null || echo "0:0")
chown "$VOL_OWNER" "$HOOK_FILE" 2>/dev/null || true

echo "Wrote reload hook: $HOOK_FILE" >&2

cat <<EOF
{"id":"reload_hook","value":"$HOOK_FILE"}
EOF
