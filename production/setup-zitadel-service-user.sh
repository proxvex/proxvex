#!/bin/bash
# Create a Zitadel service user (machine user) with client credentials
# for CLI authentication against the oci-lxc-deployer backend.
#
# Prerequisites:
#   - Zitadel is running and accessible
#   - IAM_OWNER PAT is available (admin-client.pat from Zitadel bootstrap)
#
# Usage:
#   ./production/setup-zitadel-service-user.sh
#
# Output:
#   Writes OIDC credentials to production/.env (git-ignored)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Configuration ---
ZITADEL_HOST="zitadel"
ZITADEL_PORT="8080"
ZITADEL_URL="http://${ZITADEL_HOST}:${ZITADEL_PORT}"

SERVICE_USER_NAME="deployer-cli"
SERVICE_USER_DESCRIPTION="OCI LXC Deployer CLI service account"
PROJECT_NAME="oci-lxc-deployer"
REQUIRED_ROLE="admin"

# --- Configuration ---
PVE_HOST="pve1.cluster"
PORT_PVE_SSH=22
ZITADEL_VMID=502
SSH_CMD="ssh -o StrictHostKeyChecking=no -p $PORT_PVE_SSH root@$PVE_HOST"

# --- Load PAT ---
# Try multiple sources: env var → local file → read from Zitadel container
if [ -n "$ZITADEL_PAT" ]; then
    PAT="$ZITADEL_PAT"
    echo "PAT loaded from ZITADEL_PAT environment variable"
elif [ -f "${SCRIPT_DIR}/admin-client.pat" ]; then
    PAT=$(cat "${SCRIPT_DIR}/admin-client.pat")
    echo "PAT loaded from ${SCRIPT_DIR}/admin-client.pat"
else
    echo "Reading PAT from Zitadel container (VM $ZITADEL_VMID) via SSH..."
    PAT=$($SSH_CMD "pct exec $ZITADEL_VMID -- cat /zitadel/bootstrap/admin-client.pat" 2>/dev/null) || true
    if [ -z "$PAT" ]; then
        echo "ERROR: No PAT found."
        echo "  Options:"
        echo "    1. Zitadel container (VM $ZITADEL_VMID) must be running on $PVE_HOST"
        echo "    2. Place admin-client.pat in $SCRIPT_DIR/"
        echo "    3. Set ZITADEL_PAT environment variable"
        exit 1
    fi
    echo "PAT loaded from Zitadel container (VM $ZITADEL_VMID)"
fi

# --- Wait for Zitadel ---
echo "Waiting for Zitadel at ${ZITADEL_URL}..."
RETRIES=15
while [ $RETRIES -gt 0 ]; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${ZITADEL_URL}/debug/ready" 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
        echo "Zitadel is ready."
        break
    fi
    RETRIES=$((RETRIES - 1))
    echo "  Not ready (HTTP $STATUS), retrying... ($RETRIES left)"
    sleep 2
done
if [ $RETRIES -eq 0 ]; then
    echo "ERROR: Zitadel did not become ready at $ZITADEL_URL"
    exit 1
fi

# --- Helper: Zitadel API call ---
zitadel_api() {
    local method="$1"
    local path="$2"
    local body="$3"

    if [ -n "$body" ]; then
        curl -s -X "$method" \
            -H "Authorization: Bearer ${PAT}" \
            -H "Content-Type: application/json" \
            -d "$body" \
            "${ZITADEL_URL}${path}" 2>/dev/null
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer ${PAT}" \
            -H "Content-Type: application/json" \
            "${ZITADEL_URL}${path}" 2>/dev/null
    fi
}

# --- Step 1: Create or find machine user ---
echo ""
echo "=== Step 1: Create service user '${SERVICE_USER_NAME}' ==="

# Search for existing user
USER_SEARCH=$(zitadel_api POST "/v2/users" \
    "{\"query\":{\"offset\":\"0\",\"limit\":100},\"queries\":[{\"userNameQuery\":{\"userName\":\"${SERVICE_USER_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}" 2>/dev/null || true)

