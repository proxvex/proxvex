#!/bin/sh
# Install the proxvex CA certificate into the container's system
# trust store. Needed e.g. for Gitea's `auth add-oauth` which validates the
# Zitadel OIDC discovery URL via the Go system cert pool.
#
# Library: pkg-common.sh (prepended automatically) — provides pkg_install,
# pkg_detect_os, pkg_wait_for_network.

set -eu

CA_DIR="/usr/local/share/ca-certificates"
CA_FILE="${CA_DIR}/proxvex-ca.crt"
# Renew if the existing cert expires in less than 30 days (2592000 s).
RENEW_SECONDS=2592000

# Skip if existing cert is still valid for the grace period.
if [ -s "$CA_FILE" ] && command -v openssl >/dev/null 2>&1 \
   && openssl x509 -in "$CA_FILE" -noout -checkend "$RENEW_SECONDS" >/dev/null 2>&1; then
  echo "Deployer CA already installed and valid (>30d) — skipping" >&2
  exit 0
fi

# Ensure prerequisites: openssl for expiry check, ca-certificates for
# update-ca-certificates. pkg_install is a no-op for already-installed
# packages on both apk and apt.
pkg_wait_for_network
pkg_install ca-certificates openssl

mkdir -p "$CA_DIR"

# Prefer the CA already on the certs volume (written by addon-ssl's
# 156-conf-generate-certificates with ssl.needs_ca_cert=true). Reading it
# locally avoids having to reach the deployer over HTTP from inside the LXC,
# which is brittle in test setups where the deployer hostname doesn't resolve
# in the nested-VM network. Apps that link addon-oidc to a TLS-protected
# zitadel always pair it with addon-ssl, so this path covers the real cases.
if [ -s "/etc/ssl/addon/chain.pem" ]; then
  cp "/etc/ssl/addon/chain.pem" "$CA_FILE"
else
  echo "Warning: /etc/ssl/addon/chain.pem not present — skipping CA trust install" >&2
  echo "         (does the app declare 'ssl.needs_ca_cert: true' alongside addon-ssl?)" >&2
  exit 0
fi

if [ ! -s "$CA_FILE" ]; then
  echo "Warning: downloaded CA file is empty — skipping trust update" >&2
  rm -f "$CA_FILE"
  exit 0
fi

if command -v update-ca-certificates >/dev/null 2>&1; then
  update-ca-certificates >&2 2>&1 || {
    echo "Warning: update-ca-certificates failed" >&2
    exit 0
  }
  echo "Installed deployer CA into system trust store ($CA_FILE)" >&2
else
  echo "Warning: update-ca-certificates not available — CA file saved but not activated" >&2
fi
