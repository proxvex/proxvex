#!/bin/sh
# Generate Certificates
#
# Generates TLS certificates for deployed containers.
# Writes cert files to <shared_volpath>/volumes/<hostname>/certs/
# (the directory is created by template 160 via addon_volumes).
#
# Controlled by two flags:
#   ssl.needs_server_cert (default true) - Generate server cert (privkey.pem, cert.pem, fullchain.pem)
#   ssl.needs_ca_cert (default false)    - Write CA certificate (chain.pem)
#
# Template variables:
#   ca_key_b64     - Base64-encoded CA private key PEM
#   ca_cert_b64    - Base64-encoded CA certificate PEM
#   shared_volpath - Base path for volumes (output from template 160)
#   hostname       - Container hostname
#   domain_suffix  - FQDN suffix (default: .local)
#   ssl.needs_server_cert - Generate server certificate
#   ssl.needs_ca_cert     - Write CA certificate
#   uid, gid       - File ownership
#   mapped_uid, mapped_gid - Host-mapped ownership

# Library functions are prepended automatically:
# - cert_generate_server(), cert_generate_fullchain()
# - cert_write_ca_pub(), cert_write_ca()
# - cert_check_validity(), cert_check_fqdn_match(), cert_output_result()

VM_ID="{{ vm_id }}"
CA_KEY_B64="{{ ca_key_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
NEEDS_SERVER_CERT="{{ ssl.needs_server_cert }}"
NEEDS_CA_CERT="{{ ssl.needs_ca_cert }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"
CERT_DIR_OVERRIDE="{{ cert_dir_override }}"
ADDITIONAL_SAN="{{ ssl_additional_san }}"

[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=".local"
[ "$ADDITIONAL_SAN" = "NOT_DEFINED" ] && ADDITIONAL_SAN=""
[ "$NEEDS_SERVER_CERT" = "NOT_DEFINED" ] && NEEDS_SERVER_CERT="true"
[ "$NEEDS_CA_CERT" = "NOT_DEFINED" ] && NEEDS_CA_CERT="false"

# Compute FQDN
FQDN="${HOSTNAME}${DOMAIN_SUFFIX}"
echo "Generating certificates for FQDN: ${FQDN}" >&2

# Calculate effective UID/GID (prefer mapped values, then read lxc.init.uid, then offset)
EFFECTIVE_UID="${UID_VAL}"
EFFECTIVE_GID="${GID_VAL}"
if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "NOT_DEFINED" ]; then
  EFFECTIVE_UID="$MAPPED_UID"
elif [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  PCT_CFG=$(pct config "$VM_ID" 2>/dev/null || true)
  # Prefer lxc.init.uid (the actual UID the app runs as, already host-mapped)
  INIT_UID=$(echo "$PCT_CFG" | grep -aE '^lxc\.init\.uid:' | awk '{print $2}' | head -1)
  if [ -n "$INIT_UID" ]; then
    EFFECTIVE_UID="$INIT_UID"
  elif echo "$PCT_CFG" | grep -qE '^unprivileged:\s*1'; then
    EFFECTIVE_UID=$((100000 + UID_VAL))
  fi
fi
if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "NOT_DEFINED" ]; then
  EFFECTIVE_GID="$MAPPED_GID"
elif [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  PCT_CFG=$(pct config "$VM_ID" 2>/dev/null || true)
  INIT_GID=$(echo "$PCT_CFG" | grep -aE '^lxc\.init\.gid:' | awk '{print $2}' | head -1)
  if [ -n "$INIT_GID" ]; then
    EFFECTIVE_GID="$INIT_GID"
  elif echo "$PCT_CFG" | grep -qE '^unprivileged:\s*1'; then
    EFFECTIVE_GID=$((100000 + GID_VAL))
  fi
fi
echo "cert-gen: effective_uid=$EFFECTIVE_UID effective_gid=$EFFECTIVE_GID" >&2

# Sanitize hostname for directory name
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

# Cert directory: override or <shared_volpath>/volumes/<hostname>/certs/
if [ -n "$CERT_DIR_OVERRIDE" ] && [ "$CERT_DIR_OVERRIDE" != "NOT_DEFINED" ]; then
  CERT_DIR="$CERT_DIR_OVERRIDE"
  echo "Using cert_dir_override: ${CERT_DIR}" >&2
else
  CERT_DIR=$(resolve_host_volume "$SAFE_HOST" "certs")
fi
mkdir -p "$CERT_DIR"

GENERATED=false

# Server certificate (default: true)
if [ "$NEEDS_SERVER_CERT" != "false" ]; then
  CHECK_FILE="${CERT_DIR}/cert.pem"
  if cert_check_validity "$CHECK_FILE" 30 && cert_check_fqdn_match "$CHECK_FILE" "$FQDN"; then
    echo "Server certificate still valid and FQDN matches, skipping" >&2
  else
    if [ -f "$CHECK_FILE" ] && ! cert_check_fqdn_match "$CHECK_FILE" "$FQDN"; then
      echo "FQDN mismatch detected, regenerating server certificate for ${FQDN}" >&2
    fi
    cert_generate_server "$CA_KEY_B64" "$CA_CERT_B64" "$FQDN" "$CERT_DIR" "$HOSTNAME" "$ADDITIONAL_SAN"
    GENERATED=true
  fi
fi

# CA certificate (default: false)
if [ "$NEEDS_CA_CERT" = "true" ]; then
  cert_write_ca_pub "$CA_CERT_B64" "$CERT_DIR"
  GENERATED=true
fi

# Set ownership on cert directory
if [ "$GENERATED" = "true" ] && [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
  chown -R "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$CERT_DIR" 2>/dev/null || true
  echo "Set ownership of ${CERT_DIR} to ${EFFECTIVE_UID}:${EFFECTIVE_GID}" >&2
fi

cert_output_result "certs_generated"
