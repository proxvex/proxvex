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
# OCI rootfs into an LXC template tarball. systemd in the LXC reads the
# enable-symlinks below and auto-starts dockerd + containerd at first
# boot — equivalent to `systemctl enable` but without needing systemd
# running at build time (which is unreliable inside an LXC build).
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
      docker-cli \
      docker.io \
      docker-compose \
      iptables \
 && rm -rf /var/lib/apt/lists/*

# Configure dockerd: overlay2 is the standard storage driver for LXC
# rootfs, userland-proxy=false reduces overhead. Same settings the old
# 307-post-install-docker-rootless template wrote at runtime.
RUN mkdir -p /etc/docker \
 && printf '%s\n' \
      '{' \
      '  "storage-driver": "overlay2",' \
      '  "userland-proxy": false' \
      '}' > /etc/docker/daemon.json

# Pre-enable docker + containerd so systemd starts them at first boot.
# Equivalent to `systemctl enable docker containerd` but works without a
# running systemd. The previous template ran systemctl at first start;
# baking the symlinks here keeps post_start free of service-management.
RUN mkdir -p /etc/systemd/system/multi-user.target.wants \
              /etc/systemd/system/sockets.target.wants \
 && ln -sf /lib/systemd/system/docker.service \
      /etc/systemd/system/multi-user.target.wants/docker.service \
 && ln -sf /lib/systemd/system/containerd.service \
      /etc/systemd/system/multi-user.target.wants/containerd.service \
 && ln -sf /lib/systemd/system/docker.socket \
      /etc/systemd/system/sockets.target.wants/docker.socket

LABEL org.proxvex.framework=docker-compose
LABEL org.proxvex.purpose="LXC base for docker-compose apps — docker pre-installed"
LABEL org.opencontainers.image.source=https://github.com/proxvex/proxvex-yellow
LABEL org.opencontainers.image.description="Debian + Docker pre-baked for proxvex docker-compose framework"
LABEL org.opencontainers.image.licenses=MIT
