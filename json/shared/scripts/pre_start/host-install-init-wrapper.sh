#!/bin/sh
# =============================================================================
# host-install-init-wrapper.sh — install /usr/local/sbin/proxvex-init into the
# container rootfs so per-netns sysctls are set before the app (PID 1) starts.
#
# WHY: in an oci-image app the service IS the container init, and it usually
# runs as a non-root uid (gitea: uid 1000). Such a process cannot bind ports
# below net.ipv4.ip_unprivileged_port_start (default 1024), so an app that
# should answer on 443 has to be moved to a high port (local_https_port
# defaults to 1443 for exactly that reason).
#
# The sysctl is per network namespace, so it could simply be set for the
# container — but Proxmox rejects raw `lxc.sysctl.*` keys ("unable to parse
# config") and strips them on the next config write, and `lxc.hook.start-host`
# is rejected as well. Inside the container there is no "before the app"
# either: the app is the first process.
#
# The same ordering problem applies to any other per-netns sysctl, e.g.
# net.ipv4.ip_forward for a VPN gateway (wireguard): container_sysctls lists
# them and the wrapper writes each one before handing over.
#
# ipv6_token pins the interface ID of eth0's SLAAC addresses
# (`ip token set ::53 dev eth0` → <prefix>::53). The default ID is derived
# from the MAC, which changes on every upgrade/reconfigure, and the prefix of
# a DS-Lite/cable line changes on its own — a token keeps the address
# predictable for a router firewall rule that matches only the interface ID.
#
# SO: wrap init. This script writes a tiny wrapper into the rootfs; the OCI
# configuration step (conf-oci-lxc-configuration.py) points the container's
# init (lxc.init.cmd or the Proxmox `entrypoint:` key) at it, keeping the
# original command as its arguments. The wrapper sets the sysctls and then
# `exec "$@"` — no extra process stays behind, and it happens on every start,
# not just the deploy.
#
# File capabilities (setcap cap_net_bind_service, parameter
# bind_privileged_port) are not an alternative here: they need libcap inside
# the guest, they must be applied before the process starts (same ordering
# problem), and a capability written from the host is ignored inside a user
# namespace unless it carries a rootid.
#
# Parameters:
#   vm_id                    - container id (required)
#   unprivileged_port_start  - lowest port a non-root process may bind
#                              (e.g. 443). Empty / NOT_DEFINED → not set.
#   container_sysctls        - key=value per line (net.* keys only, e.g.
#                              net.ipv4.ip_forward=1). Empty → none.
#   ipv6_token               - IPv6 interface ID for eth0 (e.g. ::53).
#                              Empty → MAC-derived (kernel default).
#   All empty → no-op, no wrapper.
#
# Runs on the VE with the container stopped; mounts the rootfs offline via
# vol_mount (same mechanism as host-push-ca-to-container.sh).
#
# Library: pve-common.sh + vol-common.sh (vol_mount, vol_get_storage_type)
# Output: [{"id":"init_wrapper_installed","value":"true|false"}] — read by
# conf-oci-lxc-configuration.py (107), which only points the container's init
# at the wrapper when it was actually written.
#
# Whether the wrapper is written at all:
#   - unprivileged_port_start defaults to 443, so every OCI app with a shell
#     gets the wrapper (root-init images included: gitea starts s6 as root
#     and runs gitea itself as uid 1000).
#   - The image needs /bin/sh (the wrapper is a shell script) — distroless
#     images are skipped instead of being made unbootable.
#   - A non-root app needs a privilege-drop tool in the image (setpriv,
#     su-exec or su); otherwise skip rather than refuse to start.
# =============================================================================

VMID="{{ vm_id }}"
PORT_START="{{ unprivileged_port_start }}"
SYSCTLS="{{ container_sysctls }}"
IPV6_TOKEN="{{ ipv6_token }}"

WRAPPER_RELPATH=usr/local/sbin/proxvex-init

