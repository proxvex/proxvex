#!/bin/sh
# Certificate Common Library
#
# This library provides functions for certificate operations on PVE host.
# CA key+cert arrive as base64 parameters (not from filesystem).
#
# File naming follows Let's Encrypt convention:
#   privkey.pem   - Server private key
#   cert.pem      - Server certificate only
#   chain.pem     - CA public certificate
#   fullchain.pem - Server certificate + CA certificate concatenated
#
# Main functions:
#   1. cert_generate_server    - Generate all 4 cert files signed by CA
#   2. cert_generate_fullchain - Generate all 4 cert files (alias for cert_generate_server)
#   3. cert_write_ca_pub       - Write CA public cert only (chain.pem)
#   4. cert_write_ca           - Write CA key+cert
#   5. cert_check_validity     - Check if cert is valid for N days
#   6. cert_check_fqdn_match   - Check if cert CN matches expected FQDN
#   7. cert_identity_of        - Print CN+SAN identity line for a cert file
#   8. cert_should_skip_write  - Decide whether existing on-disk cert may be kept
#   9. cert_output_result      - Generate JSON output
#
# Global state variables:
#   CERT_FILES_WRITTEN - Counter for cert files written

# ============================================================================
# GLOBAL STATE
# ============================================================================
CERT_FILES_WRITTEN=0

# ============================================================================
# cert_check_validity()
# Check if certificate is valid for at least min_days
# Arguments:
#   $1 - cert_path: Path to certificate file
#   $2 - min_days: Minimum days of validity required (default: 30)
# Returns: 0 = valid, 1 = expiring/missing/invalid
# ============================================================================
cert_check_validity() {
  _cert_path="$1"
  _min_days="${2:-30}"

  if [ ! -f "$_cert_path" ]; then
    return 1
  fi

  _seconds=$((_min_days * 86400))
  if openssl x509 -in "$_cert_path" -checkend "$_seconds" -noout >/dev/null 2>/dev/null; then
    return 0
  else
    return 1
  fi
}

# ============================================================================
# cert_check_fqdn_match()
# Check if certificate CN matches the expected FQDN
# Arguments:
#   $1 - cert_path: Path to certificate file
#   $2 - expected_fqdn: Expected FQDN (CN) value
# Returns: 0 = match, 1 = mismatch/missing/invalid
# ============================================================================
cert_check_fqdn_match() {
  _cert_path="$1"
  _expected_fqdn="$2"

  [ ! -f "$_cert_path" ] && return 1

  _cn=$(openssl x509 -in "$_cert_path" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *\([^ ,]*\).*/\1/p')
  [ "$_cn" = "$_expected_fqdn" ] && return 0
  return 1
}

# ============================================================================
# cert_generate_server()
# Generate all 4 certificate files signed by CA:
#   privkey.pem, cert.pem, chain.pem, fullchain.pem
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - fqdn:        Fully qualified domain name
#   $4 - target_dir:  Directory to write certificate files
#   $5 - hostname:    Short hostname (for SAN)
#   $6 - extra_san:   Additional SAN entries (optional, comma-separated DNS:x,DNS:y)
# Returns: 0 on success, 1 on failure
# ============================================================================
cert_generate_server() {
  _ca_key_b64="$1"
  _ca_cert_b64="$2"
  _fqdn="$3"
  _target_dir="$4"
  _hostname="$5"
  _extra_san="${6:-}"

  _tmp_ca_dir=$(mktemp -d)

  echo "$_ca_key_b64" | base64 -d > "$_tmp_ca_dir/ca.key"
  echo "$_ca_cert_b64" | base64 -d > "$_tmp_ca_dir/ca.crt"

  _san="DNS:${_fqdn},DNS:${_hostname},DNS:localhost,IP:127.0.0.1"
  [ -n "$_extra_san" ] && _san="${_san},${_extra_san}"

  # Generate server key
  openssl genrsa -out "$_target_dir/privkey.pem" 2048 2>/dev/null

  # Generate CSR
  openssl req -new \
    -key "$_target_dir/privkey.pem" \
    -out "$_tmp_ca_dir/server.csr" \
    -subj "/CN=${_fqdn}" 2>/dev/null

  # Write extfile for SAN (POSIX-compatible, no process substitution)
  printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth" "$_san" > "$_tmp_ca_dir/ext.cnf"

  # Sign with CA (validity: 825 days)
  openssl x509 -req \
    -in "$_tmp_ca_dir/server.csr" \
    -CA "$_tmp_ca_dir/ca.crt" \
    -CAkey "$_tmp_ca_dir/ca.key" \
    -CAcreateserial \
    -out "$_target_dir/cert.pem" \
    -days 825 \
    -extfile "$_tmp_ca_dir/ext.cnf" \
    2>/dev/null

  _rc=$?

  if [ $_rc -eq 0 ]; then
    # Write CA public cert as chain.pem
    cp "$_tmp_ca_dir/ca.crt" "$_target_dir/chain.pem"
    # Concatenate server cert + CA cert into fullchain.pem
    cat "$_target_dir/cert.pem" "$_tmp_ca_dir/ca.crt" > "$_target_dir/fullchain.pem"
    CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 4))
    echo "Generated cert files for ${_fqdn} in ${_target_dir} (privkey.pem, cert.pem, chain.pem, fullchain.pem)" >&2
  else
    echo "Failed to generate server cert for ${_fqdn}" >&2
  fi

  # Clean up CA key from temp
  rm -rf "$_tmp_ca_dir"

  return $_rc
}

