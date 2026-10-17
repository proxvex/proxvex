# compose-ipv6.sh — give docker-compose networks IPv6 (library, functions only).
#
# Docker Engine 26 (Debian's docker.io in the debian-docker base image)
# ignores `default-network-opts` for enable_ipv6 — that only arrived with
# Engine 27.1. So every network a compose project creates would stay
# IPv4-only although dockerd itself runs with "ipv6": true. Instead of
# touching the app's compose file, write docker-compose.override.yml with
# `enable_ipv6: true` for each network of the project:
#   - Compose loads that file automatically wherever it is called without -f
#     (e.g. the ssl-proxy on-start hook),
#   - callers that pass -f add the args printed by compose_ipv6_args.
#
# Usage:
#   extra=$(compose_ipv6_args "$DC" "$COMPOSE_FILE")
#   $DC -f "$COMPOSE_FILE" $extra up -d
#
# Prints the extra compose args ("-f docker-compose.override.yml") or nothing.
# Must run inside the project directory. Logs to stderr only.

COMPOSE_IPV6_OVERRIDE="docker-compose.override.yml"
COMPOSE_IPV6_MARKER="# Written by proxvex (compose-ipv6.sh)"

# _compose_ipv6_networks <dc> <file> → lines "<key> <name> <external>"
_compose_ipv6_networks() {
  $1 -f "$2" config 2>/dev/null | awk '
    /^networks:/ { innet = 1; next }
    /^[^ ]/      { innet = 0 }
    innet && /^  [^ ][^:]*:/ {
      if (key != "") print key, (name != "" ? name : key), ext
      key = $1; sub(/:$/, "", key); name = ""; ext = "false"; next
    }
    innet && /^    name:/     { name = $2 }
    innet && /^    external:/ { ext = $2 }
    END { if (key != "") print key, (name != "" ? name : key), ext }'
}

compose_ipv6_args() {
  _dc="$1"
  _file="$2"

  # Only when dockerd runs with IPv6 (post-start-dockerd.sh, docker_ipv6).
  if ! grep -q '"ipv6": true' /etc/docker/daemon.json 2>/dev/null; then
    if [ -f "$COMPOSE_IPV6_OVERRIDE" ] && grep -q "$COMPOSE_IPV6_MARKER" "$COMPOSE_IPV6_OVERRIDE"; then
      rm -f "$COMPOSE_IPV6_OVERRIDE"
      echo "compose-ipv6: dockerd without IPv6 — removed $COMPOSE_IPV6_OVERRIDE" >&2
    fi
    return 0
  fi

  # Never overwrite an override the app ships itself.
  if [ -f "$COMPOSE_IPV6_OVERRIDE" ] && ! grep -q "$COMPOSE_IPV6_MARKER" "$COMPOSE_IPV6_OVERRIDE"; then
    echo "compose-ipv6: $COMPOSE_IPV6_OVERRIDE exists and is not ours — leaving it alone" >&2
    printf '%s' "-f $COMPOSE_IPV6_OVERRIDE"
    return 0
  fi

  _nets=$(_compose_ipv6_networks "$_dc" "$_file")
  if [ -z "$_nets" ]; then
    # No networks section: compose creates "<project>_default".
    _nets="default ${COMPOSE_PROJECT_NAME:-$(basename "$(pwd)")}_default false"
  fi

  # Networks that already exist keep their settings; compose refuses to
  # change enable_ipv6 on an existing network. An upgrade (down + up)
  # recreates them — until then leave everything as it is.
  _lb='{''{'
  _rb='}''}'
  _stale=""
  _keys=""
  while read -r _key _name _ext; do
    [ -n "$_key" ] || continue
    [ "$_ext" = "true" ] && continue
    _v6=$(docker network inspect -f "${_lb}.EnableIPv6${_rb}" "$_name" 2>/dev/null)
    if [ -n "$_v6" ] && [ "$_v6" != "true" ]; then
      _stale="$_stale $_name"
    fi
    _keys="$_keys $_key"
  done <<EOF
$_nets
EOF

  if [ -n "$_stale" ]; then
    echo "compose-ipv6: existing network(s) without IPv6:$_stale — not enabling IPv6 now (an upgrade recreates them)" >&2
    # Compose would auto-load a leftover override on calls without -f and
    # then refuse the existing network — so drop ours.
    if [ -f "$COMPOSE_IPV6_OVERRIDE" ] && grep -q "$COMPOSE_IPV6_MARKER" "$COMPOSE_IPV6_OVERRIDE"; then
      rm -f "$COMPOSE_IPV6_OVERRIDE"
    fi
    return 0
  fi
  [ -n "$_keys" ] || return 0

  {
    echo "$COMPOSE_IPV6_MARKER — IPv6 for every compose network (docker_ipv6)."
    echo "networks:"
    for _k in $_keys; do
      echo "  $_k:"
      echo "    enable_ipv6: true"
    done
  } > "$COMPOSE_IPV6_OVERRIDE"
  echo "compose-ipv6: IPv6 enabled for network(s):$_keys" >&2
  printf '%s' "-f $COMPOSE_IPV6_OVERRIDE"
}
