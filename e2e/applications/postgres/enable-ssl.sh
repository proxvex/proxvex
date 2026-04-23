#!/bin/sh
# Enable SSL for PostgreSQL
# Runs during first-time initialization (docker-entrypoint-initdb.d)
chmod 600 /certs/server.key

cat >> "$PGDATA/postgresql.conf" <<EOF

# SSL Configuration (added by proxvex)
ssl = on
ssl_cert_file = '/certs/server.crt'
ssl_key_file = '/certs/server.key'
EOF
