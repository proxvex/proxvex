# PostgREST

Automatic RESTful API from any PostgreSQL database. PostgREST introspects the database schema and generates a complete REST API with endpoints for every table, view, and function in the configured schemas — no code required.

## Prerequisites

- Stacktype: `postgres` — must share a stack with a PostgreSQL instance
- Dependency: `postgres` application must be installed in the same stack

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `postgrest` | Container hostname |
| `http_port` | `3000` | HTTP port (advanced) |
| `https_port` | `3443` | HTTPS port (advanced) |

The compose file is pre-configured with template variables for the PostgreSQL connection (`POSTGRES_HOST`, `POSTGRES_PASSWORD`). These are resolved automatically from the stack.

### Compose Environment Variables

The default compose file supports these variables via `${VAR:-default}` syntax:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGREST_VERSION` | `latest` | PostgREST image tag |
| `POSTGRES_USER` | `postgres` | Database user |
| `POSTGRES_PORT` | `5432` | Database port |
| `POSTGRES_DB` | `postgres` | Database name |
| `PGRST_SCHEMAS` | `public` | Exposed database schemas |
| `PGRST_ANON_ROLE` | `postgres` | PostgreSQL role for unauthenticated requests |

## Authentication

PostgREST does **not** have built-in user authentication. Instead, it delegates authentication to JWT tokens and PostgreSQL roles:

1. **Anonymous access** — Requests without a JWT use the `PGRST_ANON_ROLE` (default: `postgres`). To restrict anonymous access, create a limited PostgreSQL role and set it as the anon role.

2. **JWT authentication** — Clients pass a JWT in the `Authorization: Bearer <token>` header. PostgREST validates the token using a secret (`PGRST_JWT_SECRET`) and switches to the PostgreSQL role specified in the token's `role` claim.

To configure JWT authentication, add these to the compose file environment:

```yaml
PGRST_JWT_SECRET: "<your-secret-or-jwks-url>"
PGRST_JWT_ROLE_CLAIM_KEY: ".role"
```

## SSL

PostgREST uses `ssl_mode: proxy` — the addon-ssl reverse proxy handles HTTPS termination.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3000 | HTTP | PostgREST API |
| 3443 | HTTPS | PostgREST API (when SSL enabled) |

## Upgrade

Pulls new PostgREST Docker image. No data to migrate — PostgREST is stateless and reads the schema from PostgreSQL at startup.

## Reconfigure

Allows enabling/disabling SSL addon. To change the database connection or schemas, upload a modified compose file.