[ "$PORT_START" = "NOT_DEFINED" ] && PORT_START=""
[ "$SYSCTLS" = "NOT_DEFINED" ] && SYSCTLS=""
[ "$IPV6_TOKEN" = "NOT_DEFINED" ] && IPV6_TOKEN=""

if [ -z "$PORT_START" ] && [ -z "$IPV6_TOKEN" ] \
  && [ -z "$(printf '%s' "$SYSCTLS" | tr -d '[:space:]')" ]; then
  echo "unprivileged_port_start, container_sysctls and ipv6_token not set — no init wrapper needed" >&2
  echo '[{"id":"init_wrapper_installed","value":"false"}]'
  exit 0
fi

skip() {
  echo "Init wrapper not installed: $1" >&2
  echo '[{"id":"init_wrapper_installed","value":"false"}]'
  exit 0
}

if [ -n "$PORT_START" ]; then
  case "$PORT_START" in
    *[!0-9]*)
      echo "Error: unprivileged_port_start must be a number (got '$PORT_START')" >&2
      exit 1
      ;;
  esac
  if [ "$PORT_START" -lt 1 ] || [ "$PORT_START" -gt 65535 ]; then
    echo "Error: unprivileged_port_start out of range: $PORT_START" >&2
    exit 1
  fi
fi

if [ -n "$IPV6_TOKEN" ]; then
  # Interface ID only: must start with "::" so the upper 64 bits stay zero.
  case "$IPV6_TOKEN" in
    ::*[!0-9a-fA-F:]*|::)
      echo "Error: ipv6_token must be an interface ID like ::53 (got '$IPV6_TOKEN')" >&2
      exit 1
      ;;
    ::*) ;;
    *)
      echo "Error: ipv6_token must start with '::' (interface ID only, got '$IPV6_TOKEN')" >&2
      exit 1
      ;;
  esac
fi

# Turn each sysctl into a "key value" line ("net.ipv4.ip_forward=1" →
# "net.ipv4.ip_forward 1"). Keys and values are restricted to a safe character
# set because they end up verbatim in a shell script.
parse_sysctls() {
  printf '%s\n' "$SYSCTLS" | while IFS= read -r entry; do
    entry=$(printf '%s' "$entry" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$entry" in ''|'#'*) continue ;; esac
    key=${entry%%=*}
    value=${entry#*=}
    key=$(printf '%s' "$key" | sed 's/[[:space:]]*$//')
    value=$(printf '%s' "$value" | sed 's/^[[:space:]]*//')
    if [ "$key" = "$entry" ]; then
      echo "Error: container_sysctls entry '$entry' is not key=value" >&2
      exit 1
    fi
    case "$key" in
      net.*) ;;
      *)
        echo "Error: container_sysctls key '$key' is not a net.* sysctl (only those are per-netns and writable in an unprivileged container)" >&2
        exit 1
        ;;
    esac
    case "$key" in
      *[!a-zA-Z0-9._-]*)
        echo "Error: invalid sysctl key '$key'" >&2
        exit 1
        ;;
    esac
    case "$value" in
      ''|*[!a-zA-Z0-9._:/-]*)
        echo "Error: invalid value for sysctl '$key': '$value'" >&2
        exit 1
        ;;
    esac
    printf '%s %s\n' "$key" "$value"
  done
}
SYSCTL_LIST=$(parse_sysctls) || exit 1

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  echo "Error: vm_id not set" >&2
  exit 1
fi

# The image's user, as Proxmox derived it from the OCI config (empty = root).
INIT_UID=$(pct config "$VMID" 2>/dev/null | sed -n 's/^lxc\.init\.uid:[[:space:]]*//p' | head -1)
[ "$INIT_UID" = "0" ] && INIT_UID=""
# A root init does not mean a root app: images like gitea start s6 as root
# and run the service as uid 1000, which then needs the lower port start.
# So root-init images get the wrapper too — for them it only writes the
# sysctls and execs, no privilege change.

