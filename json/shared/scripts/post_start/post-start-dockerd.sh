#!/bin/sh
# Start dockerd in the background.
#
# The pre-baked debian-docker base image (oci/debian-docker/Dockerfile)
# ships docker.io + docker-cli but no init system — debian:trixie-slim
# is too minimal for systemd, and OCI-derived LXC rootfs aren't designed
# to run an init anyway. So we launch dockerd directly via nohup.
#
# THIS IS THE ONLY DOCKERD STARTER. Its template (307-post-start-dockerd.json)
# runs with `execute_on: "hook"`, which deploys this very file into
# /etc/proxvex/on_start.d/ *and* runs it once right away. One script therefore
# covers both moments: the deploy (install/upgrade/reconfigure) and every later
# container start, including after a host reboot. Until 2026-10 a second,
# near-identical copy of this logic was generated host-side by
# conf-write-dockerd-on-start.sh via a two-part heredoc — 54 of its 55 code
# lines were word-identical with this file, which is exactly how two copies
# start to drift.
#
# Idempotent: a second run notices dockerd already on its socket and
# exits 0, so post_start replays after rollback don't double-start.

set -eu

LOG_FILE="/var/log/dockerd.log"

# Retire the legacy drop-in written by conf-write-dockerd-on-start.sh (removed
# 2026-10). /etc/proxvex is a persistent volume, so that file survives the
# switch — and it sorts BEFORE this hook, so on the next container start it
# would run first, launch dockerd with the old copy of this logic, and leave
# this script reporting "already responsive". The fix below would then be
# silently inert. Remove it before doing anything else.
LEGACY_HOOK="/etc/proxvex/on_start.d/50-start-dockerd.sh"
if [ -e "$LEGACY_HOOK" ]; then
  rm -f "$LEGACY_HOOK"
  echo "removed legacy dockerd hook: ${LEGACY_HOOK}" >&2
fi

if docker info >/dev/null 2>&1; then
  echo "dockerd already responsive — skipping start" >&2
  exit 0
fi

if [ ! -x /usr/sbin/dockerd ]; then
  echo "Error: /usr/sbin/dockerd missing — base image is broken" >&2
  exit 1
fi

# Clean up stale runtime state from a cloned or restored rootfs.
# `pct clone --full` from a running source captures /var/run/docker.{pid,sock}
# and /run/docker/containerd/{containerd.pid,*.sock} as-is. In the new
# container's PID namespace, the recorded PIDs either do not exist OR
# (worse) map to unrelated processes — dockerd then either refuses to
# start with:
#   failed to start daemon, ensure docker is not running or delete
#   /var/run/docker.pid: process with PID N is still running
# or boots fine but times out talking to its embedded containerd:
#   containerd is still running module=libcontainerd pid=N
#   failed to start containerd: timeout waiting for containerd to start
# This bites every reconfigure (template 100-create-ct-clone) and every
# upgrade pipeline that does the same. We've already established above
# that no dockerd is actually responsive, so any pid/sock files here are
# stale by definition — safe to remove. The same cleanup runs again before
# every restart below, because a dead attempt leaves its own files behind.
clear_stale_runtime() {
  rm -f /var/run/docker.pid /var/run/docker.sock
  rm -f /run/docker/containerd/containerd.pid \
        /run/docker/containerd/containerd.sock \
        /run/docker/containerd/containerd.sock.ttrpc \
        /run/docker/containerd/containerd-debug.sock
}
clear_stale_runtime

