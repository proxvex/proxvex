#!/bin/sh
# Install the deployer's CA certificate in the VE host's system trust store.
# Runs on the PVE host (execute_on: ve) so that skopeo and other TLS clients
# trust certificates signed by the deployer CA (e.g. registry mirror).
#
# Idempotent: only updates if the CA has changed or is missing.

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"

[ "$DEPLOYER_URL" = "NOT_DEFINED" ] && DEPLOYER_URL=""
[ "$VE_CONTEXT" = "NOT_DEFINED" ] && VE_CONTEXT=""

if [ -z "$DEPLOYER_URL" ] || [ -z "$VE_CONTEXT" ]; then
  echo "Error: deployer_base_url or ve_context_key not set" >&2
  exit 1
fi

CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
CA_CERT="/usr/local/share/ca-certificates/oci-lxc-deployer-ca.crt"
CA_CERT_SYSTEM="/usr/share/ca-certificates/oci-lxc-deployer-ca.crt"

CA_TMP=$(mktemp)
trap 'rm -f "$CA_TMP"' EXIT

if ! curl -fsSL -k -o "$CA_TMP" "$CA_URL" 2>/dev/null || [ ! -s "$CA_TMP" ]; then
  echo "Error: Could not download CA certificate from ${CA_URL}" >&2
  exit 1
fi

# Only update if CA changed or doesn't exist yet
if [ -f "$CA_CERT" ] && cmp -s "$CA_TMP" "$CA_CERT"; then
  echo "CA certificate unchanged" >&2
  echo '[{"id":"ca_trusted","value":"true"}]'
  exit 0
fi

cp "$CA_TMP" "$CA_CERT"
if [ -d /usr/share/ca-certificates ]; then
  cp "$CA_TMP" "$CA_CERT_SYSTEM"
  if ! grep -q "oci-lxc-deployer-ca.crt" /etc/ca-certificates.conf 2>/dev/null; then
    echo "oci-lxc-deployer-ca.crt" >> /etc/ca-certificates.conf
  fi
fi

if command -v update-ca-certificates > /dev/null 2>&1; then
  update-ca-certificates >/dev/null 2>&1
elif command -v update-ca-trust > /dev/null 2>&1; then
  update-ca-trust >&2 2>&1
fi

echo "CA certificate installed in system trust store" >&2
echo '[{"id":"ca_trusted","value":"true"}]'
