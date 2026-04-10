# OCI LXC Deployer

Web UI and API for deploying and managing OCI containers on Proxmox VE. This application deploys the deployer itself as a managed container.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `http_port` | `3080` | HTTP port for the web interface |
| `https_port` | `3443` | HTTPS port (when SSL enabled) |
| `oci_image_tag` | `latest` | Image tag, allows pinning to specific versions |

The container runs as UID 1001.

### Volumes

| Volume | Mount | Description |
|--------|-------|-------------|
| `config` | `/config` | Application configuration (JSON path, local overrides) |
| `secure` | `/secure` | Sensitive data (secrets, context), permissions 0700 |

The `secure` volume is backed up automatically (`volume_backup: true`).

## OIDC Authentication

Enable the `addon-oidc` addon to protect the deployer API and web UI with Zitadel authentication.

- Callback path: `/api/auth/callback`
- Required role: `admin` (users must have this role in the Zitadel project)
- The check template `check-oidc-endpoint` verifies that OIDC is working after reconfigure

### Bootstrap Flow

1. **Install PostgreSQL** — Database for Zitadel
2. **Install Zitadel** — Creates the OIDC identity provider. During first start, Zitadel creates an admin user (`admin`) with an auto-generated password stored in the `oidc` stack
3. **Reconfigure deployer with addon-oidc** — The addon registers an OIDC client in Zitadel and injects credentials into the deployer container
4. **Log in** — Open the deployer web UI, click "Sign in with Zitadel", and log in with the Zitadel admin user

### Zitadel Admin Password

The Zitadel admin password is auto-generated and stored as `ZITADEL_ADMIN_PASSWORD` in the `oidc` stack. To retrieve it:

1. Open the deployer web UI
2. Go to **Stacks** and select the `oidc` stack
3. The `ZITADEL_ADMIN_PASSWORD` value is shown in the stack entries

The actual Zitadel login password is `ZITADEL_ADMIN_PASSWORD` + `!Aa1` (suffix added by Zitadel's password policy).

### Creating Additional Users

After the first login as admin:

1. Open the Zitadel web interface (at the Zitadel hostname)
2. Create new users under **Users**
3. Assign the `admin` role in the deployer project under **Projects > oci-lxc-deployer > Authorizations**

### Environment Variables

When OIDC is enabled, the deployer reads these environment variables at startup:

- `OIDC_ISSUER_URL` — Zitadel instance URL
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` — Credentials from the OIDC addon
- `OIDC_CALLBACK_URL` — Full callback URL
- `OIDC_REQUIRED_ROLE` — Role required for API access

## SSL

Uses `ssl_mode: native` — the deployer handles TLS directly using certificates from the addon at `/etc/ssl/addon/`.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 3080 | HTTP | Web interface and API |
| 3443 | HTTPS | Web interface and API (when SSL enabled) |

## Addons

| Addon | Description |
|-------|-------------|
| `addon-ssl` | HTTPS with self-signed CA certificates |
| `addon-oidc` | OpenID Connect authentication via Zitadel |

## Upgrade

Pulls new deployer image. Configuration and secrets in volumes are preserved. Use `oci_image_tag` to pin a specific version instead of `latest`.

## Reconfigure

Common reconfigure scenarios:

- **Enable OIDC** — Adds Zitadel authentication (requires Zitadel to be deployed)
- **Enable SSL** — Adds HTTPS support
- **Change ports** — Modify HTTP/HTTPS ports