# Project-level registry mirrors. Both come from project defaults
# (json/shared/templates/create_ct/050-set-project-parameters.json) and
# may be empty.
#
# - docker_registry_mirror: URL like https://docker-registry-mirror.
#   Goes into /etc/docker/daemon.json as `registry-mirrors`. Docker's
#   built-in Docker Hub mirror mechanism — falls back to docker.io
#   automatically if the mirror is unreachable.
#
# - ghcr_registry_mirror: URL like https://zot-mirror. Docker has no
#   per-registry mirror switch for ghcr.io, so we redirect at the host
#   level: hostname is resolved via DNS, the resulting IP is written
#   to /etc/hosts as `<ip> ghcr.io`. The mirror's TLS cert must include
#   `DNS:ghcr.io` in its SAN (proxvex zot-mirror app does this).
DOCKER_REGISTRY_MIRROR="{{ docker_registry_mirror }}"
GHCR_REGISTRY_MIRROR="{{ ghcr_registry_mirror }}"
[ "$DOCKER_REGISTRY_MIRROR" = "NOT_DEFINED" ] && DOCKER_REGISTRY_MIRROR=""
[ "$GHCR_REGISTRY_MIRROR" = "NOT_DEFINED" ] && GHCR_REGISTRY_MIRROR=""

# IPv6 for Docker. Only when the LXC itself has IPv6 (SLAAC from the router)
# and docker_ipv6 is not switched off. ULAs inside Docker; ip6tables NATs
# them out of the LXC's address (NAT66) and DNATs published ports, like IPv4.
DOCKER_IPV6="{{ docker_ipv6 }}"
case "$DOCKER_IPV6" in false|0|no) DOCKER_IPV6=false ;; *) DOCKER_IPV6=true ;; esac

# Size of each compose network carved from the IPv4 pool 172.16.0.0/12.
# The default /16 gives 16 networks per LXC — enough for one compose project,
# not for a host that runs several (heimvio: dev stack, e2e base and four e2e
# lanes with two networks each ran out on 2026-10-26; dockerd then reports
# "could not find an available, non-overlapping IPv6 address pool", although
# it is the IPv4 pool that is empty). /24 gives 4096 networks of 254
# addresses. Only new networks are affected; existing ones keep their subnet.
DOCKER_POOL_SIZE="{{ docker_address_pool_size }}"
case "$DOCKER_POOL_SIZE" in
  1[6-9]|2[0-8]) : ;;
  *) DOCKER_POOL_SIZE=16 ;;
esac
if [ "$DOCKER_IPV6" = "true" ] && ! grep -q . /proc/net/if_inet6 2>/dev/null; then
  echo "LXC has no IPv6 — Docker IPv6 not enabled" >&2
  DOCKER_IPV6=false
fi
if [ "$DOCKER_IPV6" = "true" ]; then
  # dockerd sets net.ipv6.conf.all.forwarding=1, and with forwarding the
  # kernel ignores router advertisements unless accept_ra=2 — the LXC would
  # lose its own IPv6 address and default route. Every interface, not only
  # eth0: a multi-NIC LXC (net1 in a second VLAN) lost its SLAAC address on
  # eth1 that way (heimvio-yellow, 24.10.2026). The address returns with the
  # router's next periodic advertisement.
  # Also `default` and `all`: an interface that appears AFTER this hook ran —
  # the host re-plugs net1 (host-managed) during install/reconfigure — gets
  # the kernel default accept_ra=1 and loses its SLAAC addresses when their
  # lifetime ends. Seen on heimvio-e2e (04.11.2026): eth1 was reset to 1 after
  # the hook, the global addresses expired hours later, and every removal was
  # a network change that aborted Chromium page loads (ERR_NETWORK_CHANGED)
  # in the e2e suite.
  for ifc in all default; do
    echo 2 > "/proc/sys/net/ipv6/conf/$ifc/accept_ra" 2>/dev/null \
      || echo "Warning: cannot set accept_ra=2 on $ifc" >&2
  done
  for ifc in /sys/class/net/eth*; do
    [ -e "$ifc" ] || continue
    ifc=${ifc##*/}
    echo 2 > "/proc/sys/net/ipv6/conf/$ifc/accept_ra" 2>/dev/null \
      || echo "Warning: cannot set accept_ra=2 on $ifc — SLAAC may be lost" >&2
  done
fi

mkdir -p /etc/docker

  # Build daemon.json with explicit DNS upstreams. Without `dns`, dockerd
  # captures the LXC's /etc/resolv.conf at start time and exposes it via the
  # embedded DNS resolver at 127.0.0.11. That forwarding is fragile in nested
# LXC-Docker setups: when the upstream resolver (OpenWrt dnsmasq) takes a
# moment to answer, or when the LXC's resolv.conf is rewritten by an init
# system, containers begin failing with "lookup <host> on 127.0.0.11:53:
# no such host" until dockerd restarts. Pinning DNS in daemon.json makes
# the forwarding deterministic.
#
# Strategy: take every non-loopback nameserver from the LXC's
# /etc/resolv.conf (loopbacks like 127.0.0.53 are systemd-resolved stubs,
# unreachable from a docker container's network namespace). Always
# rewrite daemon.json so the fix lands on existing containers on next
# replay (the file is content-deterministic from template vars +
# resolv.conf, so re-writing is idempotent).
DNS_LIST=""
if [ -r /etc/resolv.conf ]; then
  for ns in $(awk '/^nameserver / {print $2}' /etc/resolv.conf); do
    case "$ns" in
      127.*|::1) continue ;;
    esac
    if [ -z "$DNS_LIST" ]; then
      DNS_LIST="\"$ns\""
    else
      DNS_LIST="$DNS_LIST, \"$ns\""
    fi
  done
