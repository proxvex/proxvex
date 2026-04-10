# GPTWoL

Web-based Wake-on-LAN management tool for remotely powering on machines.

## Prerequisites

- Stacktype: `oidc` (only when OIDC addon is enabled)

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `gptwol` | Container hostname |
| `volumes` | `db`, `cron` | Database and scheduled tasks |

## OIDC Authentication

Enable the `addon-oidc` addon to protect GPTWoL with Zitadel authentication. The callback path is `/oidc/callback`.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 5000 | HTTP | GPTWoL web interface |

## Addons

| Addon | Description |
|-------|-------------|
| `addon-oidc` | OpenID Connect authentication via Zitadel |

## Upgrade

Pulls new GPTWoL image. Database and cron volumes are preserved.
