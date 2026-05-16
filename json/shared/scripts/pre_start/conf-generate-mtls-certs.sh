#!/bin/sh
# Write pre-signed mTLS client certificates to the managed `mtls` volume.
#
# Signing happens in the backend (CertificateAuthorityService in Hub mode, or
# via Hub's POST /api/hub/ca/sign with mode=client in Spoke mode). This script
# only writes the already-signed files. It MUST NOT have access to the CA
# private key.
#
# One subfolder per CN under <shared_volpath>/volumes/<hostname>/mtls/:
#   <CN>/privkey.pem  - client private key
#   <CN>/cert.pem     - client certificate (clientAuth, CA:FALSE)
#   <CN>/chain.pem    - CA public certificate
#
# Template variables:
#   vm_id                  - Container VM ID
#   mtls_client_certs_b64  - base64(JSON) of { "<cn>": { "key": b64, "cert": b64 }, ... }
#   ca_cert_b64            - Base64-encoded CA public certificate PEM
#   hostname               - Container hostname
#   uid, gid               - File ownership
#   mapped_uid, mapped_gid - Host-mapped ownership
#
# Library functions are prepended automatically:
# - pve_effective_uid/gid, pve_sanitize_name, resolve_host_volume (pve-common.sh)
# - cert_write_client, cert_should_skip_write, cert_output_result (cert-common.sh)

VM_ID="{{ vm_id }}"
BUNDLE_B64="{{ mtls_client_certs_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
HOSTNAME="{{ hostname }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

if [ -z "$BUNDLE_B64" ] || [ "$BUNDLE_B64" = "NOT_DEFINED" ]; then
  echo "mtls: no client cert bundle provided — nothing to do" >&2
  cert_output_result "mtls_certs_generated"
  exit 0
fi

# Calculate effective UID/GID via pve-common helpers so that custom lxc.idmap
# ranges are honored (same logic as conf-generate-certificates.sh).
PCT_CFG=""
if [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  PCT_CFG=$(pct config "$VM_ID" 2>/dev/null || true)
fi
EFFECTIVE_UID=$(pve_effective_uid "$PCT_CFG" "$UID_VAL" "$MAPPED_UID")
EFFECTIVE_GID=$(pve_effective_gid "$PCT_CFG" "$GID_VAL" "$MAPPED_GID")
echo "mtls: effective_uid=$EFFECTIVE_UID effective_gid=$EFFECTIVE_GID" >&2

SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")
MTLS_DIR=$(resolve_host_volume "$SAFE_HOST" "mtls" "$VM_ID")
mkdir -p "$MTLS_DIR"
chmod 0700 "$MTLS_DIR" 2>/dev/null || true

# Decode CA cert once: source for chain.pem and for the CA-rotation aware
# idempotency check in cert_should_skip_write.
CA_TMP=""
if [ -n "$CA_CERT_B64" ] && [ "$CA_CERT_B64" != "NOT_DEFINED" ]; then
  CA_TMP=$(mktemp)
  if ! echo "$CA_CERT_B64" | base64 -d > "$CA_TMP" 2>/dev/null; then
    rm -f "$CA_TMP"
    CA_TMP=""
  fi
fi

# Explode the bundle into <WORK>/<cn>.name / .key.b64 / .cert.b64 via python3
# (available on the PVE host). JSON parsing is not POSIX-shell friendly.
WORK=$(mktemp -d)
if ! echo "$BUNDLE_B64" | base64 -d | python3 - "$WORK" <<'PY'
import json, sys, os, re
work = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("mtls: failed to parse cert bundle JSON: %s\n" % e)
    sys.exit(1)
count = 0
for cn, v in (data or {}).items():
    if not re.fullmatch(r'[A-Za-z0-9._-]+', cn or ''):
        sys.stderr.write("mtls: skipping invalid CN %r\n" % cn)
        continue
    if not isinstance(v, dict) or "key" not in v or "cert" not in v:
        sys.stderr.write("mtls: skipping CN %r with malformed entry\n" % cn)
        continue
    with open(os.path.join(work, cn + ".name"), "w") as f:
        f.write(cn)
    with open(os.path.join(work, cn + ".key.b64"), "w") as f:
        f.write(v["key"])
    with open(os.path.join(work, cn + ".cert.b64"), "w") as f:
        f.write(v["cert"])
    count += 1
sys.stderr.write("mtls: bundle contains %d valid client cert(s)\n" % count)
PY
then
  echo "mtls: bundle decode/parse failed" >&2
  [ -n "$CA_TMP" ] && rm -f "$CA_TMP"
  rm -rf "$WORK"
  exit 1
fi

for namef in "$WORK"/*.name; do
  [ -f "$namef" ] || continue
  CN=$(cat "$namef")
  CN_DIR="$MTLS_DIR/$CN"
  mkdir -p "$CN_DIR"

  NEW_CERT_TMP=$(mktemp)
  base64 -d < "$WORK/$CN.cert.b64" > "$NEW_CERT_TMP" 2>/dev/null

  if cert_should_skip_write "$CN_DIR/cert.pem" "$NEW_CERT_TMP" 30 "$CA_TMP"; then
    echo "mtls: $CN unchanged and still valid — keeping existing key+cert pair" >&2
  else
    cert_write_client "$WORK/$CN.key.b64" "$WORK/$CN.cert.b64" "$CA_CERT_B64" "$CN_DIR"
  fi
  rm -f "$NEW_CERT_TMP"
done

[ -n "$CA_TMP" ] && rm -f "$CA_TMP"
rm -rf "$WORK"

# Ensure ownership on the whole mtls tree — always, not only when something
# was (re)written. An upgrade can skip regeneration but the volume gets cloned
# with whatever ownership the previous container had.
if [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ] && [ -d "$MTLS_DIR" ]; then
  chown -R "${EFFECTIVE_UID}:${EFFECTIVE_GID}" "$MTLS_DIR" 2>/dev/null || true
  echo "mtls: ensured ownership of ${MTLS_DIR} is ${EFFECTIVE_UID}:${EFFECTIVE_GID}" >&2
fi

cert_output_result "mtls_certs_generated"
