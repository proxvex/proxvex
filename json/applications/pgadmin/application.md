# pgAdmin

Web-based PostgreSQL administration and management tool.

## Prerequisites

- A PostgreSQL instance should be deployed separately (e.g. the `postgres` application). pgAdmin connects to it via the network after installation — there is no automatic dependency wiring.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `pgadmin` | Container hostname |
| `http_port` | `5050` | HTTP port (advanced) |
| `https_port` | `5443` | HTTPS port (advanced) |

The container runs as UID 5050 (pgadmin user) using the `dpage/pgadmin4` image.

### Admin Login

The pgAdmin image requires `PGADMIN_DEFAULT_EMAIL` and `PGADMIN_DEFAULT_PASSWORD` environment variables to create the initial admin account. Add these to the `envs` parameter:

```
PGADMIN_DEFAULT_EMAIL=admin@example.com
PGADMIN_DEFAULT_PASSWORD=changeme
```

Without these variables, pgAdmin will fail to start.

### Connecting to PostgreSQL

After installation, add PostgreSQL connections through the pgAdmin web interface:

1. Open pgAdmin at `http://<hostname>:5050`
2. Log in with the email and password from above
3. **Add New Server** — use the PostgreSQL container hostname (e.g. `postgres-default`) as the host, port 5432, and the password from the `postgres` stack

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 5050 | HTTP | pgAdmin web interface |
| 5443 | HTTPS | pgAdmin web interface (when SSL enabled) |

## Upgrade

Pulls new pgAdmin image. Configuration and saved connections are preserved in volumes.

## Reconfigure

Standard reconfigure — allows changing parameters and enabling/disabling addons.
