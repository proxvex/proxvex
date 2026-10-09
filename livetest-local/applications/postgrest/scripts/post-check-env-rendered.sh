#!/bin/sh
# TEST-ONLY check for livetest postgrest scenarios (execute_on: lxc).
# The overlay sets env_file to livetest.env.tpl, which carries a stack value
# (LIVETEST_ENV_PROBE set from the postgres stack password). After installation and after
# reconfigure the .env must be rendered: no template markers left, probe value set.
# Values are never printed.

ENV_FILE=/opt/docker-compose/postgrest/.env

fail() {
  echo "livetest: ERROR — $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "$ENV_FILE missing — env_file was not uploaded"
if grep -q '{{' "$ENV_FILE"; then
  fail "$ENV_FILE still contains placeholders: $(grep -o '^[A-Z_]*={{[^}]*}}' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ')"
fi
PROBE=$(sed -n 's/^LIVETEST_ENV_PROBE=//p' "$ENV_FILE")
case "$PROBE" in
  "") fail "LIVETEST_ENV_PROBE is empty in $ENV_FILE" ;;
  NOT_DEFINED) fail "LIVETEST_ENV_PROBE is NOT_DEFINED in $ENV_FILE" ;;
esac
echo "livetest: env file rendered, LIVETEST_ENV_PROBE set (${#PROBE} chars)" >&2
