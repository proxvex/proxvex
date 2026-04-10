# PostgreSQL

PostgreSQL SQL database running as an OCI container.

## Prerequisites

- Stacktype: `postgres` — a stack is created automatically to store the database password
- No dependencies

## Installation

The default image is `postgres:16-alpine`. The container runs as UID 70 (the postgres user).

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `postgres` | Container hostname |
| `volumes` | `data`, `initdb` | Data directory and init scripts |
| `POSTGRES_PASSWORD` | (from stack) | Superuser password, auto-generated |

### Startup Order

PostgreSQL uses `startup_order: 10` to ensure it starts before dependent applications (Zitadel, Gitea, PostgREST).

## Database Creation for Dependent Apps

Applications that depend on PostgreSQL can set `database_name` in their `application.json`. The shared template `187-create-postgres-database` automatically creates the database via `execute_on: application:postgres` before the dependent app starts.

## SSL

PostgreSQL uses `ssl_mode: certs` with the `addon-ssl` addon. When SSL is enabled:

- Server certificate and key are placed at `/etc/ssl/addon/`
- `postgresql.conf` is modified with `ssl = on`, `ssl_cert_file`, and `ssl_key_file`
- Certificate permissions are set for the postgres user (UID 70)

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 5432 | TCP | PostgreSQL wire protocol |

## Upgrade

Pulls a new PostgreSQL image version. Data volumes are preserved. Major version upgrades may require manual `pg_upgrade`.

## Reconfigure

Allows enabling/disabling SSL addon.
