#!/bin/sh
# Verify the SSL certificate that addon-ssl wrote into the container.
#
# Validates:
#   1. /etc/ssl/addon/fullchain.pem exists inside the container
#   2. openssl can parse it (well-formed PEM)
#   3. The cert's SAN list contains the container hostname (proves it was
#      generated for this container, not a leftover/placeholder)
#   4. The expiry date is in the future (>= now)
#
# Skipped by the template's skip_if_all_missing when addon-ssl is not active.
#
# Template variables:
#   vm_id    - Container VM ID
#   hostname - Container hostname (used for SAN match)
#
# Outputs JSON array with check result. Exit 1 on hard failure.

set -e

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
CERT_PATH="/etc/ssl/addon/fullchain.pem"

emit() {
    printf '[{"id":"check_ssl_cert","value":"%s"}]' "$1"
}

if ! pct exec "$VM_ID" -- test -f "$CERT_PATH" 2>/dev/null; then
    echo "CHECK: ssl_cert FAILED (no $CERT_PATH inside CT $VM_ID)" >&2
    emit "missing"
    exit 1
fi

# Use the container's openssl (avoids host/CT cert format mismatches).
if ! pct exec "$VM_ID" -- sh -c "command -v openssl >/dev/null 2>&1"; then
    echo "CHECK: ssl_cert FAILED (openssl not available in CT $VM_ID)" >&2
    emit "no-openssl"
    exit 1
fi

CERT_TEXT=$(pct exec "$VM_ID" -- openssl x509 -in "$CERT_PATH" -noout -text 2>/dev/null) || {
    echo "CHECK: ssl_cert FAILED (cannot parse $CERT_PATH)" >&2
    emit "unparseable"
    exit 1
}

# Subject Alternative Names must include the hostname (proof of fresh issue).
SAN_LINE=$(printf '%s\n' "$CERT_TEXT" | sed -n '/X509v3 Subject Alternative Name/{n;p;}' | tr -d ' ')
if [ -n "$HOSTNAME" ] && ! printf '%s' "$SAN_LINE" | grep -qE "DNS:${HOSTNAME}(,|$)"; then
    echo "CHECK: ssl_cert FAILED (SAN '$SAN_LINE' does not include DNS:$HOSTNAME)" >&2
    emit "san-mismatch"
    exit 1
fi

# Expiry must be in the future.
if ! pct exec "$VM_ID" -- openssl x509 -in "$CERT_PATH" -noout -checkend 0 >/dev/null 2>&1; then
    NOT_AFTER=$(pct exec "$VM_ID" -- openssl x509 -in "$CERT_PATH" -noout -enddate 2>/dev/null | sed 's/notAfter=//')
    echo "CHECK: ssl_cert FAILED (expired: $NOT_AFTER)" >&2
    emit "expired"
    exit 1
fi

NOT_AFTER=$(pct exec "$VM_ID" -- openssl x509 -in "$CERT_PATH" -noout -enddate 2>/dev/null | sed 's/notAfter=//')
SUBJECT=$(pct exec "$VM_ID" -- openssl x509 -in "$CERT_PATH" -noout -subject 2>/dev/null | sed 's/subject=//')
echo "CHECK: ssl_cert PASSED ($SUBJECT; not_after=$NOT_AFTER; SAN ok)" >&2
emit "ok"
