#!/bin/sh
# Write pre-signed TLS certificates to the certs managed volume.
#
# The actual signing happens in the backend (CertificateAuthorityService in
# Hub mode, or via Hub's POST /api/hub/ca/sign in Spoke mode). This script
# only writes the already-signed files into the container's certs volume.
# It MUST NOT have access to the CA private key.
#
# Writes to <shared_volpath>/volumes/<hostname>/certs/  (or cert_dir_override).
#
# Controlled by two flags:
#   ssl.needs_server_cert (default true) - Write server cert (privkey.pem, cert.pem, fullchain.pem)
#   ssl.needs_ca_cert (default false)    - Write CA certificate (chain.pem)
#
# Template variables:
#   server_key_b64  - Base64-encoded server private key PEM (from backend)
#   server_cert_b64 - Base64-encoded server certificate PEM (from backend)
#   ca_cert_b64     - Base64-encoded CA public certificate PEM (from backend)
#   shared_volpath  - Base path for volumes (output from template 160)
#   hostname        - Container hostname
#   domain_suffix   - FQDN suffix (default: .local; informational only)
#   ssl.needs_server_cert - Write server certificate
#   ssl.needs_ca_cert     - Write CA certificate
#   uid, gid        - File ownership
#   mapped_uid, mapped_gid - Host-mapped ownership

# Library functions are prepended automatically:
# - cert_write_server(), cert_write_ca_pub(), cert_output_result()

VM_ID="{{ vm_id }}"
SERVER_KEY_B64="{{ server_key_b64 }}"
SERVER_CERT_B64="{{ server_cert_b64 }}"
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

[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=".local"
[ "$NEEDS_SERVER_CERT" = "NOT_DEFINED" ] && NEEDS_SERVER_CERT="true"
[ "$NEEDS_CA_CERT" = "NOT_DEFINED" ] && NEEDS_CA_CERT="false"

# Compute FQDN (informational; signing already done in backend)
FQDN="${HOSTNAME}${DOMAIN_SUFFIX}"
echo "Writing certificates for FQDN: ${FQDN}" >&2

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
SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")

# Cert directory: override or <shared_volpath>/volumes/<hostname>/certs/
if [ -n "$CERT_DIR_OVERRIDE" ] && [ "$CERT_DIR_OVERRIDE" != "NOT_DEFINED" ]; then
  CERT_DIR="$CERT_DIR_OVERRIDE"
  echo "Using cert_dir_override: ${CERT_DIR}" >&2
else
  CERT_DIR=$(resolve_host_volume "$SAFE_HOST" "certs" "$VM_ID")
fi
mkdir -p "$CERT_DIR"

GENERATED=false

# Server certificate (default: true) — write pre-signed key+cert from backend
if [ "$NEEDS_SERVER_CERT" != "false" ]; then
  if [ -z "$SERVER_KEY_B64" ] || [ "$SERVER_KEY_B64" = "NOT_DEFINED" ] \
     || [ -z "$SERVER_CERT_B64" ] || [ "$SERVER_CERT_B64" = "NOT_DEFINED" ]; then
    echo "Error: server_key_b64 / server_cert_b64 not provided by backend" >&2
    exit 1
  fi
  cert_write_server "$SERVER_KEY_B64" "$SERVER_CERT_B64" "$CA_CERT_B64" "$CERT_DIR"
  GENERATED=true
fi

# CA certificate (default: false) — write public CA cert from backend
if [ "$NEEDS_CA_CERT" = "true" ]; then
  if [ -z "$CA_CERT_B64" ] || [ "$CA_CERT_B64" = "NOT_DEFINED" ]; then
    echo "Error: ca_cert_b64 not provided by backend" >&2
    exit 1
  fi
  cert_write_ca_pub "$CA_CERT_B64" "$CERT_DIR"
  GENERATED=true
fi

# Set ownership on cert directory
if [ "$GENERATED" = "true" ] && [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
  chown -R "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$CERT_DIR" 2>/dev/null || true
  echo "Set ownership of ${CERT_DIR} to ${EFFECTIVE_UID}:${EFFECTIVE_GID}" >&2
fi

cert_output_result "certs_generated"
