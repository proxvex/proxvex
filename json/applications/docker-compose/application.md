# Docker Compose Framework

Base framework for deploying Docker Compose applications in LXC containers on Proxmox VE.

This is not an application itself — other applications extend this framework via `"extends": "docker-compose"` in their `application.json`. See `docker-compose.md` in this directory for the full framework documentation including UID/GID handling for volumes.

## How It Works

1. **Image** — Downloads an Alpine/Debian/Ubuntu OS template and checks kernel module requirements
2. **Create** — Creates an LXC container with Docker-capable configuration (nesting, keyctl, fuse)
3. **Configure** — Installs Docker rootless, uploads the compose file, creates volumes
4. **Start** — Starts Docker Compose services inside the container

## Key Parameters

| Parameter | Description |
|-----------|-------------|
| `hostname` | Container hostname |
| `compose_file` | Docker Compose YAML file (upload) |
| `env_file` | Optional `.env` file for compose variable substitution (upload) |
| `ostype` | Base OS: `alpine`, `debian`, or `ubuntu` |

## Upgrade

Upgrade pulls new images for all compose services, creates a fresh container, and rebinds volumes. Compose file and data volumes are preserved.

## Reconfigure

Reconfigure clones the container, applies changes (addons, compose file, environment), and replaces the old container.

## Available Addons

| Addon | Description |
|-------|-------------|
| `addon-ssl` | HTTPS via reverse proxy, native TLS, or certificate provisioning |
| `samba-shares` | SMB/CIFS file sharing |
