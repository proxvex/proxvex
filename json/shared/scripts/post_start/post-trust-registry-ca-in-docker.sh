#!/bin/sh
# Trust local registry mirror in Docker (production mode).
# Uses CA certificate from deployer for TLS trust.
# Library: registry-mirror-common.sh (prepended automatically)

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"

[ "$DEPLOYER_URL" = "NOT_DEFINED" ] && DEPLOYER_URL=""
[ "$VE_CONTEXT" = "NOT_DEFINED" ] && VE_CONTEXT=""

mirror_detect || exit 0
mirror_setup_hosts
mirror_trust_ca "$DEPLOYER_URL" "$VE_CONTEXT"
