#!/bin/sh
# Install the oci-lxc-deployer CA certificate into the container's system
# trust store. Needed e.g. for Gitea's `auth add-oauth` which validates the
# Zitadel OIDC discovery URL via the Go system cert pool.
#
# Library: pkg-common.sh (prepended automatically) — provides pkg_install,
# pkg_detect_os, pkg_wait_for_network.

set -eu

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"

[ "$DEPLOYER_URL" = "NOT_DEFINED" ] && DEPLOYER_URL=""
[ "$VE_CONTEXT" = "NOT_DEFINED" ] && VE_CONTEXT=""

if [ -z "$DEPLOYER_URL" ] || [ -z "$VE_CONTEXT" ]; then
  echo "Warning: deployer_base_url or ve_context_key missing — skipping CA install" >&2
  exit 0
fi

CA_DIR="/usr/local/share/ca-certificates"
CA_FILE="${CA_DIR}/oci-lxc-deployer-ca.crt"
# Renew if the existing cert expires in less than 30 days (2592000 s).
RENEW_SECONDS=2592000

# Skip if existing cert is still valid for the grace period.
if [ -s "$CA_FILE" ] && command -v openssl >/dev/null 2>&1 \
   && openssl x509 -in "$CA_FILE" -noout -checkend "$RENEW_SECONDS" >/dev/null 2>&1; then
  echo "Deployer CA already installed and valid (>30d) — skipping download" >&2
  exit 0
fi

# Ensure prerequisites: curl for download, openssl for expiry check,
# ca-certificates for update-ca-certificates. pkg_install is a no-op for
# already-installed packages on both apk and apt.
pkg_install ca-certificates openssl curl

CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
mkdir -p "$CA_DIR"
if ! curl -fsSL -k -o "$CA_FILE" "$CA_URL"; then
  echo "Warning: could not download CA from $CA_URL" >&2
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
