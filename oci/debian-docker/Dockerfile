# syntax=docker/dockerfile:1.7
# Pre-baked Debian + Docker base image for proxvex docker-compose apps.
#
# Replaces the runtime `apt-get install docker.io docker-compose` step
# (~80MB / many packages) that previously ran in every fresh LXC via the
# 307-post-install-docker-rootless template. On loaded nested-VMs that
# install routinely exceeds the 120s SSH script timeout and gets
# SIGKILL'd (exitCode 137), breaking docker-compose installs.
#
# Why Debian (not Alpine):
#   - Docker on Debian is the most-tested combination upstream
#   - GNU coreutils — no BusyBox `cp` quirks (we hit one in
#     post-trust-oci-ca-in-system.sh on Alpine LXC)
#   - glibc — fewer musl edge cases for long-running docker daemons
#
# proxvex pulls this image via host-get-oci-image.py, which converts
# the OCI rootfs into an LXC template tarball. The LXC inherits the
# image without an init system — debian:trixie-slim is too minimal for
# systemd and OCI-derived rootfs aren't designed to run init anyway —
# so dockerd is launched at first boot by post_start template
# 307-post-start-dockerd via nohup.

# Compose comes from the upstream release, not from Debian: trixie is
# frozen at 2.26.1, which is old enough to reject `up --wait` for
# services with `healthcheck: {disable: true}` and misses ~3 years of
# fixes. The release binary is pinned by version + sha256, so the only
# build-time trust addition is github.com (no docker.com apt repo, and
# the daemon stays on Debian's docker.io).
# Bumping: read the checksums from
#   https://github.com/docker/compose/releases/download/<version>/checksums.txt
ARG COMPOSE_VERSION=v5.1.4
ARG COMPOSE_SHA256_AMD64=33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4
ARG COMPOSE_SHA256_ARM64=d4fb48b72857810314d3ee77123c89954101844efa4788031221f4c370495946

FROM scratch AS compose-amd64
ARG COMPOSE_VERSION
ARG COMPOSE_SHA256_AMD64
ADD --checksum=sha256:${COMPOSE_SHA256_AMD64} \
    https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64 \
    /docker-compose

FROM scratch AS compose-arm64
ARG COMPOSE_VERSION
ARG COMPOSE_SHA256_ARM64
ADD --checksum=sha256:${COMPOSE_SHA256_ARM64} \
    https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64 \
    /docker-compose

# TARGETARCH is set by BuildKit (amd64 today, arm64 for a --platform build).
FROM compose-${TARGETARCH} AS compose

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

# docker.io + docker-cli are the Debian-packaged versions; that's enough
# for our compose-up / pull / down workflow and avoids pulling in
# docker.com's apt repo (one fewer trust dependency at build time).
# Debian's `docker-compose` package is deliberately NOT installed — it
# would also put a 2.26 standalone binary on PATH, which the
# post_start scripts prefer over `docker compose` (see
# post-start-docker-compose.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      docker-cli \
      docker.io \
      iptables \
 && rm -rf /var/lib/apt/lists/*

# Compose v5 as a CLI plugin: /usr/local/lib/docker/cli-plugins is the
# path the docker CLI searches before /usr/libexec (Debian's location),
# so `docker compose …` resolves here. No standalone `docker-compose`
# on PATH by design — the scripts fall back to `docker compose`.
COPY --from=compose /docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
RUN chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose \
 && docker compose version

# Configure dockerd: overlay2 is the standard storage driver for LXC
# rootfs, userland-proxy=false reduces overhead. Same settings the old
# 307-post-install-docker-rootless template wrote at runtime.
# 307-post-start-dockerd.sh re-creates this file if missing, so the
# bake here is a fast-path optimization, not a hard requirement.
RUN mkdir -p /etc/docker \
 && printf '%s\n' \
      '{' \
      '  "storage-driver": "overlay2",' \
      '  "userland-proxy": false' \
      '}' > /etc/docker/daemon.json

LABEL org.proxvex.framework=docker-compose
LABEL org.proxvex.purpose="LXC base for docker-compose apps — docker pre-installed"
LABEL org.opencontainers.image.source=https://github.com/proxvex/proxvex-yellow
LABEL org.opencontainers.image.description="Debian + Docker pre-baked for proxvex docker-compose framework"
LABEL org.opencontainers.image.licenses=MIT
