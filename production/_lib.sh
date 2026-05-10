#!/bin/bash
# Shared helpers for production setup scripts.
#
# Sourced by setup-production.sh, deploy.sh, setup-ghcr-mirror.sh,
# setup-pve-host.sh. Provides:
#
#   read_zitadel_admin_pat [pve_host]
#       Read /bootstrap/admin-client.pat from the Zitadel LXC and emit it on
#       stdout (newlines stripped). Empty output if not available (Zitadel
#       not yet deployed, or hardening removed the file). Logs to stderr.
#       Auto-detects local-pct-vs-ssh based on whether `pct` is on PATH.
#
#   init_admin_pat [pve_host]
#       Idempotent: read the PAT once and export ZITADEL_ADMIN_PAT and
#       OCI_DEPLOYER_TOKEN. The latter is what oci-lxc-cli reads
#       (cli/src/oci-lxc-cli.mts:155 → CliApiClient bypasses the OIDC
#       client_credentials grant when a token is already set,
#       cli/src/cli-api-client.mts:104). Subsequent direct curl calls go
#       through auth_curl below.
#
#   auth_curl <curl-args>...
#       curl wrapper that injects "Authorization: Bearer $ZITADEL_ADMIN_PAT"
#       when the env var is non-empty. Falls back to plain curl otherwise.
#       Use for every call to https://${DEPLOYER_HOST}:3443/api/* that does
#       NOT go through the CLI.
#
# Why the admin PAT and not OIDC client_credentials? The PAT is created by
# Zitadel during FirstInstance init (ZITADEL_FIRSTINSTANCE_PATPATH in
# json/applications/zitadel/Zitadel.docker-compose.yml:44) and persists in
# /bootstrap/admin-client.pat. Same source already used by addon-oidc's
# json/shared/scripts/pre_start/conf-setup-oidc-client.sh:158 — single
# token, no second OIDC client to manage.

# Read /bootstrap/admin-client.pat from the Zitadel LXC. Resolves the LXC by
# hostname=zitadel; auto-picks the local pct path when running on a PVE host,
# or ssh otherwise.
read_zitadel_admin_pat() {
  local pve_host="${1:-${PVE_HOST:-pve1.cluster}}"
  local vmid pat
  # `|| true` guards against `set -e` killing callers when the remote
  # `cat` returns non-zero (file missing — which is a legitimate
  # "PAT not yet available" state, not an error).
  if command -v pct >/dev/null 2>&1; then
    vmid=$(pct list 2>/dev/null | awk '$NF=="zitadel"{print $1; exit}')
    [ -z "$vmid" ] && return 0
    pat=$(pct exec "$vmid" -- cat /bootstrap/admin-client.pat 2>/dev/null || true)
  else
    vmid=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct list 2>/dev/null | awk '\$NF==\"zitadel\"{print \$1; exit}'" 2>/dev/null || true)
    [ -z "$vmid" ] && return 0
    pat=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct exec ${vmid} -- cat /bootstrap/admin-client.pat 2>/dev/null" 2>/dev/null || true)
  fi
  printf '%s' "$pat" | tr -d '\r\n'
}

# Read the PAT once and export it as ZITADEL_ADMIN_PAT for direct Zitadel
# API calls. Re-runs are no-ops once ZITADEL_ADMIN_PAT is set.
#
# IMPORTANT: PATs are opaque (no dots, ~71 chars). The deployer's auth
# middleware does jwtVerify(token, jwks) and rejects opaque tokens with
# "Invalid Compact JWS" → HTTP 401 once OIDC enforcement is active. So we do
# NOT export PAT as OCI_DEPLOYER_TOKEN anymore — for deployer Bearer auth use
# init_oidc_jwt below, which fetches a real JWT via client_credentials grant.
init_admin_pat() {
  if [ -n "${ZITADEL_ADMIN_PAT:-}" ]; then
    return 0
  fi
  local pat
  pat=$(read_zitadel_admin_pat "$@")
  if [ -n "$pat" ]; then
    export ZITADEL_ADMIN_PAT="$pat"
    echo "  Zitadel admin PAT loaded (${#pat} chars) — using as Bearer for direct Zitadel API calls" >&2
  else
    echo "  Zitadel admin PAT not available (pre-Zitadel deploy or PAT removed by hardening)" >&2
  fi
}

