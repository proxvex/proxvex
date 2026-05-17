#!/bin/sh
# Bootstrap SSH access for a test-proxvex-deployer LXC, before the container starts.
# Mirrors install-proxvex.sh:855-921 but driven from a pre-start template instead
# of the standalone installer wrapper. Only used by the livetest overlay app;
# production deployers get the same setup from install-proxvex.sh during real install.
#
# Steps:
#   1. Resolve the container's /secure volume directory on the host
#   2. Generate an Ed25519 keypair into /secure/.ssh/ (or reuse if already present)
#   3. Append the public key to PVE host /root/.ssh/authorized_keys
#   4. ssh-keyscan the PVE host and populate /secure/.ssh/known_hosts
#   5. chown the new files to the mapped UID/GID so the container's lxc user can read
#
# Idempotent — safe to re-run on upgrade.
set -eu

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

[ "$MAPPED_UID" = "NOT_DEFINED" ] || [ -z "$MAPPED_UID" ] && MAPPED_UID="$UID_VAL"
[ "$MAPPED_GID" = "NOT_DEFINED" ] || [ -z "$MAPPED_GID" ] && MAPPED_GID="$GID_VAL"

SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

SECURE_DIR=$(resolve_host_volume "$SAFE_HOST" "secure" "$VM_ID")
if [ -z "$SECURE_DIR" ] || [ ! -d "$SECURE_DIR" ]; then
  echo "ERROR: cannot resolve /secure host path for $HOSTNAME (vm_id=$VM_ID)" >&2
  exit 1
fi

SSH_DIR="${SECURE_DIR}/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

# 1. Reuse existing key if /secure already carries one (upgrade case)
PUBKEY=""
if [ -f "${SSH_DIR}/id_ed25519.pub" ]; then
  PUBKEY=$(cat "${SSH_DIR}/id_ed25519.pub" 2>/dev/null | grep -v '^$' || true)
fi

# 2. Otherwise generate fresh
if [ -z "$PUBKEY" ]; then
  ssh-keygen -t ed25519 -f "${SSH_DIR}/id_ed25519" -N "" -C "test-proxvex-deployer@${HOSTNAME}" >/dev/null 2>&1
  chmod 600 "${SSH_DIR}/id_ed25519"
  chmod 644 "${SSH_DIR}/id_ed25519.pub"
  PUBKEY=$(cat "${SSH_DIR}/id_ed25519.pub" 2>/dev/null | grep -v '^$' || true)
  echo "Generated SSH keypair at ${SSH_DIR}/id_ed25519" >&2
fi

if [ -z "$PUBKEY" ]; then
  echo "ERROR: ssh-keygen failed and no key found at ${SSH_DIR}/id_ed25519.pub" >&2
  exit 1
fi

# 3. Add pubkey to PVE root authorized_keys
ROOT_AUTH=/root/.ssh/authorized_keys
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ -L "$ROOT_AUTH" ]; then
  ROOT_AUTH=$(readlink -f "$ROOT_AUTH")
fi
if [ -f "$ROOT_AUTH" ] && grep -qF "$PUBKEY" "$ROOT_AUTH" 2>/dev/null; then
  echo "Pubkey already in $ROOT_AUTH" >&2
else
  echo "$PUBKEY" >> "$ROOT_AUTH"
  chmod 600 "$ROOT_AUTH"
  echo "Appended test-deployer pubkey to $ROOT_AUTH" >&2
fi

# 4. Populate known_hosts with PVE host's pubkey
PVE_HOST=$(hostname -f 2>/dev/null || hostname)
HOST_KEY=$(ssh-keyscan -t ed25519 "$PVE_HOST" 2>/dev/null || true)
if [ -z "$HOST_KEY" ]; then
  # Hostname may not resolve from the PVE itself; fall back to localhost and rewrite
  HOST_KEY=$(ssh-keyscan -t ed25519 localhost 2>/dev/null | sed "s/^localhost/${PVE_HOST}/" || true)
fi
if [ -n "$HOST_KEY" ]; then
  # Append idempotently — keep older keys around so we don't churn on every upgrade
  if [ ! -f "${SSH_DIR}/known_hosts" ] || ! grep -qF "$HOST_KEY" "${SSH_DIR}/known_hosts" 2>/dev/null; then
    echo "$HOST_KEY" >> "${SSH_DIR}/known_hosts"
    echo "Added ${PVE_HOST} host key to known_hosts" >&2
  fi
  chmod 644 "${SSH_DIR}/known_hosts"
fi

# 5. chown everything to the mapped uid/gid so the container's lxc user owns its key
chown -R "${MAPPED_UID}:${MAPPED_GID}" "$SSH_DIR" 2>/dev/null || true

echo '[{"id":"test_deployer_ssh_configured","value":"true"}]'
