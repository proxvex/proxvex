# OCI Image Framework

Base framework for deploying OCI container images (Docker Hub, GHCR, etc.) as LXC containers on Proxmox VE.

This is not an application itself — other applications extend this framework via `"extends": "oci-image"` in their `application.json`.

## How It Works

1. **Image** — Pulls the OCI image from a registry using skopeo
2. **Create** — Creates an LXC container with the image as rootfs
3. **Configure** — Sets environment variables, volumes, network, and UID/GID mapping
4. **Start** — Starts the container and waits for readiness

## Key Parameters

| Parameter | Description |
|-----------|-------------|
| `hostname` | Container hostname (also used as Proxmox VM name) |
| `oci_image` | Full image reference (e.g. `nginx:alpine`) |
| `volumes` | Volume mounts, one per line: `key=/container/path` |
| `envs` | Environment variables, one per line: `KEY=value` |
| `uid` / `gid` | User/group ID the application runs as inside the container |

## Upgrade

Upgrade pulls a new version of the OCI image, creates a fresh container, and rebinds the existing volumes. Data in volumes is preserved.

## Reconfigure

Reconfigure clones the existing container, applies parameter changes (addons, environment variables, volumes), and replaces the old container. Volumes are preserved.

## Available Addons

| Addon | Description |
|-------|-------------|
| `addon-ssl` | HTTPS via reverse proxy, native TLS, or certificate provisioning |
| `addon-acme` | Let's Encrypt certificates via Cloudflare DNS challenge |
| `samba-shares` | SMB/CIFS file sharing |
