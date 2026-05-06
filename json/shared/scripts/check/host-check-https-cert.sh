#!/bin/sh
# Verify the HTTPS endpoint serves a valid proxvex-signed cert with the right SAN.
# Runs on the PVE host. Targets either an LXC container (via its IP) or the
# PVE host itself (vm_id=0 -> localhost) when proxmox-app reconfigures.
# Output JSON: [{"id":"check_https_cert","value":"ok"|<reason>}]

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
HTTPS_PORT="{{ https_port }}"
SSL_MODE="{{ ssl_mode }}"

[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=".local"
[ "$HTTPS_PORT"    = "NOT_DEFINED" ] && HTTPS_PORT=""
[ "$SSL_MODE"      = "NOT_DEFINED" ] && SSL_MODE=""

# Native SSL means the app speaks TLS on https_port directly. nginx-proxy modes
# put TLS on a different port. If https_port is missing for native mode, abort
# rather than guessing (most apps set it as a property default).
if [ -z "$HTTPS_PORT" ] || [ "$HTTPS_PORT" = "0" ]; then
  echo "CHECK: https_cert FAILED (https_port not set)" >&2
  printf '[{"id":"check_https_cert","value":"no port"}]'
  exit 1
fi

# vm_id=0 means the target is the PVE host (proxmox app reconfigure case);
# otherwise look up the container's IP via pct.
if [ "$VM_ID" = "0" ] || [ -z "$VM_ID" ] || [ "$VM_ID" = "NOT_DEFINED" ]; then
  TARGET="127.0.0.1"
else
  TARGET=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null \
           | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
  if [ -z "$TARGET" ]; then
    echo "CHECK: https_cert FAILED (no IP for VM ${VM_ID})" >&2
    printf '[{"id":"check_https_cert","value":"no ip"}]'
    exit 1
  fi
fi

EXPECTED_SAN="${HOSTNAME}${DOMAIN_SUFFIX}"
echo "Probing ${TARGET}:${HTTPS_PORT} (SNI=${EXPECTED_SAN})" >&2

# Pull the leaf cert. -servername sends SNI so apps that route on hostname
# (e.g. nginx with multiple vhosts) return the right cert.
PEM=$(echo | timeout 10 openssl s_client -connect "${TARGET}:${HTTPS_PORT}" \
      -servername "${EXPECTED_SAN}" -showcerts 2>/dev/null \
      | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \
      | sed -n '1,/-----END CERTIFICATE-----/p')

if [ -z "$PEM" ]; then
  echo "CHECK: https_cert FAILED (TLS handshake)" >&2
  printf '[{"id":"check_https_cert","value":"handshake"}]'
  exit 1
fi

PARSED=$(echo "$PEM" | openssl x509 -noout -subject -issuer -ext subjectAltName -dates 2>/dev/null)

# CN/SAN must match the expected hostname — guards against stale leftover certs.
SAN_LINE=$(echo "$PARSED" | grep -i "DNS:" | head -1)
if ! echo "$SAN_LINE" | grep -qE "DNS:${EXPECTED_SAN}(,|$| )"; then
  if ! echo "$PARSED" | grep -iqE "subject=.*CN[ ]*=[ ]*${EXPECTED_SAN}"; then
    echo "CHECK: https_cert FAILED (SAN/CN does not match ${EXPECTED_SAN})" >&2
    echo "  cert: ${PARSED}" >&2
    printf '[{"id":"check_https_cert","value":"san mismatch"}]'
    exit 1
  fi
fi

# Issuer must be the proxvex CA. Anything else means a stale/bypass cert.
if ! echo "$PARSED" | grep -iqE "issuer=.*Proxvex CA"; then
  echo "CHECK: https_cert FAILED (issuer is not Proxvex CA)" >&2
  echo "  cert: ${PARSED}" >&2
  printf '[{"id":"check_https_cert","value":"wrong issuer"}]'
  exit 1
fi

# Refuse certs that expire within a week — they would silently break the next
# run after a rollback or on the morning a developer comes back.
if ! echo "$PEM" | openssl x509 -noout -checkend 604800 >/dev/null 2>&1; then
  echo "CHECK: https_cert FAILED (expires within 7 days)" >&2
  printf '[{"id":"check_https_cert","value":"expiring"}]'
  exit 1
fi

echo "CHECK: https_cert PASSED (${TARGET}:${HTTPS_PORT}, SAN=${EXPECTED_SAN})" >&2
printf '[{"id":"check_https_cert","value":"ok"}]'
