#!/bin/sh
# Certificate Common Library
#
# This library provides functions for certificate operations on PVE host.
# CA key+cert arrive as base64 parameters (not from filesystem).
#
# Main functions:
#   1. cert_generate_server    - Generate server key+cert signed by CA
#   2. cert_generate_fullchain - Generate server key + fullchain cert (server+CA)
#   3. cert_write_ca_pub       - Write CA public cert only
#   4. cert_write_ca           - Write CA key+cert
#   5. cert_check_validity     - Check if cert is valid for N days
#   6. cert_output_result      - Generate JSON output
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
# cert_generate_server()
# Generate server key+cert signed by CA
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - fqdn:        Fully qualified domain name
#   $4 - target_dir:  Directory to write server.key and server.crt
#   $5 - hostname:    Short hostname (for SAN)
# Returns: 0 on success, 1 on failure
# ============================================================================
cert_generate_server() {
  _ca_key_b64="$1"
  _ca_cert_b64="$2"
  _fqdn="$3"
  _target_dir="$4"
  _hostname="$5"

  _tmp_ca_dir=$(mktemp -d)

  echo "$_ca_key_b64" | base64 -d > "$_tmp_ca_dir/ca.key"
  echo "$_ca_cert_b64" | base64 -d > "$_tmp_ca_dir/ca.crt"

  _san="DNS:${_fqdn},DNS:${_hostname},DNS:localhost,IP:127.0.0.1"

  # Generate server key
  openssl genrsa -out "$_target_dir/server.key" 2048 2>/dev/null

  # Generate CSR
  openssl req -new \
    -key "$_target_dir/server.key" \
    -out "$_tmp_ca_dir/server.csr" \
    -subj "/CN=${_fqdn}" 2>/dev/null

  # Write extfile for SAN (POSIX-compatible, no process substitution)
  printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth" "$_san" > "$_tmp_ca_dir/ext.cnf"

  # Sign with CA (validity: 825 days)
  openssl x509 -req \
    -in "$_tmp_ca_dir/server.csr" \
    -CA "$_tmp_ca_dir/ca.crt" \
    -CAkey "$_tmp_ca_dir/ca.key" \
    -CAcreateserial \
    -out "$_target_dir/server.crt" \
    -days 825 \
    -extfile "$_tmp_ca_dir/ext.cnf" \
    2>/dev/null

  _rc=$?

  # Clean up CA key from temp
  rm -rf "$_tmp_ca_dir"

  if [ $_rc -eq 0 ]; then
    CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 2))
    echo "Generated server cert for ${_fqdn} in ${_target_dir}" >&2
  else
    echo "Failed to generate server cert for ${_fqdn}" >&2
  fi

  return $_rc
}

# ============================================================================
# cert_generate_fullchain()
# Generate server key + fullchain cert (server cert + CA cert concatenated)
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - fqdn:        Fully qualified domain name
#   $4 - target_dir:  Directory to write server.key and fullchain.crt
#   $5 - hostname:    Short hostname (for SAN)
# Returns: 0 on success, 1 on failure
# ============================================================================
cert_generate_fullchain() {
  _ca_key_b64="$1"
  _ca_cert_b64="$2"
  _fqdn="$3"
  _target_dir="$4"
  _hostname="$5"

  _tmp_ca_dir=$(mktemp -d)

  echo "$_ca_key_b64" | base64 -d > "$_tmp_ca_dir/ca.key"
  echo "$_ca_cert_b64" | base64 -d > "$_tmp_ca_dir/ca.crt"

  _san="DNS:${_fqdn},DNS:${_hostname},DNS:localhost,IP:127.0.0.1"

  # Generate server key
  openssl genrsa -out "$_target_dir/server.key" 2048 2>/dev/null

  # Generate CSR
  openssl req -new \
    -key "$_target_dir/server.key" \
    -out "$_tmp_ca_dir/server.csr" \
    -subj "/CN=${_fqdn}" 2>/dev/null

  # Write extfile for SAN (POSIX-compatible, no process substitution)
  printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth" "$_san" > "$_tmp_ca_dir/ext.cnf"

  # Sign with CA
  openssl x509 -req \
    -in "$_tmp_ca_dir/server.csr" \
    -CA "$_tmp_ca_dir/ca.crt" \
    -CAkey "$_tmp_ca_dir/ca.key" \
    -CAcreateserial \
    -out "$_tmp_ca_dir/server.crt" \
    -days 825 \
    -extfile "$_tmp_ca_dir/ext.cnf" \
    2>/dev/null

  _rc=$?

  if [ $_rc -eq 0 ]; then
    # Concatenate server cert + CA cert into fullchain
    cat "$_tmp_ca_dir/server.crt" "$_tmp_ca_dir/ca.crt" > "$_target_dir/fullchain.crt"
    CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 2))
    echo "Generated fullchain cert for ${_fqdn} in ${_target_dir}" >&2
  else
    echo "Failed to generate fullchain cert for ${_fqdn}" >&2
  fi

  # Clean up CA key from temp
  rm -rf "$_tmp_ca_dir"

  return $_rc
}

# ============================================================================
# cert_write_ca_pub()
# Write CA public certificate only
# Arguments:
#   $1 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $2 - target_dir:  Directory to write ca.crt
# Returns: 0 on success
# ============================================================================
cert_write_ca_pub() {
  _ca_cert_b64="$1"
  _target_dir="$2"

  echo "$_ca_cert_b64" | base64 -d > "$_target_dir/ca.crt"
  CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 1))
  echo "Wrote CA public cert to ${_target_dir}/ca.crt" >&2
  return 0
}

# ============================================================================
# cert_write_ca()
# Write CA key and certificate
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - target_dir:  Directory to write ca.key and ca.crt
# Returns: 0 on success
# ============================================================================
cert_write_ca() {
  _ca_key_b64="$1"
  _ca_cert_b64="$2"
  _target_dir="$3"

  echo "$_ca_key_b64" | base64 -d > "$_target_dir/ca.key"
  echo "$_ca_cert_b64" | base64 -d > "$_target_dir/ca.crt"
  CERT_FILES_WRITTEN=$((CERT_FILES_WRITTEN + 2))
  echo "Wrote CA key+cert to ${_target_dir}" >&2
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
