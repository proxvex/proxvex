#!/bin/sh
# Trust local registry mirrors in Docker (livetest mode).
# Mirrors run on nested VM: Docker Hub on 10.0.0.1:443, ghcr.io on 10.0.0.2:443.
# Uses insecure-registries (no TLS certificates needed).

DOCKERHUB_MARKER="# oci-lxc-deployer: registry mirror"
GHCR_MARKER="# oci-lxc-deployer: ghcr mirror"

# /etc/hosts entries
grep -q "$DOCKERHUB_MARKER" /etc/hosts 2>/dev/null || {
  echo "10.0.0.1 registry-1.docker.io index.docker.io  ${DOCKERHUB_MARKER}" >> /etc/hosts
  echo "Added /etc/hosts: 10.0.0.1 -> registry-1.docker.io, index.docker.io" >&2
}
grep -q "$GHCR_MARKER" /etc/hosts 2>/dev/null || {
  echo "10.0.0.2 ghcr.io  ${GHCR_MARKER}" >> /etc/hosts
  echo "Added /etc/hosts: 10.0.0.2 -> ghcr.io" >&2
}

# Docker insecure-registries
if ! grep -q "ghcr.io" /etc/docker/daemon.json 2>/dev/null; then
  printf '{\n  "insecure-registries": ["registry-1.docker.io", "index.docker.io", "ghcr.io"]\n}\n' > /etc/docker/daemon.json
  if command -v rc-service > /dev/null 2>&1; then
    rc-service docker restart >&2 2>&1 || true
  elif command -v systemctl > /dev/null 2>&1; then
    systemctl restart docker >&2 2>&1 || true
  fi
  echo "Set insecure-registries for local mirrors" >&2
fi
