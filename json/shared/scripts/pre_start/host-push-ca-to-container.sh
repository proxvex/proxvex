#!/bin/sh
# Push the deployer CA cert into the container's system trust store so that
# both skopeo (host-side) and docker (in-container, via system-trust fallback)
# can verify TLS certificates issued by the deployer CA — most importantly
# for a local registry mirror.
#
# Runs on the PVE host. Idempotent: skopes the host's CA file and only writes
# into the container if the same file isn't already there.
#
# The CA is expected at /usr/local/share/ca-certificates/proxvex-ca.crt on the
# PVE host (placed there by setup-pve-host.sh / install-proxvex.sh during host
# registration). When the host has no CA file we no-op silently — registry
# mirror trust isn't relevant in that setup.

VMID="{{ vm_id }}"

CA_HOST=/usr/local/share/ca-certificates/proxvex-ca.crt
CA_GUEST=/usr/local/share/ca-certificates/proxvex-ca.crt

if [ ! -f "$CA_HOST" ]; then
  echo "No deployer CA on host ($CA_HOST) — skipping push" >&2
  echo '[{"id":"ca_pushed","value":"false"}]'
  exit 0
fi

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  echo "Error: vm_id not set" >&2
  exit 1
fi

if pct exec "$VMID" -- test -f "$CA_GUEST" 2>/dev/null \
   && pct exec "$VMID" -- cmp -s "$CA_GUEST" - < "$CA_HOST" 2>/dev/null; then
  echo "Container $VMID already has matching CA at $CA_GUEST" >&2
  echo '[{"id":"ca_pushed","value":"true"}]'
  exit 0
fi

pct push "$VMID" "$CA_HOST" "$CA_GUEST" >&2 || {
  echo "Warning: pct push failed — container TLS clients may not trust deployer CA" >&2
  echo '[{"id":"ca_pushed","value":"false"}]'
  exit 0
}

# Best-effort: refresh the merged bundle in the container. Both update-ca-certificates
# (Debian/Ubuntu/Alpine via package) and update-ca-trust (RHEL family) are tried.
if ! pct exec "$VMID" -- sh -c 'command -v update-ca-certificates >/dev/null && update-ca-certificates' >/dev/null 2>&1; then
  pct exec "$VMID" -- sh -c 'command -v update-ca-trust >/dev/null && update-ca-trust' >/dev/null 2>&1 || true
fi

echo "Pushed deployer CA to container $VMID" >&2
echo '[{"id":"ca_pushed","value":"true"}]'