fi

# Compose daemon.json. registry-mirrors only when the project param is set;
# dns only when a usable upstream was found.
{
  printf '{\n'
  printf '  "storage-driver": "overlay2",\n'
  printf '  "userland-proxy": false'
  if [ -n "$DOCKER_REGISTRY_MIRROR" ]; then
    printf ',\n  "registry-mirrors": ["%s"]' "$DOCKER_REGISTRY_MIRROR"
  fi
  if [ -n "$DNS_LIST" ]; then
    printf ',\n  "dns": [%s]' "$DNS_LIST"
  fi
  if [ "$DOCKER_IPV6" = "true" ]; then
    # ip6tables is still experimental in Docker 26 (GA in 27). The address
    # pools keep Docker's IPv4 default range and add a ULA /48 carved into
    # /64s; default-network-opts gives every compose network IPv6 without
    # touching the compose files.
    printf ',\n  "ipv6": true'
    printf ',\n  "fixed-cidr-v6": "fd00:d0c::/64"'
    printf ',\n  "experimental": true'
    printf ',\n  "ip6tables": true'
    printf ',\n  "default-address-pools": [{"base": "172.17.0.0/12", "size": %s}, {"base": "fd00:d0c:1::/48", "size": 64}]' "$DOCKER_POOL_SIZE"
    printf ',\n  "default-network-opts": {"bridge": {"com.docker.network.enable_ipv6": "true"}}'
  elif [ "$DOCKER_POOL_SIZE" != 16 ]; then
    # Without IPv6 dockerd keeps its built-in pools unless one is given; only
    # a non-default size writes the IPv4 pool, so the default stays byte-equal.
    printf ',\n  "default-address-pools": [{"base": "172.17.0.0/12", "size": %s}]' "$DOCKER_POOL_SIZE"
  fi
  printf '\n}\n'
} > /etc/docker/daemon.json

[ -n "$DOCKER_REGISTRY_MIRROR" ] && echo "daemon.json: registry-mirrors -> ${DOCKER_REGISTRY_MIRROR}" >&2
[ -n "$DNS_LIST" ] && echo "daemon.json: dns -> [${DNS_LIST}]" >&2
[ "$DOCKER_IPV6" = "true" ] && echo "daemon.json: IPv6 on (fd00:d0c::/64, pools fd00:d0c:1::/48, ip6tables)" >&2
[ "$DOCKER_POOL_SIZE" != 16 ] && echo "daemon.json: IPv4 pool 172.17.0.0/12 in /${DOCKER_POOL_SIZE} networks" >&2

