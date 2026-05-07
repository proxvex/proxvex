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
# proxvex pulls this image via host-get-oci-image.py, which converts the
# OCI rootfs into an LXC template tarball. The container's own
# svc-create-enable-service / svc-start-docker-compose templates handle
# the systemd service wiring at first start — `systemctl enable` at
# build time is unreliable inside an LXC, so we deliberately don't run
# it here.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

# docker.io + docker-compose are the Debian-packaged versions; that's
# enough for our compose-up / pull / down workflow and avoids pulling in
# docker.com's apt repo (one fewer trust dependency at build time).
# trixie is required because bookworm's `docker-compose` is the legacy
# v1 (Python) which lacks the `docker compose` (subcommand-with-space)
# CLI that the proxvex svc-templates use. trixie ships v2.26+ as a
# Docker CLI plugin under /usr/libexec/docker/cli-plugins/.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      docker.io \
      docker-compose \
      iptables \
 && rm -rf /var/lib/apt/lists/*

LABEL org.proxvex.framework=docker-compose
LABEL org.proxvex.purpose="LXC base for docker-compose apps — docker pre-installed"
LABEL org.opencontainers.image.source=https://github.com/proxvex/proxvex-yellow
LABEL org.opencontainers.image.description="Debian + Docker pre-baked for proxvex docker-compose framework"
LABEL org.opencontainers.image.licenses=MIT
