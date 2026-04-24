FROM ghcr.io/actions/actions-runner:latest

# Tools needed by e2e/step2b-install-deployer.sh when executed inside the
# runner: docker (docker build), skopeo (docker-daemon -> oci-archive),
# pnpm (backend build). Plus etherwake for WOL (existing use).
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
        etherwake \
        docker.io \
        skopeo \
        ca-certificates \
    && sudo rm -rf /var/lib/apt/lists/* \
    && sudo corepack enable \
    && sudo corepack prepare pnpm@latest --activate

COPY pvetest /usr/local/bin/pvetest
RUN sudo chmod +x /usr/local/bin/pvetest

COPY entrypoint.sh /entrypoint.sh
RUN sudo chmod +x /entrypoint.sh

USER root
RUN chown -R runner:runner /home/runner
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]

LABEL \
    org.opencontainers.image.title="proxvex-github-runner" \
    org.opencontainers.image.description="GitHub Actions self-hosted runner for proxvex CI/CD with etherwake and pvetest" \
    org.opencontainers.image.vendor="proxvex" \
    org.opencontainers.image.authors="Volkmar Nissen <volkmar.nissen@gmail.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.source="https://github.com/proxvex/proxvex" \
    org.opencontainers.image.base.name="ghcr.io/actions/actions-runner:latest"
