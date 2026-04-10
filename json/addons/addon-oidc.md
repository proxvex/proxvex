# OIDC Authentication Addon

Enable OpenID Connect authentication for application containers via Zitadel.

## What Gets Configured Automatically

The addon performs these steps during installation/reconfigure:

1. **Zitadel Project** — Creates a project (named after `oidc_project_name` or hostname) with `projectRoleAssertion: true` so roles appear in OIDC tokens
2. **Roles** — Creates roles defined in the application's `oidc_roles` (e.g. `admin`)
3. **OIDC Application** — Registers an OIDC client with authorization code flow, callback URLs, and logout URLs
4. **Credentials** — Extracts `client_id` and `client_secret` and provides them as template variables
5. **App Configuration** — Injects OIDC environment variables into the container's LXC config or runs app-specific configuration scripts

## What You Must Do Manually

- **Deploy Zitadel** before enabling this addon (it is a dependency)
- **Create users** in Zitadel and assign them the appropriate project roles
- The addon creates the project, roles, and OIDC application — but not the users

## Parameters

### `oidc_app_name`

Display name for the OIDC application in Zitadel. Defaults to the container hostname.

### `oidc_project_name`

Name of the Zitadel project to create or use. Defaults to the container hostname.

### `oidc_callback_path` (advanced)

The callback endpoint path for the OIDC authorization code flow. Default: `/auth/strategy/callback`.

Each application defines its own default callback path:

| Application | Callback Path |
|-------------|---------------|
| oci-lxc-deployer | `/api/auth/callback` |
| nginx | `/oauth2/callback` |
| gptwol | `/oidc/callback` |
| gitea | (configured via CLI, not callback-based) |
| node-red | `/auth/strategy/callback` |

## Environment Variables Injected

The addon writes these variables into the container's LXC configuration:

| Variable | Description |
|----------|-------------|
| `OIDC_ENABLED` | `true` |
| `OIDC_ISSUER_URL` | Zitadel issuer URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `OIDC_CALLBACK_URL` | Full callback URL |
| `OIDC_SESSION_SECRET` | Random session secret |
| `OIDC_REQUIRED_ROLE` | Required role for access (from `oidc_roles`) |

## Application-Specific Behavior

### Gitea

Instead of environment variables, Gitea uses its built-in CLI to register an OIDC authentication source. The addon runs `gitea admin auth add-oauth` inside the container after startup with the OpenID Connect discovery URL and credentials.

### Other Apps (nginx, gptwol, node-red, oci-lxc-deployer)

OIDC configuration is injected as environment variables into the LXC config. The application reads these variables at startup.

## Stacktype

This addon uses the `oidc` stacktype. OIDC credentials (client secret) are stored in the stack and shared across reconfigures.
