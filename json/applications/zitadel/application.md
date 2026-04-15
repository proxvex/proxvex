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

## Email notifications (SMTP)

Zitadel sends email for password reset, user invitation, email verification, and
MFA notifications. Out of the box no SMTP is configured — these flows fail
silently with `could not create email channel — Errors.SMTPConfig.NotFound` in
the `zitadel-api` log.

SMTP is configured at **FirstInstance init** via Zitadel's native environment
variables `ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_*`. The compose template
reads those values from the **`oidc` stack** — fill in the optional SMTP
entries once and every new Zitadel deploy on that stack gets them for free.

> **Important warning:** Zitadel's UI may report "successfully sent" when the
> SMTP handshake succeeded, even if the recipient never receives the mail
> (e.g. the provider silently dropped it because the sender address isn't
> authorized). **Always test with a real external recipient** after setup,
> don't trust the UI-level success message.

### Example 1 — No email (default)

Leave the SMTP fields in the `oidc` stack empty:

| `oidc` stack entry | Value |
|---|---|
| `SMTP_HOST` | *(empty)* |

Zitadel deploys without SMTP. Email flows are disabled; an admin can still
configure SMTP later via the Zitadel web UI if needed.

### Example 2 — Existing hosted mailbox (no DNS change)

You already own a mailbox like `admin@example.com` at a hosted provider
(mailbox.org, Fastmail, Google Workspace, …) and the MX/SPF DNS records for
`example.com` are **already** pointing at that provider. You only want Zitadel
to send mail through it.

Fill the `oidc` stack:

| Entry | Example |
|---|---|
| `SMTP_HOST` | `smtp.mailbox.org` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `admin@example.com` |
| `SMTP_SENDER` | `admin@example.com` |
| `SMTP_PASSWORD` | *(your provider password or app-specific token)* |

In the Zitadel app parameters:

| Parameter | Value |
|---|---|
| `smtp_own_domain` | `false` |

Deploy. Zitadel reads the env vars at init, stores them in its DB, and starts
sending email through the hosted provider. Nothing touches DNS.

> Many providers require a **provider-specific setup step** first:
> mailbox.org wants the sender added as an "alternate sender" and verified by
> email; Gmail wants an app-specific password; Google Workspace wants the
> sender added as a verified user. Consult your provider's documentation
> before filling `SMTP_HOST`.

### Example 3 — Own mail domain with Cloudflare DNS automation

You own a domain like `example.com` hosted in Cloudflare and you want this
deploy to **automatically create the MX and SPF DNS records** pointing at your
mail provider, so email from `admin@example.com` is deliverable.

Prerequisites:

- A Cloudflare stack with `CF_TOKEN` (same token you use for ACME DNS-01)
- The mail provider is already set up to accept mail for your sender address
  (the alternate-sender / verified-user step above)

Fill the `oidc` stack exactly as in Example 2, **plus** select the cloudflare
stack in the app. Then set the Zitadel app parameters:

| Parameter | Value |
|---|---|
| `smtp_own_domain` | `true` |
| `smtp_mail_domain` | `example.com` |
| `smtp_mx_target` | `mxext1.mailbox.org` *(provider-specific)* |
| `smtp_spf_value` | `v=spf1 include:mailbox.org ~all` *(provider-specific)* |

Deploy. The `385-post-configure-mail-dns` template reads `CF_TOKEN` from the
cloudflare stack and calls the Cloudflare API to upsert:

- **MX** record: `example.com` → `mxext1.mailbox.org` (priority 10)
- **TXT** record: `example.com` → `v=spf1 include:mailbox.org ~all`

The script is **idempotent** — if the records already exist with the same
values, it updates them instead of creating duplicates. You can re-run the
deploy safely.

### Example 4 — Mailbox.org specifics

Concrete values for a mailbox.org account, for reference:

| Entry | Value |
|---|---|
| `SMTP_HOST` | `smtp.mailbox.org` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | *(your mailbox.org login, e.g. `yourname@mailbox.org`)* |
| `SMTP_SENDER` | *(the alternate sender, e.g. `admin@example.com`)* |
| `SMTP_PASSWORD` | *(your mailbox.org password)* |
| `smtp_mx_target` | `mxext1.mailbox.org` |
| `smtp_spf_value` | `v=spf1 include:mailbox.org ~all` |

Mailbox.org requires two one-time **manual** steps before the deploy:

1. In the mailbox.org web UI, add `admin@example.com` as an **alternate sender**.
2. Click the **verification link** mailbox.org sends to that address. Until
   that's done, mailbox.org rejects all outgoing mail from the alternate
   sender, even if Zitadel's SMTP handshake succeeds.

Only after those two steps does the deploy's automated DNS + SMTP setup
actually deliver mail.

## Troubleshooting email

**`could not create email channel`** in `zitadel-api` log — no SMTP configured
in the DB. Either `SMTP_HOST` is empty in the `oidc` stack, or the compose
env var substitution failed. Verify with:

```sh
pct exec <VMID> -- docker inspect zitadel-zitadel-api-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SMTP
```

**"Successfully sent" but no mail arrives** — provider rejected the mail
silently. Check:

- Sender address is verified at the provider (alternate sender, app password)
- SPF record is present and includes the provider (`dig TXT example.com`)
- MX record is present (`dig MX example.com`)
- Mail isn't in the recipient's spam folder

**Cloudflare DNS script fails with "No zone found"** — the `smtp_mail_domain`
must match a zone in the Cloudflare account tied to `CF_TOKEN`. If you use a
subdomain, use the apex in `smtp_mail_domain`.

## Upgrade

Pulls new Zitadel and zitadel-login images. Database migrations run automatically on startup. Bootstrap data in `/bootstrap/` volume is preserved.

## Reconfigure

Allows enabling/disabling SSL. OIDC configuration is managed through the `addon-oidc` addon on dependent applications, not on Zitadel itself.