# /etc/hosts redirect for ghcr.io. Idempotent: the marker line lets
# re-runs detect prior install and skip without double-adding. If the
# hostname can't be resolved (mirror not deployed yet), log a warning
# but don't fail dockerd startup — the daemon still boots, just without
# the redirect.
GHCR_HOSTS_MARKER="# proxvex: ghcr mirror"
if [ -n "$GHCR_REGISTRY_MIRROR" ] && ! grep -q "$GHCR_HOSTS_MARKER" /etc/hosts 2>/dev/null; then
  ghcr_mirror_host=$(echo "$GHCR_REGISTRY_MIRROR" | sed -E 's|^https?://||;s|/.*||;s|:.*||')
  ghcr_mirror_ip=$(getent hosts "$ghcr_mirror_host" 2>/dev/null | awk '{print $1; exit}')
  if [ -n "$ghcr_mirror_ip" ]; then
    echo "${ghcr_mirror_ip} ghcr.io  ${GHCR_HOSTS_MARKER}" >> /etc/hosts
    echo "/etc/hosts: ghcr.io -> ${ghcr_mirror_ip} (${ghcr_mirror_host})" >&2
  else
    echo "WARN: ghcr_registry_mirror=$GHCR_REGISTRY_MIRROR but $ghcr_mirror_host is not resolvable — skipping /etc/hosts redirect" >&2
  fi
fi


# Launch dockerd, then WATCH IT until it answers — and start it again whenever
# it dies on the way.
#
# Fire-and-forget is not enough, and the failure is a real one (ubuntupve,
# 2026-10-02): a host reboot started eight containers at once, dockerd's
# embedded containerd needed 8.99 s to boot in one of them, dockerd's internal
# wait expired first and the daemon exited:
#
#   containerd successfully booted in 8.994800s
#   failed to start containerd: timeout waiting for containerd to start
#
# Nothing retried, so two of four containers came up with no Docker at all and
# stayed that way until someone noticed. The containers themselves were fine —
# their restart policies brought all 20 back the moment dockerd ran — so
# dockerd is the only part that needs to be robust here.
#
# That timeout (~15 s) lives inside dockerd and is not exposed in daemon.json,
# so the lever is restarting rather than waiting longer. The first version of
# this block waited a blind 60 s and retried ONCE, assuming contention passes
# quickly (measured minutes later: containerd up in 18 ms). On 2026-10-24 that
# was not enough: after a host reboot six containers started at load 9+, and
# in one of them dockerd died twice in a row (start 04:14:33, dead after 16 s;
# the blind wait idled on until 04:15:47; the retry died after 15 s again) and
# the hook gave up — while a manual start at 04:23 booted containerd in 0.5 s.
# In another container the single retry happened to succeed, but dockerd then
# needed 3 min 40 s until its API answered.
#
# So instead of counting attempts we watch the process:
#   - poll `docker info` every 2 s;
#   - if the dockerd we started has exited, clear the stale pid/sock files and
#     start it again after a growing pause (5, 10, 20, 40, then 60 s) — the
#     pause lets the host's start storm drain instead of joining it;
#   - no restart is begun after DOCKERD_START_BUDGET seconds (default 300);
#   - a dockerd that is still ALIVE is never killed: it may just be slow to
#     initialise under load, so it gets up to DOCKERD_ALIVE_MAX seconds
#     (default 600) in total before the hook reports failure.
# A progress line goes out every 30 s, because the deployer runs this hook
# with an idle timeout (2 min of silence) when it triggers it at deploy time.
#
# nohup + setsid so dockerd survives the SSH/pct exec session that launched it.
# stdout/stderr → log file; stdin → /dev/null. PID is reaped by the LXC's PID 1.
#
# Surviving the session is not enough — dockerd must not INHERIT it either.
# `pct exec` passes the caller's environment through, and an ssh login on the
# host carries XDG_RUNTIME_DIR=/run/user/0. dockerd hands it to containerd and
# runc, and runc puts its exec state files there. The LXC has no logind, so
# /run/user/0 never exists, and from then on EVERY `docker exec` fails with
#   OCI runtime exec failed: open /run/user/0/runc-process…: no such file
# while `docker ps`, `up` and the running containers look perfectly healthy
# (found 2026-10-02 in heimvio-green: dockerd and containerd both carried
# XDG_SESSION_ID=18 from the session that had restarted them). Drop the
# session variables so a start from a login shell equals a start at boot.
DOCKERD_START_BUDGET="${DOCKERD_START_BUDGET:-300}"
DOCKERD_ALIVE_MAX="${DOCKERD_ALIVE_MAX:-600}"
DOCKERD_BIN="${DOCKERD_BIN:-/usr/sbin/dockerd}"
DOCKERD_PID=""