# ============================================================================
# cert_generate_fullchain()
# Generate all 4 certificate files (same as cert_generate_server).
# Kept for backward compatibility - both functions now produce all 4 files.
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - fqdn:        Fully qualified domain name
#   $4 - target_dir:  Directory to write certificate files
#   $5 - hostname:    Short hostname (for SAN)
# Returns: 0 on success, 1 on failure
# ============================================================================
cert_generate_fullchain() {
  cert_generate_server "$@"
}

# ============================================================================
# cert_write_server()
# Write a pre-signed server certificate (signed by the backend / Hub) to all
# four target files: privkey.pem, cert.pem, chain.pem, fullchain.pem.
# Does NOT touch any CA private key — it just decodes base64 inputs.
# Arguments:
#   $1 - server_key_b64:  Base64-encoded server private key PEM
#   $2 - server_cert_b64: Base64-encoded server certificate PEM
#   $3 - ca_cert_b64:     Base64-encoded CA public certificate PEM
#   $4 - target_dir:      Directory to write certificate files
# Returns: 0 on success, 1 on failure
# ============================================================================
cert_write_server() {
  _srv_key_b64="$1"
  _srv_cert_b64="$2"
  _ca_cert_b64="$3"
  _target_dir="$4"

  if ! echo "$_srv_key_b64" | base64 -d > "$_target_dir/privkey.pem" 2>/dev/null; then
    echo "cert_write_server: failed to decode server_key_b64" >&2
    return 1
  fi
  if ! echo "$_srv_cert_b64" | base64 -d > "$_target_dir/cert.pem" 2>/dev/null; then
    echo "cert_write_server: failed to decode server_cert_b64" >&2
    return 1
  fi
  if ! echo "$_ca_cert_b64" | base64 -d > "$_target_dir/chain.pem" 2>/dev/null; then
    echo "cert_write_server: failed to decode ca_cert_b64" >&2
    return 1
  fi
  cat "$_target_dir/cert.pem" "$_target_dir/chain.pem" > "$_target_dir/fullchain.pem"
  chmod 600 "$_target_dir/privkey.pem" 2>/dev/null || true
  CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 4))
  echo "Wrote pre-signed cert files in ${_target_dir} (privkey.pem, cert.pem, chain.pem, fullchain.pem)" >&2
  return 0
}

# ============================================================================
# cert_write_client()
# Write a pre-signed client certificate (signed by the backend CA) to three
# target files: privkey.pem, cert.pem, chain.pem. Client setups don't need a
# fullchain.pem. The key/cert base64 are read from FILES (not args) to avoid
# passing large base64 blobs on the command line.
# Does NOT touch any CA private key.
# Arguments:
#   $1 - key_b64_file:  Path to a file containing base64 client private key PEM
#   $2 - cert_b64_file: Path to a file containing base64 client certificate PEM
#   $3 - ca_cert_b64:   Base64-encoded CA public certificate PEM
#   $4 - target_dir:    Directory to write certificate files
# Returns: 0 on success, 1 on failure
# ============================================================================
cert_write_client() {
  _kf="$1"
  _cf="$2"
  _ca_b64="$3"
  _td="$4"

  if ! base64 -d < "$_kf" > "$_td/privkey.pem" 2>/dev/null; then
    echo "cert_write_client: failed to decode client key" >&2
    return 1
  fi
  if ! base64 -d < "$_cf" > "$_td/cert.pem" 2>/dev/null; then
    echo "cert_write_client: failed to decode client cert" >&2
    return 1
  fi
  if ! echo "$_ca_b64" | base64 -d > "$_td/chain.pem" 2>/dev/null; then
    echo "cert_write_client: failed to decode ca_cert_b64" >&2
    return 1
  fi
  chmod 600 "$_td/privkey.pem" 2>/dev/null || true
  CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 3))
  echo "Wrote client cert files in ${_td} (privkey.pem, cert.pem, chain.pem)" >&2
  return 0
}

# ============================================================================
# cert_write_ca_pub()
# Write CA public certificate only (chain.pem)
# Arguments:
#   $1 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $2 - target_dir:  Directory to write chain.pem
# Returns: 0 on success
# ============================================================================
cert_write_ca_pub() {
  _ca_cert_b64="$1"
  _target_dir="$2"

  echo "$_ca_cert_b64" | base64 -d > "$_target_dir/chain.pem"
  CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 1))
  echo "Wrote CA public cert to ${_target_dir}/chain.pem" >&2
  return 0
}

