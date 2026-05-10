#!/bin/sh
# post-check-deployer-oidc-stack.sh
# Verify the 4 DEPLOYER_OIDC_* fields are present in the oidc_production stack
# (resolved here as template variables by the backend's parameter resolution).
#
# Failure modes this catches:
# - Template 340 (post-setup-deployer-in-zitadel.sh) did not run
# - Template 340 ran but did not emit provides_DEPLOYER_OIDC_* outputs
# - Backend collectAndStoreProvides did not persist them in time
# - Stack was reset / firstStackId is wrong
#
# A non-empty value that equals the literal placeholder string indicates
# the parameter resolver did NOT substitute — also a failure.
#
# Output: JSON to stdout (errors to stderr)

MACHINE_CLIENT_ID="{{ DEPLOYER_OIDC_MACHINE_CLIENT_ID }}"
MACHINE_CLIENT_SECRET="{{ DEPLOYER_OIDC_MACHINE_CLIENT_SECRET }}"
ISSUER_URL="{{ DEPLOYER_OIDC_ISSUER_URL }}"
PROJECT_ID="{{ DEPLOYER_OIDC_PROJECT_ID }}"

ERRORS=0

check_field() {
  field_name=$1
  field_value=$2
  case "$field_value" in
    "" | "NOT_DEFINED")
      echo "ERROR: $field_name is empty in oidc_production stack" >&2
      ERRORS=$((ERRORS + 1))
      ;;
    *"{{ "*"}}"*)
      echo "ERROR: $field_name contains an unresolved template placeholder ('$field_value') — backend did not substitute" >&2
      ERRORS=$((ERRORS + 1))
      ;;
    *)
      echo "OK: $field_name present (length=${#field_value})" >&2
      ;;
  esac
}

check_field "DEPLOYER_OIDC_MACHINE_CLIENT_ID" "$MACHINE_CLIENT_ID"
check_field "DEPLOYER_OIDC_MACHINE_CLIENT_SECRET" "$MACHINE_CLIENT_SECRET"
check_field "DEPLOYER_OIDC_ISSUER_URL" "$ISSUER_URL"
check_field "DEPLOYER_OIDC_PROJECT_ID" "$PROJECT_ID"

if [ "$ERRORS" -gt 0 ]; then
  echo "Deployer OIDC stack check failed with $ERRORS error(s) — template 340 publishes 4 provides_DEPLOYER_OIDC_*; check that they are emitted and persisted in oidc_production." >&2
  exit 1
fi

echo '[{"id": "deployer_oidc_stack_check", "value": "passed"}]'
