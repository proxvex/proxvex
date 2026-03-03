#!/bin/sh
# Write manually uploaded SSL certificates to the addon certs volume.
#
# If the user uploaded a certificate and key, decode from base64 and write
# them to the certs volume directory, overriding any auto-generated certificates.
# If values are NOT_DEFINED (not uploaded), skip — auto-generation via
# 156-conf-generate-certificates handles that case.
#
# Uses cert_resolve_dir() from cert-common.sh library to determine the
# certificate directory based on ssl.certs_dir parameter.
#
# Requires:
#   - ssl.cert: Base64-encoded PEM certificate (or NOT_DEFINED)
#   - ssl.key: Base64-encoded PEM private key (or NOT_DEFINED)
#   - ssl.certs_dir: Volume key[:subdirectory] for cert location (or empty)
#   - shared_volpath: Shared volume base path
#   - hostname: Container hostname
#   - uid/gid: Ownership for certificate files
#   - mapped_uid/mapped_gid: Optional mapped UID/GID (preferred if set)
#
# Output: [{"id": "uploaded_certs_written", "value": "true/false"}]

SSL_CERT="{{ ssl.cert }}"
SSL_KEY="{{ ssl.key }}"
SSL_CERTS_DIR="{{ ssl.certs_dir }}"
SHARED_VOLPATH="{{ shared_volpath }}"
HOSTNAME="{{ hostname }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

[ "$SSL_CERT" = "NOT_DEFINED" ] && SSL_CERT=""
[ "$SSL_KEY" = "NOT_DEFINED" ] && SSL_KEY=""
[ "$SSL_CERTS_DIR" = "NOT_DEFINED" ] && SSL_CERTS_DIR=""
[ "$MAPPED_UID" = "NOT_DEFINED" ] && MAPPED_UID=""
[ "$MAPPED_GID" = "NOT_DEFINED" ] && MAPPED_GID=""

# Determine effective UID/GID
EFFECTIVE_UID="${UID_VAL}"
EFFECTIVE_GID="${GID_VAL}"
if [ -n "$MAPPED_UID" ]; then
  EFFECTIVE_UID="$MAPPED_UID"
fi
if [ -n "$MAPPED_GID" ]; then
  EFFECTIVE_GID="$MAPPED_GID"
fi

# If no cert uploaded, skip
if [ -z "$SSL_CERT" ] || [ -z "$SSL_KEY" ]; then
  echo "No uploaded certificates found, skipping (auto-generation will handle certs)" >&2
  printf '[{"id": "uploaded_certs_written", "value": "false"}]\n'
  exit 0
fi

# Sanitize hostname for directory name
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

# Resolve certificate directory via library function
CERT_DIR=$(cert_resolve_dir "$SSL_CERTS_DIR" "$SHARED_VOLPATH" "$SAFE_HOST" "certs")

if [ ! -d "$CERT_DIR" ]; then
  echo "Creating cert directory: $CERT_DIR" >&2
  mkdir -p "$CERT_DIR"
fi

# Extract base64 content (handle file:name:content:base64 format)
extract_base64() {
  _val="$1"
  # Check for file metadata format: file:<name>:<content-type>:<base64>
  case "$_val" in
    file:*:*:*)
      echo "$_val" | cut -d: -f4-
      ;;
    *)
      echo "$_val"
      ;;
  esac
}

CERT_B64=$(extract_base64 "$SSL_CERT")
KEY_B64=$(extract_base64 "$SSL_KEY")

# Write certificate (Let's Encrypt naming convention)
echo "Writing uploaded certificate to ${CERT_DIR}/fullchain.pem" >&2
echo "$CERT_B64" | base64 -d > "${CERT_DIR}/fullchain.pem"

# Write private key
echo "Writing uploaded private key to ${CERT_DIR}/privkey.pem" >&2
echo "$KEY_B64" | base64 -d > "${CERT_DIR}/privkey.pem"

# Set ownership and permissions
chown "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "${CERT_DIR}/fullchain.pem" "${CERT_DIR}/privkey.pem"
chmod 644 "${CERT_DIR}/fullchain.pem"
chmod 600 "${CERT_DIR}/privkey.pem"

echo "Uploaded certificates written successfully" >&2
printf '[{"id": "uploaded_certs_written", "value": "true"}]\n'
