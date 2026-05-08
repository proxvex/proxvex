# Zot Registry Mirror

Pull-through OCI registry cache built on [project-zot/zot](https://github.com/project-zot/zot).

## Why zot

`distribution/distribution` (the older `docker-registry-mirror` app) is single-upstream per instance — one container, one upstream registry. zot supports **multiple upstreams in one config** (`extensions.sync.registries` array), so a single `zot-mirror` LXC can serve as a pull-through cache for `ghcr.io` AND `registry-1.docker.io` simultaneously, with one TLS cert and one volume.

This app starts as a ghcr.io-only mirror; the cert SAN is already provisioned for both Docker Hub and ghcr.io upstreams (Phase B = edit `zot_config` to add a second `registries:` entry — no cert reissue, no second LXC).

## Architecture

Extends `oci-image`. The zot binary runs as the LXC's PID 1; no docker daemon, no compose stack. The config lives in a tiny dedicated `config=/etc/zot,size=4M` volume — written by the `100-conf-write-zot-config.json` pre_start template before zot starts.

| Volume | Mount | Purpose |
|--------|-------|---------|
| `data` | `/var/lib/registry` | Image cache (~10G default) |
| `config` | `/etc/zot` | `config.json` (set by pre_start) |
| `certs` | `/etc/ssl/addon` | TLS server cert + key (provisioned by addon-ssl) |
| `proxvex` | `/etc/proxvex` | Managed marker, log endpoint |

## Required addons

`addon-ssl` — zot's `http.tls.cert/key` references `/etc/ssl/addon/fullchain.pem` and `/etc/ssl/addon/privkey.pem`. The SAN includes `DNS:ghcr.io,DNS:registry-1.docker.io,DNS:index.docker.io` so clients can address the mirror by the original-registry hostnames via `/etc/hosts` redirect (or, for Docker Hub specifically, via `registry-mirrors` in `/etc/docker/daemon.json`).

## Project-level integration

Two project parameters drive automatic client config in every docker-compose-based application:

- `docker_registry_mirror = https://docker-registry-mirror` (or wherever the Docker-Hub mirror lives)
- `ghcr_registry_mirror = https://zot-mirror` (or wherever zot-mirror lives)

`json/shared/scripts/post_start/post-start-dockerd.sh` writes `/etc/docker/daemon.json` `registry-mirrors` for Docker Hub and a `/etc/hosts` redirect for ghcr.io accordingly. End-users only need to install the mirror app(s) and set the URLs in project settings — no per-app config.

## Editing the config

`zot_config` in the deploy form (Advanced) is the full `config.json` — multi-line string, written verbatim to `/etc/zot/config.json`. Default mirrors only `ghcr.io`. To add Docker Hub as second upstream:

```json
"registries": [
  { "urls": ["https://ghcr.io"],                "onDemand": true, ... },
  { "urls": ["https://registry-1.docker.io"],   "onDemand": true, ... }
]
```

then re-deploy. The cache volume survives the redeploy.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 443  | HTTPS    | Registry API (v2) + sync |

## Verification

`check-zot-mirror.json` runs from the PVE host: it patches `/etc/hosts` for `ghcr.io`, then `skopeo inspect docker://ghcr.io/project-zot/zot:latest` through the mirror.

## Upgrade

Set `oci_image_tag` to a new zot release and redeploy. Cache volume is preserved.
