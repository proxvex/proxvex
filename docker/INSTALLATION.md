# Docker Compose Installation Guide

## Overview

This directory contains Docker Compose configurations for various services.

**Marker System:** The `docker-compose.yml` files contain `{{ PLACEHOLDER }}` markers for sensitive values. During deployment, the system detects these markers and requires a `.env` file.

## Available Services

| Service | Compose File | Default Port | Description |
|---------|--------------|--------------|-------------|
| PostgreSQL | `postgres.docker-compose.yml` | 5432 | Relational database |
| MariaDB | `mariadb.docker-compose.yml` | 3306 | MySQL-compatible database |
| pgAdmin | `pgadmin.docker-compose.yml` | 5050 | PostgreSQL web admin |
| phpMyAdmin | `phpmyadmin.docker-compose.yml` | 8080 | MariaDB/MySQL web admin |
| PostgREST | `postgrest.docker-compose.yml` | 3000 | REST API for PostgreSQL |
| Zitadel | `Zitadel.docker-compose.yml` | 8080 | Identity provider |
| Mosquitto | `mosquitto.docker-compose.yml` | 1883/9001 | MQTT broker |
| Node-RED | `node-red.docker-compose.yml` | 1880 | Flow-based development |
| Proxvex | `proxvex.docker-compose.yml` | 3000 | Modbus to MQTT bridge |

---

## How the Marker System Works

### docker-compose.yml (contains markers)

```yaml
environment:
  POSTGRES_PASSWORD: "{{ POSTGRES_PASSWORD }}"
```

### .env.template (contains example values)

```env
POSTGRES_PASSWORD=postgres123
```

### During Deployment

1. **create-application**: docker-compose.yml is uploaded
2. **Marker Detection**: System detects `{{ }}` markers
3. **Deployment**: User must upload `.env` with actual values
4. **Substitution**: Markers are replaced with values from `.env`

---

## Creating the .env File

### Step 1: Copy Template

```bash
cp .env.template .env
```

### Step 2: Update Passwords

The `.env.template` contains working example passwords. For production, replace with secure passwords:

```env
# Example (insecure - for testing only):
POSTGRES_PASSWORD=postgres123

# Production (secure):
POSTGRES_PASSWORD=Kj8#mP2$vL9@nQ4&xR7!
```

### Required Variables

| Variable | Required for | Description |
|----------|-------------|-------------|
| `POSTGRES_PASSWORD` | postgres, zitadel, pgadmin | PostgreSQL password |
| `API_LOGIN_PASSWORD` | postgrest | PostgREST login (from create-app-db.sh) |
| `JWT_SECRET` | postgrest | JWT validation (min. 32 characters) |
| `ZITADEL_MASTERKEY` | zitadel | Encryption (min. 32 characters) |
| `MARIADB_ROOT_PASSWORD` | mariadb, phpmyadmin | MariaDB root password |
| `MARIADB_PASSWORD` | mariadb | MariaDB app user password |
| `PGADMIN_DEFAULT_PASSWORD` | pgadmin | pgAdmin login password |

---

## PostgreSQL: Database Structure

The default configuration starts PostgreSQL with the `postgres` superuser. This is fine for quick tests.

**For Production:** Create separate schemas and users per app.

```
postgres (DB)
   ├── nebenkosten_data     ← App data (nebenkosten_app user)
   ├── nebenkosten_api      ← PostgREST API
   ├── homeassistant_data   ← App data (homeassistant_app user)
   ├── homeassistant_api    ← PostgREST API
   └── zitadel (separate DB, own schemas)
```

**Benefits:**
- One PostgREST instance for all APIs
- Schema-based isolation
- Audit trail shows which user/role was active

➡️ **Detailed Guide:** [POSTGRES-SETUP.md](POSTGRES-SETUP.md)

---

## Service-Specific Notes

### Zitadel

- **Schema**: Automatically created (`start-from-init`)
- **Database**: Separately configurable via `ZITADEL_DB` (default: `zitadel`)
- **Admin User**: `admin` / `Password1!` (change after login!)

### pgAdmin

- **Login**: Email from `PGADMIN_EMAIL` (default: `admin@local.dev`)
- **Password**: From `.env` (`PGADMIN_DEFAULT_PASSWORD`)
- PostgreSQL server must be added manually

### MariaDB

Automatically creates:
- Root user with `MARIADB_ROOT_PASSWORD`
- App user (`MARIADB_USER`) with `MARIADB_PASSWORD`
- Database (`MARIADB_DATABASE`) with full privileges for app user

### Mosquitto / Node-RED / Proxvex

- No passwords required in `.env`
- Authentication optional (see section below)

---

## Optional Authentication

### Mosquitto MQTT

```bash
# Create config
mkdir -p ./config
cat > ./config/mosquitto.conf << 'EOF'
listener 1883
allow_anonymous false
password_file /mosquitto/config/passwd
EOF

# Create user
docker exec -it mosquitto mosquitto_passwd -c /mosquitto/config/passwd mqtt_user
```

### Node-RED

```bash
# Generate password hash
docker exec -it node-red npx node-red admin hash-pw

# Add to ./data/settings.js:
adminAuth: {
    type: "credentials",
    users: [{
        username: "admin",
        password: "$2b$08$...",  // Hash from above
        permissions: "*"
    }]
}
```

---

## Optional Variables

These have sensible defaults and only need adjustment if required:

```env
# Ports
POSTGRES_PORT=5432
MARIADB_PORT=3306
PGADMIN_PORT=5050
POSTGREST_PORT=3000
ZITADEL_PORT=8080

# Versions
POSTGRES_VERSION=16-alpine
MARIADB_VERSION=11

# PostgreSQL (optional)
POSTGRES_USER=postgres
POSTGRES_DB=postgres

# MariaDB (optional)
MARIADB_DATABASE=appdb
MARIADB_USER=appuser

# Zitadel (optional)
ZITADEL_EXTERNALDOMAIN=localhost
ZITADEL_DB=zitadel
```

---

## Security Notes

1. **Marker System**: docker-compose.yml contains `{{ }}` markers, `.env` contains actual values
2. **No Superusers**: Create separate users with minimal privileges for apps
3. **Secure Passwords**: Min. 16 characters, special characters, randomly generated
4. **Backup .env**: Store securely, do not commit to Git!
5. **Firewall**: Only expose required ports externally

---

## Files

| File | Description |
|------|-------------|
| `*.docker-compose.yml` | Docker Compose with `{{ }}` markers |
| `.env.template` | All variables with example values |
| `.env.postgres-stack.insecure` | Shared variables for postgres/postgrest/pgadmin/zitadel |
| `.env.mariadb-stack.insecure` | Shared variables for mariadb/phpmyadmin |
| `.env` | Actual credentials (DO NOT commit!) |
| `INSTALLATION.md` | This documentation |
| `POSTGRES-SETUP.md` | PostgreSQL database/schema/user setup |
| `create-app-db.sh` | Script for creating app databases |