# Read rootfs volid from pct config: `rootfs: local-zfs:subvol-500-disk-0,size=1G`
ROOTFS_VOLID=$(pct config "$VMID" 2>/dev/null \
  | awk '/^rootfs:/ {
      sub(/^rootfs:[[:space:]]+/,"");
      split($0,a,",");
      print a[1];
      exit
    }')

if [ -z "$ROOTFS_VOLID" ]; then
  echo "Error: cannot determine rootfs of vmid $VMID from pct config" >&2
  exit 1
fi

ROOTFS_VOLNAME="${ROOTFS_VOLID#*:}"
STORAGE="${ROOTFS_VOLID%%:*}"
STORAGE_TYPE=$(vol_get_storage_type "$STORAGE")
if [ -z "$STORAGE_TYPE" ]; then
  echo "Error: cannot determine storage type for $STORAGE" >&2
  exit 1
fi

ROOTFS_PATH=$(vol_mount "$ROOTFS_VOLID" "$ROOTFS_VOLNAME" "$STORAGE_TYPE" "$STORAGE")
if [ -z "$ROOTFS_PATH" ] || [ ! -d "$ROOTFS_PATH" ]; then
  echo "Error: vol_mount returned no usable directory for $ROOTFS_VOLID (got '$ROOTFS_PATH')" >&2
  exit 1
fi

# For block-based storages we mounted ourselves; release the mount on exit so
# pct start can attach the rootfs cleanly (see host-push-ca-to-container.sh).
case "$STORAGE_TYPE" in
  lvm|lvmthin)
    trap 'umount "$ROOTFS_PATH" 2>/dev/null || umount -l "$ROOTFS_PATH" 2>/dev/null || true; rmdir "$ROOTFS_PATH" 2>/dev/null || true' EXIT
    ;;
esac

# The wrapper is a shell script: distroless images cannot run it.
if [ ! -e "${ROOTFS_PATH}/bin/sh" ] && [ ! -L "${ROOTFS_PATH}/bin/sh" ]; then
  skip "image has no /bin/sh"
fi

