# Docker Registry Mirror

Pull-through cache for Docker Hub images.

## Why

Docker Hub enforces rate limits on image pulls: 100 pulls per 6 hours for anonymous users, 200 for authenticated. In environments with many containers pulling images (deployments, upgrades, CI), the limit is quickly exhausted. Errors look like `429 Too Many Requests`, `toomanyrequests: You have reached your pull rate limit`, or `{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}` (Docker Hub returns 401 once the anonymous limit is hit).

A registry mirror caches images locally after the first pull. Subsequent pulls are served from the cache without counting against the limit.

## Architecture

Extends `oci-image`: the `distribution/distribution` registry binary runs directly as the LXC container's PID 1. There is **no docker daemon and no compose stack** inside the container. Consequences:

- If the registry process exits, the LXC stops. `pct list` and the deployer UI show it as `stopped` immediately — no need to `docker logs` to find a crashed service.
- Registry stdout/stderr go straight to `/dev/console` and are visible in the existing LXC console log (`/var/log/lxc/<name>-<vmid>.log` and the deployer's `proxvex:log-url` endpoint).
- One process, one log, one status. No OpenRC noise.

## Authentication (recommended)

Configure a Docker Hub account so the mirror does authenticated pull-through (200 pulls / 6h instead of 100/6h):

- **`DOCKER_HUB_USERNAME`** (parameter, per app instance) — Docker Hub username.
- **`DOCKER_HUB_PASSWORD`** (stored in the `dockermr` stack as an external secret) — a Docker Hub Personal Access Token (PAT) for that account.

Multiple mirror instances can share the same `dockermr` stack value; the username is set per instance so test and production deployments can use different accounts. Leave both empty to run anonymously.

## Required addons

`addon-ssl` — the registry requires HTTPS. The SSL certificate includes additional SANs for `registry-1.docker.io` and `index.docker.io` via the `ssl_additional_san` property, so DNS-redirected clients can validate it.

## Storage

The default `volumes` parameter provisions a 10G LVM volume mounted at `/var/lib/registry` for the cache. Resize via the `volumes` parameter (`data=var/lib/registry,size=20G`) before deploy.

## Client Configuration

The cleanest pattern is a transparent rewrite via `/etc/hosts` so existing tooling needs no changes:

```
<mirror-ip> registry-1.docker.io index.docker.io
```

The mirror's TLS cert covers those names via SAN. Clients must trust the deployer CA (the `addon-ssl` provisioning template `005-host-trust-deployer-ca.json` does this on PVE hosts).

Alternatively, register as a registry-mirror in Docker:

```json
{ "registry-mirrors": ["https://docker-registry-mirror"] }
```

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 443  | HTTPS    | Registry API (v2) |

## Verification

`check-registry-mirror.json` runs from the PVE host: it patches `/etc/hosts`, then `skopeo inspect docker://registry-1.docker.io/library/alpine:latest` through the mirror. **Note:** once `alpine:latest` is cached the check stops touching Docker Hub upstream — it cannot detect a broken pull-through path on its own; rotate the test image or pull something uncached to validate auth end-to-end.

## Upgrade

Set `oci_image_tag` to a new version and re-deploy. The cache volume is preserved across redeploys.
