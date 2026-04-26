#!/bin/sh
# Write a minimal default.conf to the conf volume if it's empty.
# nginx refuses to start without at least one .conf file in conf.d/.
# Also fix permissions so nginx (uid 101) can read all config files.
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

# Volumes are named after the container's actual hostname. For reconfigure,
# the new container keeps its previous hostname (volume names aren't
# rewritten), but {{ hostname }} carries the test/scenario's intended
# hostname which doesn't match the on-disk volume suffix. Use the running
# container's hostname when available — falls back to the input value
# otherwise (fresh-install path where pct config is already aligned).
ACTUAL_HOST=""
if [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  ACTUAL_HOST=$(pct config "$VM_ID" 2>/dev/null | awk '/^hostname:/ {print $2; exit}' || true)
fi
[ -z "$ACTUAL_HOST" ] && ACTUAL_HOST="$HOSTNAME"

SAFE_HOST=$(echo "$ACTUAL_HOST" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CONF_DIR=$(resolve_host_volume "$SAFE_HOST" "conf")

if [ ! -d "$CONF_DIR" ]; then
  echo "Volume directory not found: $CONF_DIR" >&2
  exit 0
fi

# Write default.conf if no .conf files exist yet (preserve user config)
if ! ls "$CONF_DIR"/*.conf >/dev/null 2>&1; then
  cat > "$CONF_DIR/default.conf" <<'CONF'
server {
    listen       8080;
    listen  [::]:8080;
    server_name  localhost;

    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}
CONF
  echo "Wrote default.conf to $CONF_DIR" >&2
fi

# Fix permissions: ensure nginx user can read all config files
# (user may have added files as root)
EFF_UID="${MAPPED_UID:-$UID_VALUE}"
EFF_GID="${MAPPED_GID:-$GID_VALUE}"
if [ -n "$EFF_UID" ] && [ "$EFF_UID" != "NOT_DEFINED" ] && [ -n "$EFF_GID" ] && [ "$EFF_GID" != "NOT_DEFINED" ]; then
  chown -R "${EFF_UID}:${EFF_GID}" "$CONF_DIR" 2>/dev/null || true
  chmod 755 "$CONF_DIR" 2>/dev/null || true
  chmod 644 "$CONF_DIR"/*.conf 2>/dev/null || true
  echo "Fixed permissions in $CONF_DIR (${EFF_UID}:${EFF_GID})" >&2
fi