# Obtain a JWS access token from Zitadel via the OIDC client_credentials
# grant and export it as OCI_DEPLOYER_TOKEN. This is what the deployer's
# jwtVerify auth middleware accepts (signed by Zitadel's JWKS, contains the
# 'admin' role claim from the deployer-cli machine user).
#
# Both the CLI (oci-lxc-cli reads OCI_DEPLOYER_TOKEN at oci-lxc-cli.mts:155
# and skips its own grant when set, see cli-api-client.mts:104) and
# auth_curl below pick this up. Idempotent: re-runs are no-ops once
# OCI_DEPLOYER_TOKEN is set.
#
# Pre-Zitadel-deploy deployer-oidc.json does not exist yet → init_oidc_creds
# logs a notice and returns; the function is a no-op so callers can run
# unconditionally before any deploy step.
init_oidc_jwt() {
  if [ -n "${OCI_DEPLOYER_TOKEN:-}" ]; then
    return 0
  fi
  init_oidc_creds "$@"
  if [ -z "${OIDC_ISSUER_URL:-}" ] || [ -z "${OIDC_CLI_CLIENT_ID:-}" ] || [ -z "${OIDC_CLI_CLIENT_SECRET:-}" ]; then
    return 0
  fi
  # Zitadel-specific scopes: project audience + roles. Without
  # urn:zitadel:iam:org:project:id:${PROJECT_ID}:aud the JWT is not bound to
  # the proxvex project and carries no role claims, so the deployer's role
  # check (webapp-auth-middleware.mts:70-93) rejects with HTTP 403.
  local scope="openid"
  if [ -n "${OIDC_PROJECT_ID:-}" ]; then
    scope="openid urn:zitadel:iam:org:project:id:${OIDC_PROJECT_ID}:aud urn:zitadel:iam:org:projects:roles"
  fi
  local response token
  response=$(curl -sk -X POST "${OIDC_ISSUER_URL}/oauth/v2/token" \
    -u "${OIDC_CLI_CLIENT_ID}:${OIDC_CLI_CLIENT_SECRET}" \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "scope=${scope}" 2>/dev/null)
  token=$(printf '%s' "$response" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin).get("access_token",""))
except Exception:
  pass' 2>/dev/null)
  if [ -z "$token" ]; then
    echo "  Failed to obtain OIDC JWT from Zitadel (response: $(printf '%s' "$response" | head -c 200))" >&2
    return 0
  fi
  export OCI_DEPLOYER_TOKEN="$token"
  echo "  OIDC JWT acquired via client_credentials grant (${#token} chars) — using as Bearer for deployer API + CLI" >&2
}

# curl wrapper that adds "Authorization: Bearer ..." for deployer API calls.
# Prefers OCI_DEPLOYER_TOKEN (JWS from client_credentials, accepted by
# deployer post-OIDC). Falls back to ZITADEL_ADMIN_PAT only if no JWT is
# available — that fallback is fine pre-OIDC (deployer auth middleware off,
# any Bearer header is ignored) but will fail post-OIDC with 401.
auth_curl() {
  if [ -n "${OCI_DEPLOYER_TOKEN:-}" ]; then
    curl -H "Authorization: Bearer ${OCI_DEPLOYER_TOKEN}" "$@"
  elif [ -n "${ZITADEL_ADMIN_PAT:-}" ]; then
    curl -H "Authorization: Bearer ${ZITADEL_ADMIN_PAT}" "$@"
  else
    curl "$@"
  fi
}

