#!/bin/sh
# Verify the Zot Registry Mirror is working as a pull-through proxy for ghcr.io.
#
# Runs on the PVE host (execute_on: ve) and:
# 1. Checks the mirror hostname resolves to a local address
# 2. Adds an /etc/hosts entry: ghcr.io -> <mirror-ip>
# 3. Verifies the deployer CA is in the host trust store (proxvex-ca.crt)
# 4. Tests `skopeo inspect docker://ghcr.io/...` through the mirror
#
# When Phase B adds Docker Hub as a second upstream, extend the /etc/hosts
# line to include `registry-1.docker.io index.docker.io` and add a second
# skopeo probe — the cert SAN already covers both.

MIRROR_HOST="{{ hostname }}"
[ "$MIRROR_HOST" = "NOT_DEFINED" ] || [ -z "$MIRROR_HOST" ] && MIRROR_HOST="${1:-zot-mirror}"

ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+\n}$1"; }

# 1. DNS check: zot-mirror must resolve to a local address
echo "Checking DNS for ${MIRROR_HOST}..." >&2
MIRROR_IP=$(nslookup "$MIRROR_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$MIRROR_IP" ]; then
  add_error "DNS: Cannot resolve ${MIRROR_HOST}"
else
  case "$MIRROR_IP" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*)
      echo "DNS: ${MIRROR_HOST} -> ${MIRROR_IP} (local)" >&2
      ;;
    *)
      add_error "DNS: ${MIRROR_HOST} resolves to ${MIRROR_IP} (expected local address)"
      ;;
  esac
fi

# 2. /etc/hosts redirect for ghcr.io. zot's TLS cert has DNS:ghcr.io in SAN
# (set via ssl_additional_san in application.json), so skopeo will validate
# the connection to ghcr.io against the mirror's cert.
MARKER="# proxvex: zot mirror"
if [ -n "$MIRROR_IP" ] && ! grep -q "$MARKER" /etc/hosts 2>/dev/null; then
  echo "${MIRROR_IP} ghcr.io  ${MARKER}" >> /etc/hosts
  echo "Added /etc/hosts: ${MIRROR_IP} -> ghcr.io" >&2
fi

# 3. CA in trust store
CA_CERT="/usr/local/share/ca-certificates/proxvex-ca.crt"
if [ ! -f "$CA_CERT" ]; then
  add_error "CA: Deployer CA certificate not installed at ${CA_CERT}"
fi

# 4. skopeo inspect via mirror. ghcr.io/project-zot/zot is a small public image
# that's almost certainly NOT in any pre-warmed cache, so a successful inspect
# proves the on-demand sync path actually fetches from upstream and serves it.
echo "Testing skopeo inspect through mirror..." >&2
if command -v skopeo >/dev/null 2>&1; then
  INSPECT_RESULT=$(skopeo inspect "docker://ghcr.io/project-zot/zot:latest" 2>&1)
  if echo "$INSPECT_RESULT" | grep -q '"Digest"'; then
    DIGEST=$(echo "$INSPECT_RESULT" | grep '"Digest"' | head -1 | sed 's/.*"Digest": *"//' | sed 's/".*//')
    echo "Skopeo: ghcr.io/project-zot/zot:latest inspected through mirror (${DIGEST})" >&2
  else
    add_error "Skopeo: Failed to inspect ghcr.io/project-zot/zot:latest: $(echo "$INSPECT_RESULT" | head -3)"
  fi
else
  echo "Skopeo not available, skipping inspect test" >&2
fi

if [ -n "$ERRORS" ]; then
  printf "Zot mirror check FAILED:\n%b\n" "$ERRORS" >&2
  exit 1
fi

echo "Zot mirror check PASSED" >&2
