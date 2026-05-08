#!/bin/sh
# Gate template for ACME flows: fail early if CF_TOKEN is the placeholder
# string used by livetest fixtures when CF_TOKEN_TEST is unset.
#
# Why a sentinel value (not "missing/empty"): the addon-acme parameters
# require CF_TOKEN to be non-empty for parameter validation to pass. Test
# fixtures fall back to a literal placeholder so validation accepts them,
# then this gate detects the placeholder and refuses to run real ACME.
#
# Pair with `allowed2fail: { "045-conf-check-cf-token-set.json": 1 }` in
# the test fixture so the scenario passes when env vars are unset and
# exercises the full pipeline when they're set.
#
# Production deployments set CF_TOKEN to a real Cloudflare API token and
# bypass this check transparently.
set -eu

CF_TOKEN="{{ CF_TOKEN }}"

# The literal placeholder used by acme-real fixture as fallback. Match
# exactly to avoid swallowing other misconfigurations (e.g. CF_TOKEN
# accidentally set to "" — addon parameter validation already rejects
# that earlier).
PLACEHOLDER="cf-token-test-not-configured"

if [ "$CF_TOKEN" = "$PLACEHOLDER" ]; then
  echo "CF_TOKEN is the livetest placeholder ($PLACEHOLDER) — set CF_TOKEN_TEST to enable real ACME issuance" >&2
  exit 1
fi

echo "CF_TOKEN looks real (length=${#CF_TOKEN}) — proceeding with ACME" >&2
