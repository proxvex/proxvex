#!/bin/bash
# build-proxvex-oci-image.sh <instance>
#
# Build the proxvex OCI image from the current workspace and stage it into
# the nested VM's template cache so any application that pulls
# `ghcr.io/proxvex/proxvex:<tag>` via host-get-oci-image.py picks up the
# fresh local code instead of the upstream registry version.
#
# Pipeline:
#   1. pnpm run build         (backend + frontend)
#   2. npm pack               → docker/proxvex.tgz
#   3. docker build           → proxvex:local-${INSTANCE} (linux/amd64)
#   4. docker save | skopeo   → docker/proxvex-${INSTANCE}-local.oci.tar
#   5. scp to nested VM       → /tmp/proxvex-${INSTANCE}-redeploy.oci.tar
#   6. cache-alias on nested  → /var/lib/vz/template/cache/proxvex_latest.tar
#                            + /var/lib/vz/template/cache/proxvex_<version>.tar
#
# Output:
#   Prints the nested-VM-side path of the OCI tarball (`/tmp/...-redeploy.oci.tar`)
#   so callers can hand it to `install-proxvex.sh --tarball ...`.
#
# Exits non-zero if any step fails. The pre-test hook in scenario-executor
# treats a failure as fatal — running tests against a stale image would
# hide the very bug we're trying to surface.
#
# Idempotent by design: ALWAYS runs the full pipeline. No currency check —
# the caller decides when to invoke this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTANCE_ARG="${1:-}"
if [ -z "$INSTANCE_ARG" ]; then
  echo "Usage: $0 <instance>" >&2
  exit 2
fi

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"
load_config "$INSTANCE_ARG"

# nested_ssh / nested_scp_to come from lib/nested-ssh.sh.
# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[BUILD]${NC} $1" >&2; }
ok()   { echo -e "${GREEN}[BUILD]${NC} $1" >&2; }
err()  { echo -e "${RED}[BUILD]${NC} $1" >&2; exit 1; }

command -v docker >/dev/null || err "docker not found on local host"
command -v skopeo >/dev/null || err "skopeo not found on local host (brew/apt install skopeo)"
command -v pnpm   >/dev/null || err "pnpm not found on local host"

DOCKER_TAG="proxvex:local-${E2E_INSTANCE}"
OCI_TARBALL="$PROJECT_ROOT/docker/proxvex-${E2E_INSTANCE}-local.oci.tar"
DOCKER_SAVE_TARBALL="$PROJECT_ROOT/docker/proxvex-${E2E_INSTANCE}-docker.tar"
REMOTE_TARBALL="/tmp/proxvex-${E2E_INSTANCE}-redeploy.oci.tar"

info "Instance: ${E2E_INSTANCE}, target ${PVE_HOST}:${PORT_PVE_SSH}"

# 1. Build backend + frontend.
info "pnpm run build"
( cd "$PROJECT_ROOT" && pnpm run build >&2 ) || err "pnpm run build failed"

# 2. Pack the whole project as an npm tarball — picked up by Dockerfile.npm-pack.
info "npm pack → docker/proxvex.tgz"
rm -f "$PROJECT_ROOT/docker"/proxvex*.tgz
TARBALL_RAW=$(cd "$PROJECT_ROOT" && npm pack --pack-destination docker/ 2>&1 | grep -o 'proxvex-.*\.tgz' | tail -n1)
[ -n "$TARBALL_RAW" ] || err "npm pack did not produce a tarball"
mv "$PROJECT_ROOT/docker/$TARBALL_RAW" "$PROJECT_ROOT/docker/proxvex.tgz"

# 3. Build the Docker image. Force linux/amd64 — Apple-Silicon Macs would
# otherwise produce arm64 binaries that fail "Exec format error" on the PVE host.
info "docker build → ${DOCKER_TAG} (linux/amd64)"
( cd "$PROJECT_ROOT" && \
  docker build --platform linux/amd64 -t "$DOCKER_TAG" -f docker/Dockerfile.npm-pack . >&2 ) \
  || err "docker build failed"

# 4. docker save → skopeo copy. Two-stage avoids skopeo↔dockerd Engine-API
# version skew (Ubuntu 24.04's skopeo speaks 1.41, modern dockerd needs ≥1.44).
info "docker save → skopeo copy → ${OCI_TARBALL}"
rm -f "$OCI_TARBALL" "$DOCKER_SAVE_TARBALL"
docker save "$DOCKER_TAG" -o "$DOCKER_SAVE_TARBALL" \
  || err "docker save failed"
skopeo copy "docker-archive:${DOCKER_SAVE_TARBALL}" "oci-archive:${OCI_TARBALL}:latest" >&2 \
  || err "skopeo copy failed"
rm -f "$DOCKER_SAVE_TARBALL"

# 5. Upload to nested VM (port-forwarded SSH into the nested host).
info "scp → ${PVE_HOST}:${PORT_PVE_SSH}:${REMOTE_TARBALL}"
nested_scp_to "$OCI_TARBALL" "$REMOTE_TARBALL" \
  || err "scp of OCI tarball to nested VM failed"

# 6. Alias into the template cache so host-get-oci-image.py picks it up
# before falling back to ghcr.io.
# host-get-oci-image.py searches /var/lib/vz/template/cache/ for
# `proxvex_<safe_tag>*.tar`. Aliasing the freshly-built tarball as BOTH
# `proxvex_latest.tar` (covers ghcr.io/proxvex/proxvex:latest) and
# `proxvex_<version>.tar` (covers exact-version pulls) makes any test that
# deploys the proxvex application use this build, not the registry copy.
PROXVEX_VERSION="$(node -e "console.log(require('$PROJECT_ROOT/package.json').version)" 2>/dev/null || echo "")"
[ -n "$PROXVEX_VERSION" ] || err "could not read version from package.json"
info "alias cache: proxvex_latest.tar + proxvex_${PROXVEX_VERSION}.tar"
nested_ssh "
  set -e
  mkdir -p /var/lib/vz/template/cache
  cp '${REMOTE_TARBALL}' /var/lib/vz/template/cache/proxvex_latest.tar
  cp '${REMOTE_TARBALL}' /var/lib/vz/template/cache/proxvex_${PROXVEX_VERSION}.tar
  ls -la /var/lib/vz/template/cache/proxvex_*.tar | head -3 >&2
" >&2 || err "cache aliasing on nested VM failed"

ok "Built + staged. tarball=${REMOTE_TARBALL} version=${PROXVEX_VERSION}"

# Final stdout: the remote tarball path so callers can pipe it into
# install-proxvex.sh --tarball.
echo "$REMOTE_TARBALL"
