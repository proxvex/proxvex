#!/bin/sh
# Renew Certificates
#
# Force-renews certificates for specified hostnames.
# Ignores existing cert validity check - always regenerates.
# Cert directory: <shared_volpath>/volumes/<hostname>/certs/
#
# Template variables:
#   cert_renew_requests - Multiline: hostname per line
#   ca_key_b64          - Base64-encoded CA private key PEM
#   ca_cert_b64         - Base64-encoded CA certificate PEM
#   shared_volpath      - Base path for volumes
#   domain_suffix       - FQDN suffix (default: .local)

# Library functions are prepended automatically:
# - cert_generate_server(), cert_write_ca_pub()
# - cert_output_result()

CERT_RENEW_REQUESTS="{{ cert_renew_requests }}"
CA_KEY_B64="{{ ca_key_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
SHARED_VOLPATH="{{ shared_volpath }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"

# Default shared_volpath if not set
if [ -z "$SHARED_VOLPATH" ] || [ "$SHARED_VOLPATH" = "NOT_DEFINED" ]; then
  SHARED_VOLPATH="/mnt"
fi

if [ -z "$DOMAIN_SUFFIX" ] || [ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ]; then
  DOMAIN_SUFFIX=".local"
fi

echo "Renewing certificates..." >&2

echo "$CERT_RENEW_REQUESTS" | while IFS= read -r HOSTNAME; do
  [ -z "$HOSTNAME" ] && continue

  FQDN="${HOSTNAME}${DOMAIN_SUFFIX}"
  SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  CERT_DIR=$(resolve_host_volume "$SHARED_VOLPATH" "$SAFE_HOST" "certs")

  echo "Renewing: ${HOSTNAME} -> ${CERT_DIR}" >&2

  if [ ! -d "$CERT_DIR" ]; then
    echo "Warning: Cert directory '${CERT_DIR}' not found, creating" >&2
    mkdir -p "$CERT_DIR"
  fi

  # Regenerate server cert (always, ignoring validity)
  cert_generate_server "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$CERT_DIR" "$HOSTNAME"

  # Also write CA cert if chain.pem exists (was previously generated)
  if [ -f "${CERT_DIR}/chain.pem" ]; then
    cert_write_ca_pub "$CA_CERT_B64" "$CERT_DIR"
  fi
done

cert_output_result "certs_renewed"