# A non-root app needs a way back down from root. busybox's setpriv applet
# cannot change uids, so a setpriv that is a busybox link does not count.
if [ -n "$INIT_UID" ]; then
  DROP_TOOL=""
  for t in usr/bin/setpriv bin/setpriv; do
    if [ -e "${ROOTFS_PATH}/$t" ] && [ ! -L "${ROOTFS_PATH}/$t" ]; then DROP_TOOL=setpriv; fi
  done
  for t in sbin/su-exec usr/sbin/su-exec usr/bin/su-exec bin/su usr/bin/su; do
    if [ -z "$DROP_TOOL" ] && { [ -e "${ROOTFS_PATH}/$t" ] || [ -L "${ROOTFS_PATH}/$t" ]; }; then DROP_TOOL=${t##*/}; fi
  done
  if [ -z "$DROP_TOOL" ]; then
    skip "app runs as uid $INIT_UID and the image has no setpriv/su-exec/su to drop privileges again"
  fi
  echo "Privilege drop for uid $INIT_UID via $DROP_TOOL" >&2
fi

TARGET="${ROOTFS_PATH}/${WRAPPER_RELPATH}"
mkdir -p "$(dirname "$TARGET")" || {
  echo "Error: cannot create $(dirname "$TARGET")" >&2
  exit 1
}

# Emit one wrapper line that writes a sysctl. It must not fail the app: a
# read-only or missing sysctl only means that feature stays off (privileged
# ports closed, no forwarding), which the app itself will report.
sysctl_line() {
  printf "echo '%s' > %s 2>/dev/null || echo 'proxvex-init: cannot set %s' >&2\n" \
    "$2" "/proc/sys/$(printf '%s' "$1" | tr '.' '/')" "$1"
}

{
  echo '#!/bin/sh'
  echo '# Written by proxvex (host-install-init-wrapper.sh) — do not edit.'
  echo '# Sets per-netns sysctls, then hands over to the app as PID 1.'
  # Optional leading `--as UID:GID:GROUPS`: conf-oci-lxc-configuration.py
  # removes lxc.init.uid/gid/groups so this wrapper starts as root (only root
  # may write /proc/sys) and passes the image's user here; the wrapper drops
  # to it right before exec.
  cat <<'WRAPPER_ARGS'
AS_UID=""
if [ "$1" = "--as" ]; then
  _as=$2
  shift 2
  AS_UID=${_as%%:*}
  _rest=${_as#*:}
  AS_GID=${_rest%%:*}
  AS_GROUPS=${_rest#*:}
fi
WRAPPER_ARGS
  [ -n "$PORT_START" ] && sysctl_line net.ipv4.ip_unprivileged_port_start "$PORT_START"
  printf '%s\n' "$SYSCTL_LIST" | while read -r key value; do
    [ -n "$key" ] && sysctl_line "$key" "$value"
  done
  # After the sysctls: the kernel refuses a token while eth0 ignores router
  # advertisements, so accept_ra must already be on (forwarding=1 needs
  # accept_ra=2). Then a router solicitation brings <prefix>::<token>.
  if [ -n "$IPV6_TOKEN" ]; then
    printf "ip token set '%s' dev eth0 2>/dev/null || echo 'proxvex-init: cannot set ipv6 token %s' >&2\n" \
      "$IPV6_TOKEN" "$IPV6_TOKEN"
  fi
  cat <<'WRAPPER_EXEC'
if [ -n "$AS_UID" ]; then
  # Same groups as lxc.init.groups would have given: none beyond the primary
  # gid → clear them; otherwise set the list (util-linux setpriv only).
  if [ -z "$AS_GROUPS" ] || [ "$AS_GROUPS" = "$AS_GID" ]; then
    _grp="--clear-groups"
  else
    _grp="--groups=$AS_GROUPS"
  fi
  # With lxc.init.uid, LXC hands the console to the init user. We start as
  # root instead, so do the same before dropping: images log to /dev/stdout
  # and /dev/stderr (nginx: error.log -> /dev/stderr), and re-opening a tty
  # owned by root fails with EACCES for the app user.
  for _fd in 0 1 2; do
    _tty=$(readlink "/proc/self/fd/$_fd" 2>/dev/null)
    case "$_tty" in
      /dev/console|/dev/pts/*|/dev/tty*) chown "$AS_UID:$AS_GID" "$_tty" 2>/dev/null ;;
    esac
  done
  chown "$AS_UID:$AS_GID" /dev/console 2>/dev/null
  # Probe each tool with a no-op switch to uid 0 (we are root): busybox has a
  # setpriv applet that only handles capabilities, not --reuid.
  if setpriv --reuid=0 --regid=0 "$_grp" -- true >/dev/null 2>/dev/null; then
    exec setpriv --reuid="$AS_UID" --regid="$AS_GID" "$_grp" -- "$@"
  fi
  if su-exec 0:0 true >/dev/null 2>/dev/null; then
    exec su-exec "$AS_UID:$AS_GID" "$@"
  fi
  # su needs the user name; it sets supplementary groups from /etc/group.
  # -m keeps the container environment, -s overrides a nologin shell. The
  # `--` before the user is required: busybox su permutes options, so without
  # it the app's own flags (nginx -g ...) would be parsed as su options.
  _user=$(awk -F: -v u="$AS_UID" '$3 == u { print $1; exit }' /etc/passwd 2>/dev/null)
  if [ -n "$_user" ] && su -m -s /bin/sh -c true -- "$_user" >/dev/null 2>/dev/null; then
    exec su -m -s /bin/sh -c 'exec "$0" "$@"' -- "$_user" "$@"
  fi
  # Never fall back to running the app as root.
  echo "proxvex-init: cannot drop to uid $AS_UID (no usable setpriv/su-exec/su), refusing to run the app as root" >&2
  exit 1
fi
exec "$@"
WRAPPER_EXEC
} > "$TARGET"
chmod 0755 "$TARGET"

echo "Installed init wrapper /${WRAPPER_RELPATH}:" >&2
cat "$TARGET" >&2
echo '[{"id":"init_wrapper_installed","value":"true"}]'
