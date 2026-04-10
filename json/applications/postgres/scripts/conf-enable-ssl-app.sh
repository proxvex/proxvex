#!/bin/sh
# Enable SSL in PostgreSQL configuration
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# Two modes depending on database state:
#   1. Existing DB (postgresql.conf exists): add SSL block directly
#   2. Fresh install (no postgresql.conf): write initdb script for first start
set -eu

HOSTNAME="{{ hostname }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

# Compute effective ownership (prefer mapped values for unprivileged containers)
EFFECTIVE_UID="$UID_VAL"
EFFECTIVE_GID="$GID_VAL"
[ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "NOT_DEFINED" ] && EFFECTIVE_UID="$MAPPED_UID"
[ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "NOT_DEFINED" ] && EFFECTIVE_GID="$MAPPED_GID"

# Sanitize hostname for volume path
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

CERTS_DIR=$(resolve_host_volume "$SAFE_HOST" "certs")
PG_CONF="$(resolve_host_volume "$SAFE_HOST" "data")/pgdata/postgresql.conf"
INITDB_DIR=$(resolve_host_volume "$SAFE_HOST" "initdb")

SSL_START="# oci-lxc-deployer SSL start"
SSL_END="# oci-lxc-deployer SSL end"

# ── Mode 1: Existing database ──────────────────────────────────────
if [ -f "$PG_CONF" ]; then
  # Remove existing SSL block (clean slate)
  sed -i "/${SSL_START}/,/${SSL_END}/d" "$PG_CONF"

  if [ -f "${CERTS_DIR}/fullchain.pem" ] && [ -f "${CERTS_DIR}/privkey.pem" ]; then
    cat >> "$PG_CONF" <<EOF
${SSL_START}
ssl = on
ssl_cert_file = '/certs/fullchain.pem'
ssl_key_file = '/certs/privkey.pem'
${SSL_END}
EOF
    echo "SSL enabled in postgresql.conf" >&2
    echo '[{"id":"ssl_app_enabled","value":"true"}]'
  else
    echo "Certs not found, SSL not enabled" >&2
    echo '[{"id":"ssl_app_enabled","value":"false"}]'
  fi
  exit 0
fi

# ── Mode 2: Fresh install (write initdb script) ────────────────────
if [ ! -d "$INITDB_DIR" ]; then
  echo "initdb volume directory not found at $INITDB_DIR" >&2
  echo '[{"id":"ssl_app_enabled","value":"false"}]'
  exit 0
fi

TARGET="${INITDB_DIR}/enable-ssl.sh"

cat > "$TARGET" <<SSLEOF
#!/bin/sh
# Enable SSL for PostgreSQL (conditional)
# Runs during first-time initialization (docker-entrypoint-initdb.d)

if [ -f /certs/fullchain.pem ] && [ -f /certs/privkey.pem ]; then
  chmod 600 /certs/privkey.pem

  cat >> "\$PGDATA/postgresql.conf" <<EOF

${SSL_START}
ssl = on
ssl_cert_file = '/certs/fullchain.pem'
ssl_key_file = '/certs/privkey.pem'
${SSL_END}
EOF
fi
SSLEOF

chmod 755 "$TARGET"
chown "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$TARGET" 2>/dev/null || true

echo "Wrote enable-ssl.sh to $TARGET" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
