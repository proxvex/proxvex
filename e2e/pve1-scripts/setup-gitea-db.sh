#!/bin/sh
# setup-gitea-db.sh - Create Gitea database and user on PostgreSQL container
#
# Usage: ./setup-gitea-db.sh <POSTGRES_VMID> <GITEA_DB_PASSWORD>
#
# Creates:
#   - Role 'gitea' with LOGIN and provided password
#   - Database 'giteadb' owned by 'gitea' (UTF8, en_US.UTF-8)
#
# Prerequisites:
#   - PostgreSQL container running on pve1.cluster
#   - SSH access to root@pve1.cluster
#
# Reference: https://docs.gitea.com/installation/database-prep

set -e

PVE_HOST="pve1.cluster"
POSTGRES_VMID="${1}"
GITEA_DB_PASSWORD="${2}"

if [ -z "$POSTGRES_VMID" ] || [ -z "$GITEA_DB_PASSWORD" ]; then
    echo "Usage: $0 <POSTGRES_VMID> <GITEA_DB_PASSWORD>" >&2
    echo "" >&2
    echo "Example: $0 200 'my-secure-password'" >&2
    exit 1
fi

echo "=== Setting up Gitea database on PostgreSQL container $POSTGRES_VMID ==="

# Check if container is running
echo "Checking container status..."
ssh "root@${PVE_HOST}" "pct status ${POSTGRES_VMID}" | grep -q running || {
    echo "ERROR: Container $POSTGRES_VMID is not running" >&2
    exit 1
}

# Check if database already exists
echo "Checking if database 'giteadb' already exists..."
DB_EXISTS=$(ssh "root@${PVE_HOST}" "pct exec ${POSTGRES_VMID} -- \
    docker exec postgres psql -U postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='giteadb'\"" 2>/dev/null || true)

if [ "$DB_EXISTS" = "1" ]; then
    echo "WARNING: Database 'giteadb' already exists. Skipping creation." >&2
    exit 0
fi

# Create role and database
echo "Creating role 'gitea' and database 'giteadb'..."
ssh "root@${PVE_HOST}" "pct exec ${POSTGRES_VMID} -- \
    docker exec postgres psql -U postgres -v ON_ERROR_STOP=1 <<'EOSQL'
-- Create role (scram-sha-256 is default in modern PostgreSQL)
CREATE ROLE gitea WITH LOGIN PASSWORD '${GITEA_DB_PASSWORD}';

-- Create database with UTF-8 encoding
CREATE DATABASE giteadb WITH OWNER gitea TEMPLATE template0 ENCODING UTF8 LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8';

-- Verify
\\c giteadb
SELECT current_database(), current_user;
EOSQL
"

echo ""
echo "=== Gitea database setup complete ==="
echo ""
echo "Connection details:"
echo "  Host:     postgres (or IP of container $POSTGRES_VMID)"
echo "  Port:     5432"
echo "  Database: giteadb"
echo "  User:     gitea"
echo "  SSL:      require"
