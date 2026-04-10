# Proxmox VE

Proxmox VE host management. This is a hidden application used for reconfiguring the Proxmox host itself (e.g. enabling OIDC authentication for the Proxmox web interface).

## Reconfigure

Supports enabling/disabling addons on the Proxmox host:

| Addon | Description |
|-------|-------------|
| `addon-ssl` | HTTPS certificates for Proxmox web interface |
| `addon-oidc` | OpenID Connect authentication for Proxmox web UI |
