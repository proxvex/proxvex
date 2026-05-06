#!/bin/sh
# Proxmox host override: write the pre-signed PVE web UI certificate.
#
# The cert is signed by the backend (CertificateAuthorityService / Hub).
# This script only decodes the base64 inputs and writes them to the
# pveproxy user-override paths, then asks pveproxy to reload.
#
# Library functions are prepended automatically (see template 156):
# - cert_write_server() / cert_write_ca_pub() / cert_output_result()
#
# Target paths:
#   /etc/pve/local/pveproxy-ssl.pem  - server cert (user-managed override)
#   /etc/pve/local/pveproxy-ssl.key  - server key
# These take precedence over /etc/pve/local/pve-ssl.{pem,key}, which is
# managed by `pveca` and must not be touched.

SERVER_KEY_B64="{{ server_key_b64 }}"
SERVER_CERT_B64="{{ server_cert_b64 }}"
CA_CERT_B64="{{ ca_cert_b64 }}"
HOSTNAME="{{ hostname }}"
NEEDS_SERVER_CERT="{{ ssl.needs_server_cert }}"
NEEDS_CA_CERT="{{ ssl.needs_ca_cert }}"

[ "$NEEDS_SERVER_CERT" = "NOT_DEFINED" ] && NEEDS_SERVER_CERT="true"
[ "$NEEDS_CA_CERT" = "NOT_DEFINED" ] && NEEDS_CA_CERT="false"

PVE_LOCAL_DIR="/etc/pve/local"
TMP_DIR=$(mktemp -d)

if [ "$NEEDS_SERVER_CERT" != "false" ]; then
  if [ -z "$SERVER_KEY_B64" ] || [ "$SERVER_KEY_B64" = "NOT_DEFINED" ] \
     || [ -z "$SERVER_CERT_B64" ] || [ "$SERVER_CERT_B64" = "NOT_DEFINED" ]; then
    echo "Error: server_key_b64 / server_cert_b64 not provided by backend" >&2
    rm -rf "$TMP_DIR"
    exit 1
  fi

  # Decode into a tmp dir first so a partial write can't leave pveproxy with
  # a half-written cert. Use the cert-common helper so the failure paths /
  # logging match the rest of the cert pipeline.
  if ! cert_write_server "$SERVER_KEY_B64" "$SERVER_CERT_B64" "$CA_CERT_B64" "$TMP_DIR"; then
    rm -rf "$TMP_DIR"
    exit 1
  fi

  # /etc/pve is the pmxcfs FUSE filesystem, which rejects chmod/chown.
  # Use plain cp; pmxcfs enforces 0640 root:www-data on its own.
  cp "$TMP_DIR/fullchain.pem" "$PVE_LOCAL_DIR/pveproxy-ssl.pem"
  cp "$TMP_DIR/privkey.pem"   "$PVE_LOCAL_DIR/pveproxy-ssl.key"
  echo "Wrote ${PVE_LOCAL_DIR}/pveproxy-ssl.{pem,key} for ${HOSTNAME}" >&2
fi

if [ "$NEEDS_CA_CERT" = "true" ]; then
  if [ -z "$CA_CERT_B64" ] || [ "$CA_CERT_B64" = "NOT_DEFINED" ]; then
    echo "Error: ca_cert_b64 not provided by backend" >&2
    rm -rf "$TMP_DIR"
    exit 1
  fi
  echo "$CA_CERT_B64" | base64 -d > /etc/pve/pve-root-ca.pem
  echo "Wrote /etc/pve/pve-root-ca.pem" >&2
fi

rm -rf "$TMP_DIR"

# Pick up the new cert without dropping live API connections.
if ! systemctl reload-or-restart pveproxy >/dev/null 2>&1; then
  echo "Warning: failed to reload pveproxy" >&2
fi

cert_output_result "certs_generated"