# ============================================================================
# cert_write_ca()
# Write CA key and certificate
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - target_dir:  Directory to write ca-privkey.pem and chain.pem
# Returns: 0 on success
# ============================================================================
cert_write_ca() {
  _ca_key_b64="$1"
  _ca_cert_b64="$2"
  _target_dir="$3"

  echo "$_ca_key_b64" | base64 -d > "$_target_dir/ca-privkey.pem"
  echo "$_ca_cert_b64" | base64 -d > "$_target_dir/chain.pem"
  CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 2))
  echo "Wrote CA key+cert to ${_target_dir}" >&2
  return 0
}

# ============================================================================
# cert_identity_of()
# Print a normalized identity line for a server certificate, consisting of
# its CN and the sorted, deduplicated list of subjectAltName entries.
# Used by cert_should_skip_write() to decide whether an on-disk cert and a
# candidate replacement describe the same logical identity.
#
# Output format (single line, components separated by "|"):
#   CN=<cn>|<san1>|<san2>|...
#
# DNS:foo and IP:1.2.3.4 entries are normalized; openssl's "IP Address:" is
# rewritten to "IP:" so the format is stable across openssl versions.
#
# Arguments:
#   $1 - cert_path: Path to PEM-encoded certificate file
# Returns: 0 if a non-empty identity could be extracted, 1 otherwise
# ============================================================================
cert_identity_of() {
  _cert_path="$1"
  [ -f "$_cert_path" ] || return 1

  _cn=$(openssl x509 -in "$_cert_path" -noout -subject 2>/dev/null \
    | sed -n 's/.*CN *= *\([^,]*\).*/CN=\1/p' \
    | sed 's/ *$//')

  _sans=$(openssl x509 -in "$_cert_path" -noout -ext subjectAltName 2>/dev/null \
    | tr -d '\n' \
    | sed 's/.*X509v3 Subject Alternative Name://' \
    | sed 's/ *critical *//' \
    | sed 's/IP Address:/IP:/g' \
    | tr ',' '\n' \
    | sed 's/^ *//;s/ *$//' \
    | grep -v '^$' \
    | sort -u \
    | tr '\n' '|' \
    | sed 's/|$//')

  if [ -z "$_cn" ] && [ -z "$_sans" ]; then
    return 1
  fi

  if [ -n "$_sans" ]; then
    printf '%s|%s\n' "$_cn" "$_sans"
  else
    printf '%s\n' "$_cn"
  fi
  return 0
}

# ============================================================================
# cert_should_skip_write()
# Decide whether the existing on-disk cert can be kept instead of being
# overwritten by a candidate replacement. The existing cert is kept iff ALL
# of the following hold:
#   1. Both files exist and parse as certificates,
#   2. Their identities (CN + SAN list, see cert_identity_of) match exactly,
#   3. The existing cert is still valid for at least min_days (default 30),
#   4. If a CA file is provided: the existing cert verifies against it
#      (catches CA rotation — same DN+SAN but old issuing CA).
#
# This makes cert deployment idempotent on the disk, the source of truth
# for what the container actually serves. The backend signs fresh material
# on every call; this helper decides whether to commit it.
#
# Arguments:
#   $1 - existing_cert_path: Path to currently-deployed cert.pem
#   $2 - new_cert_path:      Path to freshly-signed candidate cert PEM
#   $3 - min_days:           Minimum remaining validity to keep existing
#                            (default 30)
#   $4 - ca_cert_path:       Optional path to PEM-encoded CA cert. When set,
#                            the existing cert MUST verify against it; a
#                            verification failure forces a rewrite. Pass an
#                            empty string to skip this check.
# Returns: 0 = keep existing (skip write), 1 = write new
# ============================================================================
cert_should_skip_write() {
  _existing="$1"
  _new="$2"
  _min_days="${3:-30}"
  _ca_cert="${4:-}"

  [ -f "$_existing" ] || return 1
  [ -f "$_new" ]      || return 1

  _existing_id=$(cert_identity_of "$_existing") || return 1
  _new_id=$(cert_identity_of "$_new")           || return 1

  [ -n "$_existing_id" ] || return 1
  [ "$_existing_id" = "$_new_id" ] || return 1

  cert_check_validity "$_existing" "$_min_days" || return 1

  if [ -n "$_ca_cert" ] && [ -f "$_ca_cert" ]; then
    openssl verify -CAfile "$_ca_cert" "$_existing" >/dev/null 2>&1 || return 1
  fi

  return 0
}

# ============================================================================
# cert_output_result()
# Generate JSON output for template
# Arguments:
#   $1 - output_id: ID for the output parameter (default: "certs_generated")
# Returns: JSON array via stdout
# ============================================================================
cert_output_result() {
  _output_id="${1:-certs_generated}"
  if [ "$CERT_FILES_WRITTEN" -gt 0 ]; then
    echo "[{\"id\":\"$_output_id\",\"value\":\"true\"}]"
  else
    echo "[{\"id\":\"$_output_id\",\"value\":\"false\"}]"
  fi
}
