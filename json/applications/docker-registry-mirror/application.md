# Docker Registry Mirror

Pull-through cache for Docker Hub images.

## Why

Docker Hub enforces rate limits on image pulls: 100 pulls per 6 hours for anonymous users, 200 for authenticated users. In environments with multiple containers pulling images (e.g. during deployment, upgrades, or CI), these limits are quickly exhausted. The error manifests as `429 Too Many Requests` or `toomanyrequests: You have reached your pull rate limit`.

A registry mirror caches images locally after the first pull. Subsequent pulls are served from the cache without counting against the Docker Hub rate limit. This is especially useful for:

- Proxmox hosts deploying many containers
- Repeated test/CI runs that pull the same images
- Air-gapped or bandwidth-constrained environments

## Prerequisites

- Extends: `docker-compose`
- Required addon: `addon-ssl` — the registry requires HTTPS

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `docker-registry-mirror` | Container hostname |

The registry runs as a Docker Compose service with native TLS using certificates from the SSL addon.

### How It Works

The registry operates as a pull-through cache for `registry-1.docker.io`. When a Docker client pulls an image through the mirror:

1. First pull: fetched from Docker Hub, cached locally
2. Subsequent pulls: served from cache

### Client Configuration

Docker clients must be configured to use the mirror. Add to `/etc/docker/daemon.json`:

```json
{
  "registry-mirrors": ["https://docker-registry-mirror:443"]
}
```

Since the mirror uses a self-signed CA certificate, clients must either:
- Trust the CA certificate (recommended)
- Configure insecure registry access

### SAN Configuration

The SSL certificate includes additional Subject Alternative Names for Docker Hub domains (`registry-1.docker.io`, `index.docker.io`) via the `ssl_additional_san` property.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 443 | HTTPS | Registry API (v2) |

## Verification

The check template `host-check-registry-mirror` verifies the registry is operational by querying the v2 catalog endpoint.

## Upgrade

Pulls new registry image. Cached layers are preserved in volumes.
