# Nginx

Nginx Unprivileged reverse proxy and web server.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `nginx` | Container hostname |
| `volumes` | `conf=/etc/nginx/conf.d` | Configuration directory |

The container runs as UID 101 (nginx user) using the `nginxinc/nginx-unprivileged` image, which listens on port 8080 instead of 80.

## Configuration

Upload `.conf` files to the `conf` volume at `/etc/nginx/conf.d/`. These are loaded automatically by the nginx `include` directive.

To update the configuration after deployment:

1. **Reconfigure** — Change parameters or addons, the container is cloned with existing volumes
2. **Direct edit** — SSH into the PVE host and edit files in the volume directory, then restart the container

## OIDC Authentication

Enable the `addon-oidc` addon to protect nginx with Zitadel authentication. OIDC configuration is injected as environment variables into the container. The callback path is `/oauth2/callback`.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 8080 | HTTP | Nginx (unprivileged port) |

## Addons

| Addon | Description |
|-------|-------------|
| `addon-oidc` | OpenID Connect authentication via Zitadel |

## Upgrade

Pulls new nginx image. Configuration in the `conf` volume is preserved.
