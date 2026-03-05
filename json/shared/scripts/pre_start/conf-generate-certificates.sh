#!/bin/sh
# Generate Certificates
#
# This script auto-generates TLS certificates for deployed containers.
# It parses cert_requests (assembled by backend) and generates certs
# using the CA key+cert provided as base64 parameters.
#
# Uses cert_resolve_dir() from cert-common.sh library when ssl.certs_dir
# is set to override the default volume key.
#
# Template variables:
#   cert_requests  - Multiline: paramId|certtype|volumeKey per line
#   ca_key_b64     - Base64-encoded CA private key PEM
#   ca_cert_b64    - Base64-encoded CA certificate PEM
#   shared_volpath - Base path for volumes
#   hostname       - Container hostname
#   domain_suffix  - FQDN suffix (default: .local)
#   ssl.certs_dir  - Volume key[:subdirectory] override (or empty)
#   uid, gid       - File ownership
#   mapped_uid, mapped_gid - Host-mapped ownership

# Library functions are prepended automatically:
# - cert_resolve_dir(), cert_generate_server(), cert_generate_fullchain()
# - cert_write_ca_pub(), cert_write_ca()
# - cert_check_validity(), cert_output_result()

# Get template variables
CERT_REQUESTS="{{ cert_requests }}"
CA_KEY_B64="{{ ca_key_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
SHARED_VOLPATH="{{ shared_volpath }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
SSL_CERTS_DIR="{{ ssl.certs_dir }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

[ "$SSL_CERTS_DIR" = "NOT_DEFINED" ] && SSL_CERTS_DIR=""
[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=".local"

# Compute FQDN
FQDN="${HOSTNAME}${DOMAIN_SUFFIX}"
echo "Generating certificates for FQDN: ${FQDN}" >&2

# Calculate effective UID/GID (prefer mapped values)
EFFECTIVE_UID="${UID_VAL}"
EFFECTIVE_GID="${GID_VAL}"
if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "NOT_DEFINED" ]; then
  EFFECTIVE_UID="$MAPPED_UID"
fi
if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "NOT_DEFINED" ]; then
  EFFECTIVE_GID="$MAPPED_GID"
fi

# Sanitize hostname for directory name (same logic as upload-file-common.sh)
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

# Parse cert_requests line by line
echo "$CERT_REQUESTS" | while IFS='|' read -r PARAM_ID CERTTYPE VOLUME_KEY; do
  # Skip empty lines
  [ -z "$PARAM_ID" ] && continue

  # Resolve target directory: use ssl.certs_dir if set, otherwise use volume key from cert_requests
  TARGET_DIR=$(cert_resolve_dir "$SSL_CERTS_DIR" "$SHARED_VOLPATH" "$SAFE_HOST" "$VOLUME_KEY")

  echo "Processing: ${PARAM_ID} (${CERTTYPE}) -> ${TARGET_DIR}" >&2

  # Ensure target directory exists
  if [ ! -d "$TARGET_DIR" ]; then
    echo "Warning: Volume directory '${TARGET_DIR}' not found for ${PARAM_ID}, creating it" >&2
    mkdir -p "$TARGET_DIR"
  fi

  # Determine check file based on certtype (Let's Encrypt naming)
  case "$CERTTYPE" in
    server)    CHECK_FILE="${TARGET_DIR}/cert.pem" ;;
    fullchain) CHECK_FILE="${TARGET_DIR}/fullchain.pem" ;;
    ca_pub)    CHECK_FILE="${TARGET_DIR}/chain.pem" ;;
    ca)        CHECK_FILE="${TARGET_DIR}/chain.pem" ;;
    *)
      echo "Warning: Unknown certtype '${CERTTYPE}' for ${PARAM_ID}, skipping" >&2
      continue
      ;;
  esac

  # Check validity AND FQDN match (regenerate if FQDN changed or cert expiring)
  if cert_check_validity "$CHECK_FILE" 30 && cert_check_fqdn_match "$CHECK_FILE" "$FQDN"; then
    echo "Certificate ${CHECK_FILE} is still valid and FQDN matches, skipping regeneration" >&2
    continue
  fi
  if [ -f "$CHECK_FILE" ] && ! cert_check_fqdn_match "$CHECK_FILE" "$FQDN"; then
    echo "FQDN mismatch detected, regenerating certificate for ${FQDN}" >&2
  fi

  # Generate cert based on certtype
  case "$CERTTYPE" in
    server)
      cert_generate_server "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$TARGET_DIR" "$HOSTNAME"
      ;;
    fullchain)
      cert_generate_fullchain "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$TARGET_DIR" "$HOSTNAME"
      ;;
    ca_pub)
      cert_write_ca_pub "$CA_CERT_B64" "$TARGET_DIR"
      ;;
    ca)
      cert_write_ca "$CA_KEY_B64" "$CA_CERT_B64" "$TARGET_DIR"
      ;;
  esac

  # Set ownership on generated files
  if [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
    chown -R "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$TARGET_DIR" 2>/dev/null || true
  fi
done

# Output result
cert_output_result "certs_generated"
