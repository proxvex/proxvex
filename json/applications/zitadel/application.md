# Zitadel

Open-source identity management platform providing OIDC/OAuth2 authentication. Runs as a Docker Compose service with Traefik reverse proxy.

## Prerequisites

- Stacktype: `postgres`, `oidc` — shares database password with PostgreSQL stack, provides OIDC credentials to other apps
- Dependency: `postgres` must be installed in the same stack

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `zitadel` | Container hostname |
| `ZITADEL_EXTERNALDOMAIN` | (= hostname) | Public domain name for URLs and OIDC config |

### Bootstrap Process

On first start, Zitadel runs `start-from-init` which:

1. Creates the database schema in PostgreSQL
2. Creates a default admin user (`admin` with auto-generated password)
3. Generates Personal Access Tokens (PATs) for API access at `/bootstrap/`
4. Sets up the oci-lxc-deployer OIDC project with roles and client credentials

The bootstrap credentials are stored in `/bootstrap/deployer-oidc.json` inside the container and are used by the `addon-oidc` addon to configure other applications.

### What Gets Created Automatically

- **Admin user** — username `admin`, password is `ZITADEL_ADMIN_PASSWORD` (from the `oidc` stack) + `!Aa1` suffix. Retrieve the password from **Stacks > oidc** in the deployer web UI
- **OIDC Project** — "oci-lxc-deployer" with role assertion enabled
- **Service accounts** — `admin-client` and `login-client` with PATs
- **Roles and OIDC apps** — Created per-application when `addon-oidc` is enabled on other apps

### What You Must Do Manually

- Create regular users in the Zitadel web interface
- Assign project roles to users (e.g. `admin` role for deployer access)

## Architecture

```
Traefik (port 8080/1443)
  -> /ui/v2/login/*  -> zitadel-login (Next.js UI)
  -> /*              -> zitadel-api (Go backend, h2c)
```

Traefik rewrites the Host header to `ZITADEL_EXTERNALDOMAIN` so Zitadel accepts requests regardless of the external hostname used to access it (e.g. via port forwarding).

## SSL

Zitadel uses `ssl_mode: native`. When SSL is enabled:

- Traefik switches from HTTP to HTTPS with TLS termination
- HTTP requests are redirected to HTTPS
- `ZITADEL_EXTERNALSECURE` is set to `true`
- Default HTTPS port: 1443

## Startup Order

`startup_order: 20` — starts after PostgreSQL (order 10).

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 8080 | HTTP | Traefik entrypoint (redirects to HTTPS when SSL enabled) |
| 1443 | HTTPS | Traefik HTTPS entrypoint (when SSL enabled) |

## Upgrade

Pulls new Zitadel and zitadel-login images. Database migrations run automatically on startup. Bootstrap data in `/bootstrap/` volume is preserved.

## Reconfigure

Allows enabling/disabling SSL. OIDC configuration is managed through the `addon-oidc` addon on dependent applications, not on Zitadel itself.
