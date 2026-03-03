#!/bin/sh
# Provision PVE Host Certificate
#
# Generates and deploys a server certificate for the PVE host itself.
# Runs on PVE host via SSH. Uses cert-common.sh library.
#
# Template variables:
#   ca_key_b64    - Base64-encoded CA private key PEM
#   ca_cert_b64   - Base64-encoded CA certificate PEM
#   fqdn          - PVE host FQDN
#   hostname      - PVE host short hostname
#   domain_suffix - Domain suffix

# Library functions are prepended automatically:
# - cert_generate_server()

CA_KEY_B64="{{ ca_key_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
FQDN="{{ fqdn }}"
HOSTNAME="{{ hostname }}"

TMP_DIR=$(mktemp -d)

echo "Provisioning PVE certificate for ${FQDN}..." >&2

# Generate server cert in temp dir
cert_generate_server "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$TMP_DIR" "$HOSTNAME"

if [ $? -ne 0 ]; then
  echo "Failed to generate PVE server certificate" >&2
  rm -rf "$TMP_DIR"
  echo '[{"id":"pve_cert_provisioned","value":"false"}]'
  exit 1
fi

# Backup existing certs
if [ -f /etc/pve/local/pve-ssl.pem ]; then
  cp /etc/pve/local/pve-ssl.pem /etc/pve/local/pve-ssl.pem.bak 2>/dev/null || true
  echo "Backed up existing PVE SSL cert" >&2
fi
if [ -f /etc/pve/local/pve-ssl.key ]; then
  cp /etc/pve/local/pve-ssl.key /etc/pve/local/pve-ssl.key.bak 2>/dev/null || true
  echo "Backed up existing PVE SSL key" >&2
fi

# Deploy new certs (cert_generate_server now uses LE naming)
cp "$TMP_DIR/cert.pem" /etc/pve/local/pve-ssl.pem
cp "$TMP_DIR/privkey.pem" /etc/pve/local/pve-ssl.key

# Write CA cert for trust
echo "$CA_CERT_B64" | base64 -d > /etc/pve/pve-root-ca.pem
echo "Deployed CA cert to /etc/pve/pve-root-ca.pem" >&2

# Clean up temp
rm -rf "$TMP_DIR"

# Restart pveproxy to pick up new cert
echo "Restarting pveproxy..." >&2
systemctl restart pveproxy 2>&1 >&2 || true

echo "PVE certificate provisioned successfully for ${FQDN}" >&2
echo '[{"id":"pve_cert_provisioned","value":"true"}]'
