FROM ghcr.io/actions/actions-runner:latest

USER root

# System tools needed by e2e/step2b-install-deployer.sh when executed inside
# the runner: docker (docker build), skopeo (docker-daemon -> oci-archive),
# jq (token JSON parsing, PVE API responses), curl (PVE API + GitHub).
# gosu lets the entrypoint drop privileges from root to runner cleanly
# (Phase B of the runner-privilege rework). etherwake stays for WOL on pve1.
RUN apt-get update && apt-get install -y --no-install-recommends \
        etherwake \
        docker.io \
        skopeo \
        ca-certificates \
        gosu \
        jq \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -aG docker runner

COPY pvetest /usr/local/bin/pvetest
COPY entrypoint-root.sh /entrypoint-root.sh
COPY entrypoint-runner.sh /entrypoint-runner.sh
RUN chmod +x /usr/local/bin/pvetest /entrypoint-root.sh /entrypoint-runner.sh \
    && chown -R runner:runner /home/runner

# entrypoint-root.sh runs as root (PID 1 in the LXC), sets up DHCP, dockerd,
# and materialises secrets, then exec gosu's into runner for run.sh.
ENTRYPOINT ["/bin/bash", "/entrypoint-root.sh"]

LABEL \
    org.opencontainers.image.title="proxvex-github-runner" \
    org.opencontainers.image.description="GitHub Actions self-hosted runner for proxvex CI/CD with etherwake and pvetest" \
    org.opencontainers.image.vendor="proxvex" \
    org.opencontainers.image.authors="Volkmar Nissen <volkmar.nissen@gmail.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.source="https://github.com/proxvex/proxvex" \
    org.opencontainers.image.base.name="ghcr.io/actions/actions-runner:latest"
