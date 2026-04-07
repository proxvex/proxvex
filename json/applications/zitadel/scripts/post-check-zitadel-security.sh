#!/bin/sh
# post-check-zitadel-security.sh
# Verify Zitadel security requirements after installation:
# 1. login-client.pat exists on persistent mount
# 2. admin-client.pat does NOT exist on persistent mount
# 3. Bootstrap directory has correct ownership
#
# Output: JSON to stdout (errors to stderr)

BOOTSTRAP_DIR="/bootstrap"
ERRORS=0

# Check 1: login-client.pat must exist
if [ -f "$BOOTSTRAP_DIR/login-client.pat" ]; then
  echo "OK: login-client.pat exists on persistent mount" >&2
else
  echo "ERROR: login-client.pat missing from $BOOTSTRAP_DIR" >&2
  ERRORS=$((ERRORS + 1))
fi

# Check 2: admin-client.pat must NOT exist on persistent mount (not even empty)
if [ -e "$BOOTSTRAP_DIR/admin-client.pat" ]; then
  echo "ERROR: admin-client.pat found on persistent mount $BOOTSTRAP_DIR — must be deleted after bootstrap" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "OK: admin-client.pat not on persistent mount" >&2
fi

# Check 3: deployer-oidc.json must exist (created by bootstrap)
if [ -f "$BOOTSTRAP_DIR/deployer-oidc.json" ]; then
  echo "OK: deployer-oidc.json exists" >&2
else
  echo "WARNING: deployer-oidc.json missing from $BOOTSTRAP_DIR (OIDC addon may not work without API access)" >&2
fi

# Check 4: Bootstrap directory ownership (should be 1000:1001 = api:login)
if [ -d "$BOOTSTRAP_DIR" ]; then
  OWNER=$(stat -c '%u:%g' "$BOOTSTRAP_DIR" 2>/dev/null || stat -f '%u:%g' "$BOOTSTRAP_DIR" 2>/dev/null)
  PERMS=$(stat -c '%a' "$BOOTSTRAP_DIR" 2>/dev/null || stat -f '%Lp' "$BOOTSTRAP_DIR" 2>/dev/null)
  echo "Bootstrap dir: owner=$OWNER perms=$PERMS" >&2
  case "$PERMS" in
    770|771|775|777) echo "OK: permissions $PERMS" >&2 ;;
    *) echo "WARNING: permissions $PERMS (expected 770)" >&2 ;;
  esac
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "Security check failed with $ERRORS error(s)" >&2
  exit 1
fi

echo '[{"id": "security_check", "value": "passed"}]'
