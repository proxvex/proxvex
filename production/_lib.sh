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
  if command -v pct >/dev/null 2>&1; then
    vmid=$(pct list 2>/dev/null | awk '$NF=="zitadel"{print $1; exit}')
    [ -z "$vmid" ] && return 0
    pat=$(pct exec "$vmid" -- cat /bootstrap/admin-client.pat 2>/dev/null)
  else
    vmid=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct list 2>/dev/null | awk '\$NF==\"zitadel\"{print \$1; exit}'" 2>/dev/null)
    [ -z "$vmid" ] && return 0
    pat=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct exec ${vmid} -- cat /bootstrap/admin-client.pat 2>/dev/null" 2>/dev/null)
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
  local vmid blob
  if command -v pct >/dev/null 2>&1; then
    vmid=$(pct list 2>/dev/null | awk '$NF=="zitadel"{print $1; exit}')
    [ -z "$vmid" ] && return 0
    blob=$(pct exec "$vmid" -- cat /bootstrap/deployer-oidc.json 2>/dev/null)
  else
    vmid=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct list 2>/dev/null | awk '\$NF==\"zitadel\"{print \$1; exit}'" 2>/dev/null)
    [ -z "$vmid" ] && return 0
    blob=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${pve_host}" \
      "pct exec ${vmid} -- cat /bootstrap/deployer-oidc.json 2>/dev/null" 2>/dev/null)
  fi
  if [ -z "$blob" ]; then
    echo "  deployer-oidc.json not available on ${pve_host} — proceeding without OIDC creds" >&2
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
  echo "  OIDC machine credentials loaded from Zitadel deployer-oidc.json (machine_client_id=${client_id})" >&2
}
