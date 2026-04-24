#!/bin/sh
# Trust local registry mirror in Docker.
# Tries to install the deployer CA so Docker can use TLS against the mirror;
# if the mirror is HTTP-only (e.g. the e2e/livetest pull-through caches
# bound to 10.0.0.1:80 and 10.0.0.2:80) the CA path is meaningless and we
# fall back to `insecure-registries` so the daemon is allowed to speak HTTP.
# Library: registry-mirror-common.sh (prepended automatically)

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"

[ "$DEPLOYER_URL" = "NOT_DEFINED" ] && DEPLOYER_URL=""
[ "$VE_CONTEXT" = "NOT_DEFINED" ] && VE_CONTEXT=""

mirror_detect || exit 0
mirror_setup_hosts

# Detect whether the mirror actually speaks HTTPS. A 200/4xx via TLS means CA
# trust is the right answer. Anything else (curl fails the TLS handshake or
# the mirror only listens on HTTP) means we go insecure.
if curl -sI -k --connect-timeout 3 "https://${MIRROR_IP}/v2/" 2>/dev/null | head -n 1 | grep -qE "^HTTP/[0-9.]+ [0-9]+"; then
  mirror_trust_ca "$DEPLOYER_URL" "$VE_CONTEXT"
else
  echo "Mirror at ${MIRROR_IP} is HTTP-only — using insecure-registries" >&2
  mirror_trust_insecure
fi
