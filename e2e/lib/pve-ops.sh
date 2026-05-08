# pve-ops.sh — outer-host VM lifecycle operations on the PVE host.
#
# Sourced by step2a-setup-mirrors.sh, step2b-install-deployer.sh, and any
# script that needs to drive `qm` against the outer PVE host. Two backends:
#
#   PVE_USE_API=1  HTTPS calls to the PVE REST API using a scoped token.
#                  This is the Phase A1+A2 path — no SSH to the PVE host
#                  for qm operations, no host-key warnings, no
#                  StrictHostKeyChecking=no bypass.
#   PVE_USE_API=0  ssh ${PVE_SSH_USER:-root}@${PVE_HOST} "qm ..."
#                  Legacy path, kept as fallback for first-boot and for
#                  developers who haven't yet run setup-pve-api-token.sh.
#
# Auto-detection: when PVE_USE_API is unset/empty AND a sourceable token
# file exists at ${PVE_API_TOKEN_FILE:-$HOME/.config/proxvex/pve-api-token},
# this file is read and PVE_USE_API flips to 1 automatically. Run
# e2e/setup-pve-api-token.sh once to populate it. The runner LXC's
# entrypoint sets PVE_USE_API=1 explicitly, so auto-detection is a no-op
# there.
#
# Required env (API path):
#   PVE_HOST              PVE node hostname (e.g. ubuntupve)
#   PVE_NODE              Cluster node name; defaults to PVE_HOST
#   PVE_API_TOKEN_ID      e.g. "proxvex-runner@pam!runner-token"
#   PVE_API_TOKEN_SECRET  the UUID secret printed by `pveum user token add`
#   PVE_API_CA            path to PVE root CA cert; default
#                          $HOME/.config/proxvex/pve-root-ca.pem (dev) or
#                          /etc/pve/pve-root-ca.pem (PVE host) or whatever
#                          the operator distributed to the runner LXC.
#
# Required env (SSH path):
#   PVE_HOST              same
#   PVE_SSH_USER          default root
#
# All public functions exit 0 on success, non-zero otherwise. Long-running
# operations (start/stop/snapshot/rollback) wait for the underlying PVE task
# to finish before returning.

# Auto-load API credentials from the standard config location when the
# caller hasn't pinned PVE_USE_API explicitly. This is what flips the dev
# machine onto the API path after a single `setup-pve-api-token.sh` run.
if [ -z "${PVE_USE_API:-}" ]; then
    _PVEOPS_TOKEN_FILE="${PVE_API_TOKEN_FILE:-$HOME/.config/proxvex/pve-api-token}"
    if [ -f "$_PVEOPS_TOKEN_FILE" ]; then
        # shellcheck disable=SC1090
        . "$_PVEOPS_TOKEN_FILE"
        export PVE_API_TOKEN_ID PVE_API_TOKEN_SECRET
        PVE_USE_API=1
        : "${PVE_API_CA:=$HOME/.config/proxvex/pve-root-ca.pem}"
    else
        PVE_USE_API=0
    fi
fi

PVE_USE_API="${PVE_USE_API:-0}"
PVE_NODE="${PVE_NODE:-$PVE_HOST}"
PVE_SSH_USER="${PVE_SSH_USER:-root}"
PVE_API_CA="${PVE_API_CA:-/etc/pve/pve-root-ca.pem}"

_pveops_curl() {
    if [ "$PVE_API_CA" = "-" ]; then
        curl -fsS -k \
            -H "Authorization: PVEAPIToken=${PVE_API_TOKEN_ID}=${PVE_API_TOKEN_SECRET}" \
            "$@"
    elif [ -f "$PVE_API_CA" ]; then
        curl -fsS --cacert "$PVE_API_CA" \
            -H "Authorization: PVEAPIToken=${PVE_API_TOKEN_ID}=${PVE_API_TOKEN_SECRET}" \
            "$@"
    else
        echo "pve-ops: PVE_API_CA=$PVE_API_CA not found, falling back to -k" >&2
        curl -fsS -k \
            -H "Authorization: PVEAPIToken=${PVE_API_TOKEN_ID}=${PVE_API_TOKEN_SECRET}" \
            "$@"
    fi
}

_pveops_qemu_url() {
    echo "https://${PVE_HOST}:8006/api2/json/nodes/${PVE_NODE}/qemu/$1$2"
}

_pveops_wait_task() {
    local upid="$1" timeout="${2:-300}" t=0 resp status exitstatus
    while [ "$t" -lt "$timeout" ]; do
        resp=$(_pveops_curl "https://${PVE_HOST}:8006/api2/json/nodes/${PVE_NODE}/tasks/${upid}/status" 2>/dev/null) || return 1
        status=$(printf '%s' "$resp" | jq -r '.data.status // ""')
        if [ "$status" = "stopped" ]; then
            exitstatus=$(printf '%s' "$resp" | jq -r '.data.exitstatus // "OK"')
            # PVE returns "OK" on clean success and "WARNINGS: N" when the
            # task succeeded but logged warnings (e.g. start with --skiplock,
            # snapshot vmstate writeback). Both are non-fatal.
            case "$exitstatus" in
                OK|WARNINGS:*) return 0 ;;
            esac
            echo "pve-ops: task $upid failed: $exitstatus" >&2
            return 1
        fi
        sleep 1
        t=$((t + 1))
    done
    echo "pve-ops: task $upid timeout after ${timeout}s" >&2
    return 1
}

