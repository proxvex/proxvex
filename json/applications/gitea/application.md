# Gitea

Self-hosted Git service with web UI, code review, team collaboration, package registry, and CI/CD.

## Prerequisites

- Dependency: `postgres` must be installed in the same stack
- The database `gitea` is created automatically via the shared `create-postgres-database` template

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `gitea` | Container hostname |
| `volumes` | `data` → `/data` | Single persistent volume holding repositories, DB sidecar files, **and** `app.ini` |
| `volume_storage` | `local-zfs` | Proxmox storage for data volumes |

The base `envs` ship generic defaults (`DOMAIN`/`ROOT_URL` = `localhost`).
For a public deployment behind a reverse proxy (where the public host differs
from the container hostname), override the relevant keys via **`extra_envs`**
rather than restating the whole `envs` block — see _Configuration_ below.

The container runs as UID 1000 (git user). Environment variables configure the PostgreSQL connection, admin user, and server settings.

> **Note:** The gitea image's `GITEA_CUSTOM` is `/data/gitea`, so all state —
> including `app.ini` — lives under `/data`. The single `data` volume must
> therefore be mounted at `/data` (not `/var/lib/gitea`); otherwise the
> container loses its config and repositories on recreation.

## Configuration (app.ini)

Gitea's effective config file is **`/data/gitea/conf/app.ini`** (on the
persistent `data` volume). proxvex does **not** write this file directly —
it sets container environment variables in the `envs` parameter using Gitea's
`GITEA__<section>__<KEY>` convention (double underscore separates section and
key). On **every** container start the image runs `environment-to-ini`
(`gitea config edit-ini`), which writes exactly those keys into `app.ini`.

Consequences:

- The image generates `app.ini` from its template **only if it does not yet
  exist**; it never overwrites an existing file. `environment-to-ini` then
  overlays the `GITEA__` env values on top — so a key driven by env
  **self-heals on each restart** (e.g. overriding `GITEA__server__ROOT_URL`
  updates `ROOT_URL` in `app.ini` at the next start).
- **To change a server setting:** add/override the `GITEA__section__KEY` in the
  `extra_envs` overlay (CLI/production) or edit the base `envs` (frontend),
  then **redeploy or reconfigure** so the new env reaches the container. The
  value lands in `app.ini` on the next container start. Example
  (`production/gitea.json`): `extra_envs` =
  `GITEA__server__ROOT_URL=https://git.ohnewarum.de/`.
- **Manual edits** to `/data/gitea/conf/app.ini` inside the container are
  possible, but any key that is **also** set via a `GITEA__` env var is
  **overwritten again** on the next start by `environment-to-ini`. To make a
  manual value stick, either remove the matching env line from `envs` or set
  the value via env instead.
- **No live reload:** server settings (`ROOT_URL`, `DOMAIN`, …) are read at
  startup. Applying a change requires a (graceful) restart of the gitea
  process — under the image's s6 supervision that effectively means restarting
  the container/service; `SIGHUP` graceful restart is unreliable here.

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
- Gitea answers on **443** (`local_https_port: 443`), so clone URLs and the
  OIDC redirect URI carry no port

Serving 443 needs one extra piece: Gitea runs as `uid 1000` **and** is the
container's PID 1, so it cannot bind a privileged port and there is no earlier
step inside the container that could allow it. The app therefore sets
`unprivileged_port_start: 443`, which installs the init wrapper
`/usr/local/sbin/proxvex-init` (template `109-host-install-init-wrapper`); the
wrapper lowers the port limit for the container's network namespace and then
execs Gitea. Set `local_https_port` back to `1443` (and drop
`unprivileged_port_start`) if you would rather keep the kernel default.

## mTLS

Enable the `addon-mtls` addon (alongside `addon-ssl`) for a **passwordless,
cert-only** PostgreSQL connection:

- `addon-mtls` issues a client certificate with `CN=gitea` into
  `/etc/ssl/addon/mtls/gitea/` (`cert.pem`, `privkey.pem`, `chain.pem`).
- `conf-enable-mtls-app.sh` appends, as LXC environment (overriding the
  password-mode defaults): `GITEA__database__SSL_MODE=verify-ca`,
  `GITEA__database__USER=gitea`, and `PGSSLCERT`/`PGSSLKEY`/`PGSSLROOTCERT`
  pointing at that folder.
- The dependency PostgreSQL must run with `addon-ssl` + `pg_client_cert=true`
  so its `pg_hba.conf` authenticates the connection by the client
  certificate's CN (`gitea`).
- Without `addon-mtls`, gitea connects in the default password mode
  (`GITEA__database__USER=postgres` + `GITEA__database__PASSWD`) — non-mTLS
  scenarios are unaffected.

## Database setup

proxvex does **not** create database roles or grants (neither password nor
mTLS deployments). For an mTLS / cert-only deployment, create the connection
role once against the database, as the `postgres` superuser, before deploying
gitea:

```sql
CREATE ROLE gitea LOGIN;             -- no password: cert-only (pg_hba `cert`)
ALTER DATABASE gitea OWNER TO gitea; -- gitea runs its DDL migrations
```

The `gitea` database itself is created automatically (shared
`create-postgres-database` template). The role name must equal the client
certificate CN (`gitea`). Livetest scenarios seed this automatically via the
`livetest-local` overlay (`188-conf-init-gitea-testdb`); production is the
operator's responsibility.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3000 | HTTP | Gitea web interface |
| 2222 | TCP | SSH for Git operations |

## Upgrade

Pulls new Gitea image. Git repositories and configuration in volumes are preserved. Gitea runs database migrations automatically on startup.

## Reconfigure

Allows enabling/disabling addons (SSL, OIDC). Volume mounts and environment variables can be changed.