# Read /bootstrap/deployer-oidc.json from the Zitadel LXC and export the OIDC
# client_credentials env vars consumed by oci-lxc-cli.mts:158-160 — namely
# OIDC_ISSUER_URL, OIDC_CLI_CLIENT_ID, OIDC_CLI_CLIENT_SECRET. The CLI uses
# them to fetch a real Zitadel-signed JWT (cli-api-client.mts:102-134).
#
# Why not the admin PAT? Zitadel PATs are opaque (no dots) and the deployer's
# auth middleware does jwtVerify(token, jwks) — it requires JWS format, so a
# PAT as Bearer fails with "Invalid Compact JWS" → HTTP 401 once OIDC is
# enforced. The client_credentials grant returns a JWS that validates.
init_oidc_creds() {
  local pve_host="${1:-${PVE_HOST:-pve1.cluster}}"

  # Tier 1 — Deployer Stack API. Long-term primary path: zitadel template 340
  # publishes 4 `provides_DEPLOYER_OIDC_*` outputs that the backend persists
  # into the firstStackId of the zitadel install — which today happens to be
  # `postgres_<variant>`, not `oidc_<variant>`, because of the order in which
  # the install caller passes stack IDs. Templates resolve the values
  # transparently across all consumer stacks, but a workstation API caller
  # has to scan because the destination stack is order-dependent. So query
  # /api/stacks and pick the first stack that carries all 4 fields.
  local deployer_host="${DEPLOYER_HOST:-proxvex}"
  local deployer_port="${DEPLOYER_PORT:-3443}"
  local stack_list_url="https://${deployer_host}:${deployer_port}/api/stacks"
  local stacks_blob
  stacks_blob=$(curl -sk --connect-timeout 3 "$stack_list_url" 2>/dev/null || true)
  if [ -z "$stacks_blob" ]; then
    # Try HTTP fallback (cluster pre-HTTPS, or local livetest deployer on :3201).
    local http_port
    case "$deployer_port" in
      3443) http_port=3080 ;;
      *) http_port="$deployer_port" ;;
    esac
    stack_list_url="http://${deployer_host}:${http_port}/api/stacks"
    stacks_blob=$(curl -s --connect-timeout 3 "$stack_list_url" 2>/dev/null || true)
  fi
  if [ -n "$stacks_blob" ]; then
    # Single python invocation: scan all stacks, return the 4 values from
    # the first stack that has all of DEPLOYER_OIDC_MACHINE_CLIENT_ID +
    # _SECRET + _ISSUER_URL (PROJECT_ID is optional). Prints 4 lines
    # (issuer, client_id, client_secret, project_id) or empty.
    local creds_lines
    creds_lines=$(printf '%s' "$stacks_blob" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)
for s in d.get('stacks', []):
  pmap = {p.get('name'): p.get('value', '') for p in s.get('provides', [])}
  iss = pmap.get('DEPLOYER_OIDC_ISSUER_URL', '')
  cid = pmap.get('DEPLOYER_OIDC_MACHINE_CLIENT_ID', '')
  sec = pmap.get('DEPLOYER_OIDC_MACHINE_CLIENT_SECRET', '')
  pid = pmap.get('DEPLOYER_OIDC_PROJECT_ID', '')
  if iss and cid and sec:
    print(iss); print(cid); print(sec); print(pid); break