# `cmd &` in a non-interactive shell runs without job control, so the child is
# not a process-group leader: setsid and env exec in place and $! is dockerd's
# own PID.
start_dockerd() {
  nohup setsid env -u XDG_RUNTIME_DIR -u XDG_SESSION_ID -u XDG_SESSION_TYPE \
    -u XDG_SESSION_CLASS "$DOCKERD_BIN" \
    >> "$LOG_FILE" 2>&1 < /dev/null &
  DOCKERD_PID=$!
  echo "dockerd started as PID ${DOCKERD_PID} (logs at ${LOG_FILE})" >&2
}

# True while the process exists and is not a zombie. `kill -0` alone is not
# enough: the dead dockerd is our child, and until this shell reaps it the
# zombie still answers kill -0.
pid_alive() {
  [ -n "$1" ] || return 1
  state=$(sed -n 's/^State:[[:space:]]*\([A-Z]\).*/\1/p' "/proc/$1/status" 2>/dev/null || true)
  case "$state" in
    ""|Z|X) return 1 ;;
    *) return 0 ;;
  esac
}

# Elapsed time comes from the clock, not from counting sleeps: under load a
# single `docker info` against a half-started daemon can itself take seconds.
started_at=$(date +%s)
elapsed=0
attempt=1
pause=5
next_progress=30
start_dockerd
while :; do
  elapsed=$(( $(date +%s) - started_at ))
  if docker info >/dev/null 2>&1; then
    if [ "$attempt" -gt 1 ]; then
      echo "dockerd responsive after ${elapsed}s (attempt ${attempt})" >&2
    else
      echo "dockerd responsive after ${elapsed}s" >&2
    fi
    exit 0
  fi

  if ! pid_alive "$DOCKERD_PID"; then
    echo "WARN: dockerd (PID ${DOCKERD_PID}, attempt ${attempt}) exited after ${elapsed}s without answering" >&2
    tail -n 5 "$LOG_FILE" >&2 || true
    if [ $((elapsed + pause)) -gt "$DOCKERD_START_BUDGET" ]; then
      break
    fi
    echo "restarting dockerd in ${pause}s" >&2
    sleep "$pause"
    # Stale pid/sock files from the dead attempt would make the restart refuse
    # to start ("process with PID N is still running"), so clear them again.
    clear_stale_runtime
    attempt=$((attempt + 1))
    start_dockerd
    pause=$((pause * 2))
    if [ "$pause" -gt 60 ]; then
      pause=60
    fi
    next_progress=$(( $(date +%s) - started_at + 30 ))
    continue
  fi

  if [ "$elapsed" -ge "$DOCKERD_ALIVE_MAX" ]; then
    echo "Error: dockerd (PID ${DOCKERD_PID}) alive but not responsive after ${elapsed}s — leaving it running" >&2
    break
  fi
  if [ "$elapsed" -ge "$next_progress" ]; then
    echo "waiting for dockerd (PID ${DOCKERD_PID}, attempt ${attempt}, ${elapsed}s)" >&2
    next_progress=$((elapsed + 30))
  fi
  sleep 2
done

# Exit non-zero so the on-start dispatcher reports ===OCI_HOOK_ERROR=== and
# 350-host-check-hook-log.json sees it. A container silently running without
# Docker is the outcome this whole block exists to prevent.
echo "Error: dockerd not responsive after ${attempt} attempt(s) in ${elapsed}s" >&2
tail -n 20 "$LOG_FILE" >&2 || true
exit 1
