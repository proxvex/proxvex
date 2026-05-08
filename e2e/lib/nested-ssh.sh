#!/bin/bash
# nested-ssh.sh — single-source SSH/SCP helpers for the nested test VM.
#
# What this layer is for:
#   The nested Proxmox VM is reached through the outer PVE host's port
#   forward (root@$PVE_HOST:$PORT_PVE_SSH). Two pain points motivated this
#   helper:
#
#   1. Snapshot rollbacks reset the VM but the SSH host key stayed in the
#      snapshot — every previous workflow used UserKnownHostsFile=/dev/null
#      + StrictHostKeyChecking=no to dodge the "REMOTE HOST IDENTIFICATION
#      HAS CHANGED" warning. That dodge silently disables MITM protection.
#   2. The "Permanently added '<ip>' to known hosts" warning printed on
#      every connect just adds noise to step output.
#
# Fix: step0-create-iso.sh generates a per-instance ed25519 host key and
# stores it in e2e/config.json.instances.<instance>.hostKey. first-boot.sh
# pins /etc/ssh/ssh_host_ed25519_key to that key during VM install. This
# helper derives a per-instance known_hosts file from the matching public
# key on the dev side and runs ssh with StrictHostKeyChecking=yes.
#
# Usage:
#   . "$SCRIPT_DIR/lib/nested-ssh.sh"
#   nested_ssh "uptime"
#   nested_scp_to /local/path /remote/path
#   nested_scp_from /remote/path /local/path
#
# Required env (from e2e/config.sh load_config):
#   E2E_INSTANCE              - instance name (green/yellow/github-action/…)
#   PVE_HOST                  - outer PVE host (port-forward target)
#   PORT_PVE_SSH              - port-forward port -> nested VM:22
#   HOST_KEY_ED25519_PUB_B64  - base64'd public key from config.json
#                               (empty → fall back to permissive mode +
#                               warn, so first-time bring-up still works)
#
# The known_hosts file lives next to config.json as
# .known_hosts-<instance>, gitignored alongside config.json itself.

# Resolve the per-instance known_hosts file. Regenerate from
# HOST_KEY_ED25519_PUB_B64 on every call so a config.json change is picked
# up without manual cleanup. Cheap (a few I/O + base64 -d).
_nested_ssh_known_hosts() {
    local lib_dir kh
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    kh="$lib_dir/../.known_hosts-${E2E_INSTANCE}"

    if [ -z "${HOST_KEY_ED25519_PUB_B64:-}" ]; then
        # No pinned key yet — emit empty file path so the caller's caller
        # can choose to fall back to permissive mode. Empty path is the
        # signal: "not configured."
        printf ''
        return 0
    fi

    # The .pub file's content has the form:
    #   ssh-ed25519 AAAA…BASE64… nested-vm-<instance>
    # known_hosts entry needs:
    #   <hostspec> keytype keymaterial [comment]
    # We use the bare $PVE_HOST as <hostspec> (no `[host]:port` wrapping).
    # ssh callers pass `-o HostKeyAlias=$PVE_HOST` so the lookup happens
    # under that exact string, regardless of any HostName-rewrite in the
    # user's ~/.ssh/config or the non-default port.
    local pubkey entry tmp
    pubkey=$(printf '%s' "$HOST_KEY_ED25519_PUB_B64" | base64 -d 2>/dev/null) || {
        echo "nested-ssh: HOST_KEY_ED25519_PUB_B64 is not valid base64" >&2
        return 1
    }
    entry="${PVE_HOST} ${pubkey}"

    # Atomic replace via tmpfile so a concurrent ssh in another step
    # cannot read a half-written file.
    tmp="${kh}.tmp.$$"
    printf '%s\n' "$entry" > "$tmp"
    mv "$tmp" "$kh"
    chmod 600 "$kh"

    printf '%s' "$kh"
}

# Run a command on the nested VM via the outer host's port forward.
# Falls back to permissive mode (UserKnownHostsFile=/dev/null,
# StrictHostKeyChecking=no, LogLevel=ERROR) when the host key has not
# been generated yet (HOST_KEY_ED25519_PUB_B64 empty).
#
# HostKeyAlias=$PVE_HOST forces the known_hosts lookup to use the bare
# hostname under which we wrote the entry, regardless of any
# `Host ubuntupve / HostName 192.168.4.24` rewrite in the user's
# ~/.ssh/config — without it, ssh canonicalises to the IP and reports
# "no ED25519 host key is known for [192.168.4.24]:1022".
nested_ssh() {
    local kh
    kh=$(_nested_ssh_known_hosts) || return 1
    if [ -n "$kh" ]; then
        ssh -o UserKnownHostsFile="$kh" -o StrictHostKeyChecking=yes \
            -o HostKeyAlias="$PVE_HOST" \
            -o BatchMode=yes -o ConnectTimeout=10 \
            -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
    else
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o LogLevel=ERROR \
            -o BatchMode=yes -o ConnectTimeout=10 \
            -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
    fi
}

# scp from the dev machine to the nested VM.
# nested_scp_to <local-source> <remote-dest>
nested_scp_to() {
    local kh src dst
    src="$1"
    dst="$2"
    kh=$(_nested_ssh_known_hosts) || return 1
    if [ -n "$kh" ]; then
        scp -o UserKnownHostsFile="$kh" -o StrictHostKeyChecking=yes \
            -o HostKeyAlias="$PVE_HOST" \
            -o BatchMode=yes -o ConnectTimeout=10 \
            -P "$PORT_PVE_SSH" \
            "$src" "root@$PVE_HOST:$dst"
    else
        scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o LogLevel=ERROR \
            -o BatchMode=yes -o ConnectTimeout=10 \
            -P "$PORT_PVE_SSH" \
            "$src" "root@$PVE_HOST:$dst"
    fi
}

# scp from the nested VM back to the dev machine.
# nested_scp_from <remote-source> <local-dest>
nested_scp_from() {
    local kh src dst
    src="$1"
    dst="$2"
    kh=$(_nested_ssh_known_hosts) || return 1
    if [ -n "$kh" ]; then
        scp -o UserKnownHostsFile="$kh" -o StrictHostKeyChecking=yes \
            -o HostKeyAlias="$PVE_HOST" \
            -o BatchMode=yes -o ConnectTimeout=10 \
            -P "$PORT_PVE_SSH" \
            "root@$PVE_HOST:$src" "$dst"
    else
        scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o LogLevel=ERROR \
            -o BatchMode=yes -o ConnectTimeout=10 \
            -P "$PORT_PVE_SSH" \
            "root@$PVE_HOST:$src" "$dst"
    fi
}
