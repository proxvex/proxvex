# Gitea

Self-hosted Git service with web UI, code review, team collaboration, package registry, and CI/CD.

## Prerequisites

- Stacktype: `postgres`, `gitea` — shares database password with PostgreSQL, provides Gitea admin credentials
- Dependency: `postgres` must be installed in the same stack
- The database `gitea` is created automatically via the shared `create-postgres-database` template

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `gitea` | Container hostname |
| `volumes` | `data`, `config` | Git repositories and Gitea configuration |
| `volume_storage` | `local-zfs` | Proxmox storage for data volumes |

The container runs as UID 1000 (git user). Environment variables configure the PostgreSQL connection, admin user, and server settings.

### Admin User

The admin user is created via environment variable `GITEA_ADMIN_PASSWORD` from the `gitea` stack. The password is auto-generated when the stack is created.

## OIDC Authentication

Enable the `addon-oidc` addon to add Zitadel-based authentication. The addon:

1. Creates an OIDC client in Zitadel
2. Runs `gitea admin auth add-oauth` inside the container to register the OpenID Connect authentication source
3. Users can then log in via "Sign in with Zitadel" on the Gitea login page

The OIDC configuration runs as the `git` user (UID 1000) via `execute_on: { where: "lxc", uid: true, gid: true }`.

## SSL

Gitea uses `ssl_mode: native`. When SSL is enabled:

- `GITEA__server__PROTOCOL` is set to `https`
- Certificates are placed at `/etc/ssl/addon/`

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3000 | HTTP | Gitea web interface |
| 2222 | TCP | SSH for Git operations |

## Upgrade

Pulls new Gitea image. Git repositories and configuration in volumes are preserved. Gitea runs database migrations automatically on startup.

## Reconfigure

Allows enabling/disabling addons (SSL, OIDC). Volume mounts and environment variables can be changed.
