#!/bin/sh
# Verify end-to-end OIDC machine login flow.
#
# Template variables:
#   vm_id             - Deployer container VM ID
#   dep_zitadel_vm_id - Zitadel dependency VM ID
#
# Steps:
#   1. Read test credentials from Zitadel container (/bootstrap/test-oidc.json)
#   2. Get Zitadel container IP and hostname for API calls
#   3. Obtain JWT via client_credentials grant
#   4. Call deployer API with JWT and verify it succeeds
#
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"
ZITADEL_VM_ID="{{ dep_zitadel_vm_id }}"

if [ -z "$ZITADEL_VM_ID" ] || [ "$ZITADEL_VM_ID" = "NOT_DEFINED" ]; then
    echo "CHECK: oidc_machine_login SKIPPED (no Zitadel VM ID)" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"skipped"}]'
    exit 0
fi

# --- 1. Read test credentials from Zitadel container ---
CRED_JSON=$(pct exec "$ZITADEL_VM_ID" -- cat /bootstrap/test-oidc.json 2>/dev/null)
if [ -z "$CRED_JSON" ]; then
    echo "CHECK: oidc_machine_login FAILED (no test-oidc.json on Zitadel VM ${ZITADEL_VM_ID})" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"no credentials"}]'
    exit 1
fi

CLIENT_ID=$(echo "$CRED_JSON" | sed -n 's/.*"machine_client_id": *"\([^"]*\)".*/\1/p')
CLIENT_SECRET=$(echo "$CRED_JSON" | sed -n 's/.*"machine_client_secret": *"\([^"]*\)".*/\1/p')
PROJECT_ID=$(echo "$CRED_JSON" | sed -n 's/.*"project_id": *"\([^"]*\)".*/\1/p')

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
    echo "CHECK: oidc_machine_login FAILED (missing client_id or client_secret in test-oidc.json)" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"missing credentials"}]'
    exit 1
fi
echo "CHECK: oidc_machine_login credentials loaded (client_id=${CLIENT_ID})" >&2

# --- 2. Get Zitadel IP and hostname ---
ZITADEL_IP=$(pct exec "$ZITADEL_VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
ZITADEL_HOSTNAME=$(pct exec "$ZITADEL_VM_ID" -- hostname 2>/dev/null | tr -d '\r\n')

if [ -z "$ZITADEL_IP" ]; then
    echo "CHECK: oidc_machine_login FAILED (cannot determine Zitadel IP)" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"no Zitadel IP"}]'
    exit 1
fi

ISSUER_URL="http://${ZITADEL_IP}:8080"

# --- 3. Obtain JWT via client_credentials grant ---
PROJECT_AUD_SCOPE="urn:zitadel:iam:org:project:id:${PROJECT_ID}:aud"
ROLES_SCOPE="urn:zitadel:iam:org:projects:roles"

TOKEN_RESPONSE=$(curl -sf \
    -H "Host: ${ZITADEL_HOSTNAME}:8080" \
    -X POST \
    -u "${CLIENT_ID}:${CLIENT_SECRET}" \
    -d "grant_type=client_credentials&scope=openid+${PROJECT_AUD_SCOPE}+${ROLES_SCOPE}" \
    "${ISSUER_URL}/oauth/v2/token" 2>/dev/null)

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

if [ -z "$ACCESS_TOKEN" ]; then
    echo "CHECK: oidc_machine_login FAILED (cannot obtain JWT)" >&2
    echo "Token response: ${TOKEN_RESPONSE}" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"no token"}]'
    exit 1
fi
echo "CHECK: oidc_machine_login JWT obtained" >&2

# --- 4. Call deployer API with JWT ---
DEPLOYER_IP=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
if [ -z "$DEPLOYER_IP" ]; then
    echo "CHECK: oidc_machine_login FAILED (cannot determine deployer IP)" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"no deployer IP"}]'
    exit 1
fi

API_RESPONSE=$(curl -sf \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    --connect-timeout 5 \
    "http://${DEPLOYER_IP}:3080/api/applications" 2>/dev/null)

# Check if response is a JSON array (valid API response)
if echo "$API_RESPONSE" | grep -q '^\['; then
    echo "CHECK: oidc_machine_login PASSED (API call with JWT succeeded)" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"ok"}]'
else
    echo "CHECK: oidc_machine_login FAILED (API response: ${API_RESPONSE})" >&2
    printf '[{"id":"check_oidc_machine_login_result","value":"api call failed"}]'
    exit 1
fi
