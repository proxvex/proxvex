#!/bin/sh
# Trust local registry mirror in Docker (dev/test mode).
# Uses insecure-registries instead of CA certificate.
# Library: registry-mirror-common.sh (prepended automatically)

mirror_detect || exit 0
mirror_setup_hosts
mirror_trust_insecure