# Try v2 search endpoint
USER_ID=$(echo "$USER_SEARCH" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$USER_ID" ]; then
    echo "  User not found, creating..."
    CREATE_RESPONSE=$(zitadel_api POST "/v2/users/machine" \
        "{\"userName\":\"${SERVICE_USER_NAME}\",\"name\":\"${SERVICE_USER_DESCRIPTION}\",\"accessTokenType\":\"ACCESS_TOKEN_TYPE_JWT\"}")

    USER_ID=$(echo "$CREATE_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)

    if [ -z "$USER_ID" ]; then
        echo "  ERROR: Failed to create user"
        echo "  Response: $CREATE_RESPONSE"
        exit 1
    fi
    echo "  Created user '${SERVICE_USER_NAME}' with ID ${USER_ID}"
else
    echo "  Found existing user '${SERVICE_USER_NAME}' with ID ${USER_ID}"
fi

# --- Step 2: Generate client credentials (client_id + client_secret) ---
echo ""
echo "=== Step 2: Generate client credentials ==="

SECRET_RESPONSE=$(zitadel_api PUT "/v2/users/${USER_ID}/secret" "{}")

CLIENT_ID=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
CLIENT_SECRET=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
    echo "  ERROR: Failed to generate client credentials"
    echo "  Response: $SECRET_RESPONSE"
    exit 1
fi

echo "  Client ID:     ${CLIENT_ID}"
echo "  Client Secret:  ${CLIENT_SECRET:0:8}..."

# --- Step 3: Find or create project and grant role ---
echo ""
echo "=== Step 3: Ensure project '${PROJECT_NAME}' and role '${REQUIRED_ROLE}' ==="

PROJECT_SEARCH=$(zitadel_api POST "/management/v1/projects/_search" \
    "{\"queries\":[{\"nameQuery\":{\"name\":\"${PROJECT_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

PROJECT_ID=$(echo "$PROJECT_SEARCH" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$PROJECT_ID" ]; then
    echo "  Creating project '${PROJECT_NAME}'..."
    CREATE_PROJECT=$(zitadel_api POST "/management/v1/projects" \
        "{\"name\":\"${PROJECT_NAME}\",\"projectRoleAssertion\":true}")
    PROJECT_ID=$(echo "$CREATE_PROJECT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

    if [ -z "$PROJECT_ID" ]; then
        echo "  ERROR: Failed to create project"
        exit 1
    fi
    echo "  Created project with ID ${PROJECT_ID}"
else
    echo "  Found project with ID ${PROJECT_ID}"
fi

# Ensure role exists on project
echo "  Ensuring role '${REQUIRED_ROLE}' exists..."
zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles" \
    "{\"roleKey\":\"${REQUIRED_ROLE}\",\"displayName\":\"Admin Access\"}" >/dev/null 2>&1 || true

# Grant role to service user
echo "  Granting role '${REQUIRED_ROLE}' to user..."
zitadel_api POST "/management/v1/users/${USER_ID}/grants" \
    "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"${REQUIRED_ROLE}\"]}" >/dev/null 2>&1 || true

echo "  Role granted."

# --- Step 4: Write .env file ---
echo ""
echo "=== Step 4: Writing credentials to production/.env ==="

ENV_FILE="$SCRIPT_DIR/.env"
cat > "$ENV_FILE" <<EOF
# Zitadel OIDC credentials for CLI authentication
# Generated by setup-zitadel-service-user.sh on $(date -Iseconds)
OIDC_ISSUER_URL=${ZITADEL_URL}
OIDC_CLI_CLIENT_ID=${CLIENT_ID}
OIDC_CLI_CLIENT_SECRET=${CLIENT_SECRET}
EOF

echo "  Written to: $ENV_FILE"

echo ""
echo "=== Setup complete ==="
echo ""
echo "To use with deploy.sh, source the .env file:"
echo "  set -a; . $ENV_FILE; set +a"
echo "  ./production/deploy.sh all"
echo ""
echo "Or pass directly to CLI:"
echo "  oci-lxc-cli remote --server <url> --ve <host> \\"
echo "    --oidc-issuer ${ZITADEL_URL} \\"
echo "    --oidc-client-id ${CLIENT_ID} \\"
echo "    --oidc-client-secret <secret> \\"
echo "    parameters.json"
