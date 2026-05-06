#!/bin/sh
# Verify that the certificate at $CERT_PATH inside the container is issued
# by an issuer matching $EXPECTED_PATTERN (grep -E regex). Polls for up to
# 90s to allow for slow ACME issuance (DNS propagation + LE order).
#
# Template variables:
#   vm_id                        - Container VM ID
#   cert_check_path              - Path inside the container to the PEM file
#   cert_expected_issuer_pattern - grep -E pattern to match against issuer line
#
# Outputs JSON: [{"id":"check_cert_issuer","value":"ok"}] on pass.

VM_ID="{{ vm_id }}"
CERT_PATH="{{ cert_check_path }}"
EXPECTED_PATTERN="{{ cert_expected_issuer_pattern }}"
RETRY_TIMEOUT=90

elapsed=0
issuer=""
while [ "$elapsed" -lt "$RETRY_TIMEOUT" ]; do
  if pct exec "$VM_ID" -- test -f "$CERT_PATH" 2>/dev/null; then
    issuer=$(pct exec "$VM_ID" -- openssl x509 -in "$CERT_PATH" -issuer -noout 2>/dev/null || true)
    if [ -n "$issuer" ]; then
      if echo "$issuer" | grep -E -q "$EXPECTED_PATTERN"; then
        echo "CHECK: cert_issuer PASSED ($issuer matches /$EXPECTED_PATTERN/)" >&2
        printf '[{"id":"check_cert_issuer","value":"ok"}]'
        exit 0
      else
        echo "CHECK: cert_issuer waiting (found '$issuer' — does not match /$EXPECTED_PATTERN/, ${elapsed}s/${RETRY_TIMEOUT}s)" >&2
      fi
    else
      echo "CHECK: cert_issuer waiting (cert file present but openssl could not read issuer, ${elapsed}s/${RETRY_TIMEOUT}s)" >&2
    fi
  else
    echo "CHECK: cert_issuer waiting ($CERT_PATH not yet available, ${elapsed}s/${RETRY_TIMEOUT}s)" >&2
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done

if [ -z "$issuer" ]; then
  echo "CHECK: cert_issuer FAILED ($CERT_PATH never appeared with readable issuer)" >&2
  printf '[{"id":"check_cert_issuer","value":"missing: %s"}]' "$CERT_PATH"
else
  echo "CHECK: cert_issuer FAILED (issuer '$issuer' does not match /$EXPECTED_PATTERN/)" >&2
  printf '[{"id":"check_cert_issuer","value":"mismatch: %s"}]' "$issuer"
fi
exit 1