" 2>/dev/null)
    if [ -n "$creds_lines" ]; then
      local s_issuer s_client_id s_client_secret s_project_id
      s_issuer=$(echo "$creds_lines" | sed -n '1p')
      s_client_id=$(echo "$creds_lines" | sed -n '2p')
      s_client_secret=$(echo "$creds_lines" | sed -n '3p')
      s_project_id=$(echo "$creds_lines" | sed -n '4p')
      export OIDC_ISSUER_URL="$s_issuer"
      export OIDC_CLI_CLIENT_ID="$s_client_id"
      export OIDC_CLI_CLIENT_SECRET="$s_client_secret"
      export OIDC_PROJECT_ID="$s_project_id"
      echo "  OIDC machine credentials loaded from deployer stack-API ${stack_list_url} (machine_client_id=${s_client_id})" >&2
      return 0
    fi
  fi

  # Tier 2 — File fallback on the Zitadel LXC. Used during initial bootstrap
  # before the deployer is reachable, or for clusters predating the stack-publish
  # change. `|| true` defends against `set -e` killing the caller when the remote
  # `cat` exits non-zero (file missing — a legitimate "creds not yet available").
  local vmid blob
  if command -v pct >/dev/null 2>&1; then
    vmid=$(pct list 2>/dev/null | awk '$NF=="zitadel"{print $1; exit}')
    [ -z "$vmid" ] && return 0
    blob=$(pct exec "$vmid" -- cat /bootstrap/deployer-oidc.json 2>/dev/null || true)
  else
    vmid=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct list 2>/dev/null | awk '\$NF==\"zitadel\"{print \$1; exit}'" 2>/dev/null || true)
    [ -z "$vmid" ] && return 0
    blob=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct exec ${vmid} -- cat /bootstrap/deployer-oidc.json 2>/dev/null" 2>/dev/null || true)
  fi
  if [ -z "$blob" ]; then
    echo "  deployer-oidc.json not available on ${pve_host} and stack ${stack_url} empty — proceeding without OIDC creds" >&2
    return 0
  fi
  # Read machine_client_id/secret — these are the credentials for the
  # "deployer-cli" machine user that supports client_credentials. The
  # client_id/client_secret fields are for the Web app (auth_code flow,
  # browser login) and would fail client_credentials with "client not found".
  # project_id is needed below for the Zitadel-specific audience scope —
  # without it the JWT carries no role claims and the deployer's role check
  # rejects the call with HTTP 403.
  local issuer client_id client_secret project_id
  issuer=$(printf '%s' "$blob" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("issuer_url",""))' 2>/dev/null)
  client_id=$(printf '%s' "$blob" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("machine_client_id",""))' 2>/dev/null)
  client_secret=$(printf '%s' "$blob" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("machine_client_secret",""))' 2>/dev/null)
  project_id=$(printf '%s' "$blob" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("project_id",""))' 2>/dev/null)
  if [ -z "$issuer" ] || [ -z "$client_id" ] || [ -z "$client_secret" ]; then
    echo "  deployer-oidc.json is missing machine_client_* fields — Zitadel" >&2
    echo "  bootstrap (post-setup-deployer-in-zitadel.sh) was not re-run after" >&2
    echo "  the machine-user fix. Re-deploy Zitadel to provision 'deployer-cli'." >&2
    return 0
  fi
  export OIDC_ISSUER_URL="$issuer"
  export OIDC_CLI_CLIENT_ID="$client_id"
  export OIDC_CLI_CLIENT_SECRET="$client_secret"
  export OIDC_PROJECT_ID="$project_id"
  echo "  OIDC machine credentials loaded from Zitadel deployer-oidc.json file fallback (machine_client_id=${client_id})" >&2
}

# Make a Zitadel-Management-API PAT available to subsequent deploy scripts as
# OCI_DEPLOYER_PAT. Looked-up sources, in order:
#   1. Already-set env (no-op if OCI_DEPLOYER_PAT is non-empty)
#   2. production/.env file next to setup-production.sh (gitignored)
#
# When set, deploy.sh injects the value as a `ZITADEL_PAT` entry into the
# CLI's params.json before forwarding — so the headless flow uses an
# operator-issued PAT for deployer-cli (or any service user with the right
# org permissions) instead of the cluster-wide /bootstrap/admin-client.pat.
# Templates that read `{{ ZITADEL_PAT }}` (conf-setup-oidc-client.sh,
# conf-bootstrap-zitadel-project.sh) pick this up automatically; if neither
# this nor the env was set, they fall back to the on-LXC admin PAT — the
# pre-existing behaviour, unchanged.
init_deployer_pat() {
  if [ -n "${OCI_DEPLOYER_PAT:-}" ]; then
    return 0
  fi
  if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +a
  fi
  if [ -n "${OCI_DEPLOYER_PAT:-}" ]; then
    echo "  Deployer PAT loaded from production/.env (${#OCI_DEPLOYER_PAT} chars) — will be passed as ZITADEL_PAT param" >&2
  else
    echo "  OCI_DEPLOYER_PAT not set — Zitadel-API calls will fall back to /bootstrap/admin-client.pat on the LXC" >&2
  fi
}
