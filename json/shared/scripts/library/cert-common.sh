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
#   1. cert_resolve_dir        - Resolve certificate directory from ssl.certs_dir
#   2. cert_generate_server    - Generate all 4 cert files signed by CA
#   3. cert_generate_fullchain - Generate all 4 cert files (alias for cert_generate_server)
#   4. cert_write_ca_pub       - Write CA public cert only (chain.pem)
#   5. cert_write_ca           - Write CA key+cert
#   6. cert_check_validity     - Check if cert is valid for N days
#   7. cert_output_result      - Generate JSON output
#
# Global state variables:
#   CERT_FILES_WRITTEN - Counter for cert files written

# ============================================================================
# GLOBAL STATE
# ============================================================================
CERT_FILES_WRITTEN=0

# ============================================================================
# cert_resolve_dir()
# Resolve certificate directory from ssl.certs_dir parameter
# Arguments:
#   $1 - ssl_certs_dir: Format "volume_key[:subdirectory]" or empty
#   $2 - shared_volpath: Base path for volumes
#   $3 - safe_host: Sanitized hostname
#   $4 - default_vol_key: Fallback volume key (e.g., "certs")
# Returns: Absolute path to certificate directory via stdout
# ============================================================================
cert_resolve_dir() {
  _ssl_certs_dir="$1"
  _shared_volpath="$2"
  _safe_host="$3"
  _default_vol_key="${4:-certs}"

  if [ -n "$_ssl_certs_dir" ] && [ "$_ssl_certs_dir" != "NOT_DEFINED" ]; then
    _vol_key=$(echo "$_ssl_certs_dir" | cut -d: -f1)
    _subdir=$(echo "$_ssl_certs_dir" | cut -d: -f2 -s)
    _safe_vol=$(echo "$_vol_key" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
    _result="${_shared_volpath}/volumes/${_safe_host}/${_safe_vol}"
    [ -n "$_subdir" ] && _result="${_result}/${_subdir}"
    echo "$_result"
  else
    _safe_vol=$(echo "$_default_vol_key" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
    echo "${_shared_volpath}/volumes/${_safe_host}/${_safe_vol}"
  fi
}

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
# Generate all 4 certificate files signed by CA:
#   privkey.pem, cert.pem, chain.pem, fullchain.pem
# Arguments:
#   $1 - ca_key_b64:  Base64-encoded CA private key PEM
#   $2 - ca_cert_b64: Base64-encoded CA certificate PEM
#   $3 - fqdn:        Fully qualified domain name
#   $4 - target_dir:  Directory to write certificate files
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
  openssl genrsa -out "$_target_dir/privkey.pem" 2048 2>/dev/null

  # Generate CSR
  openssl req -new \
    -key "$_target_dir/privkey.pem" \
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