_pveops_ssh() {
    # LogLevel=ERROR suppresses the "Permanently added '<host>' to the list
    # of known hosts" line that ssh emits on every connect when
    # UserKnownHostsFile=/dev/null. The legacy path stays disable-by-default
    # for security review (no host-key validation) but at least it stops
    # spamming step2a's output. The recommended path is the API token
    # branch above — see setup-pve-api-token.sh.
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o BatchMode=yes -o ConnectTimeout=10 \
        "${PVE_SSH_USER}@${PVE_HOST}" "$@"
}

pve_qm_status() {
    local vmid="$1"
    if [ "$PVE_USE_API" = "1" ]; then
        _pveops_curl "$(_pveops_qemu_url "$vmid" /status/current)" | jq -r '.data.status // "unknown"'
    else
        _pveops_ssh "qm status $vmid 2>/dev/null" | awk '{print $2}'
    fi
}

pve_qm_is_stopped() {
    [ "$(pve_qm_status "$1")" = "stopped" ]
}

pve_qm_start() {
    local vmid="$1" upid
    if [ "$PVE_USE_API" = "1" ]; then
        upid=$(_pveops_curl -X POST "$(_pveops_qemu_url "$vmid" /status/start)" | jq -r '.data')
        _pveops_wait_task "$upid"
    else
        _pveops_ssh "qm start $vmid"
    fi
}

pve_qm_stop() {
    local vmid="$1" upid
    if [ "$PVE_USE_API" = "1" ]; then
        upid=$(_pveops_curl -X POST "$(_pveops_qemu_url "$vmid" /status/stop)" | jq -r '.data')
        _pveops_wait_task "$upid"
    else
        _pveops_ssh "qm stop $vmid"
    fi
}

pve_qm_shutdown() {
    local vmid="$1" timeout="${2:-30}" upid
    if [ "$PVE_USE_API" = "1" ]; then
        upid=$(_pveops_curl -X POST --data-urlencode "timeout=$timeout" "$(_pveops_qemu_url "$vmid" /status/shutdown)" | jq -r '.data')
        _pveops_wait_task "$upid" "$((timeout + 30))"
    else
        _pveops_ssh "qm shutdown $vmid --timeout $timeout"
    fi
}

pve_qm_snapshot_exists() {
    local vmid="$1" name="$2"
    if [ "$PVE_USE_API" = "1" ]; then
        _pveops_curl "$(_pveops_qemu_url "$vmid" /snapshot)" \
            | jq -e --arg n "$name" '.data[] | select(.name == $n)' >/dev/null 2>&1
    else
        _pveops_ssh "qm listsnapshot $vmid 2>/dev/null" \
            | awk -v n="$name" '$0 ~ "->[[:space:]]+"n"([[:space:]]|$)" {found=1} END {exit !found}'
    fi
}

pve_qm_snapshot_description() {
    local vmid="$1" name="$2"
    if [ "$PVE_USE_API" = "1" ]; then
        _pveops_curl "$(_pveops_qemu_url "$vmid" /snapshot)" \
            | jq -r --arg n "$name" '.data[] | select(.name == $n) | .description // ""'
    else
        _pveops_ssh "qm listsnapshot $vmid 2>/dev/null" \
            | awk -v n="$name" '
                $0 ~ "->[[:space:]]+"n"[[:space:]]" {
                    sub(/^[^0-9]*[0-9-]+[ ][0-9:]+[[:space:]]+/, "")
                    print
                    exit
                }'
    fi
}

pve_qm_snapshot_create() {
    local vmid="$1" name="$2" description="${3:-}" upid
    if [ "$PVE_USE_API" = "1" ]; then
        if [ -n "$description" ]; then
            upid=$(_pveops_curl -X POST \
                --data-urlencode "snapname=$name" \
                --data-urlencode "description=$description" \
                "$(_pveops_qemu_url "$vmid" /snapshot)" | jq -r '.data')
        else
            upid=$(_pveops_curl -X POST \
                --data-urlencode "snapname=$name" \
                "$(_pveops_qemu_url "$vmid" /snapshot)" | jq -r '.data')
        fi
        _pveops_wait_task "$upid" 600
    else
        if [ -n "$description" ]; then
            local q
            q=$(printf %q "$description")
            _pveops_ssh "qm snapshot $vmid $name --description $q"
        else
            _pveops_ssh "qm snapshot $vmid $name"
        fi
    fi
}

pve_qm_snapshot_delete() {
    local vmid="$1" name="$2" upid
    if [ "$PVE_USE_API" = "1" ]; then
        if pve_qm_snapshot_exists "$vmid" "$name"; then
            upid=$(_pveops_curl -X DELETE "$(_pveops_qemu_url "$vmid" /snapshot/"$name")" | jq -r '.data')
            _pveops_wait_task "$upid" 120
        fi
    else
        _pveops_ssh "qm delsnapshot $vmid $name 2>/dev/null || true"
    fi
}

pve_qm_snapshot_rollback() {
    local vmid="$1" name="$2" upid
    if [ "$PVE_USE_API" = "1" ]; then
        upid=$(_pveops_curl -X POST "$(_pveops_qemu_url "$vmid" /snapshot/"$name"/rollback)" | jq -r '.data')
        _pveops_wait_task "$upid" 120
    else
        _pveops_ssh "qm rollback $vmid $name"
    fi
}
