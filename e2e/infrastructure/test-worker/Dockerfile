FROM node:24-bookworm-slim

# Install test dependencies and SSH server
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      jq \
      git \
      openssh-server \
      openssl \
      ca-certificates \
      netcat-openbsd \
      python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@latest --activate

# Install Playwright system dependencies (as root, before switching to node)
RUN npx playwright install-deps chromium

# SSH config: disable root login, allow pubkey auth
RUN mkdir -p /run/sshd \
    && sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

# Set up unprivileged test user (node user already exists in base image)
RUN mkdir -p /home/node/.ssh /home/node/workspace \
    && chmod 700 /home/node/.ssh \
    && chown -R node:node /home/node/.ssh /home/node/workspace \
    # Ensure node account is not locked (sshd rejects locked accounts)
    && passwd -d node

EXPOSE 22

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

LABEL \
    org.opencontainers.image.title="proxvex-ci-test-worker" \
    org.opencontainers.image.description="CI test worker with pnpm and SSH for proxvex E2E tests" \
    org.opencontainers.image.vendor="proxvex" \
    org.opencontainers.image.authors="Volkmar Nissen <volkmar.nissen@gmail.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.source="https://github.com/proxvex/proxvex" \
    org.opencontainers.image.base.name="node:24-bookworm-slim"
