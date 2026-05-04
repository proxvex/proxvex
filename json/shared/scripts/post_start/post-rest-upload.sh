#!/bin/sh
# Generic single-call REST upload for post_start configuration.
#
# Reads template variables, polls a health endpoint, and POSTs a base64-encoded
# payload to a configurable endpoint. Authentication is handled by the shared
# rest-configure-common.sh library: tries unauthenticated first, then OIDC
# bearer token via client_credentials on 401.
#
# Skipped silently when rest_payload_b64 is empty/NOT_DEFINED — let templates
# stay in the post_start chain even when the upload is optional.

set -eu

URL="{{ rest_url }}"
PATH_VAL="{{ rest_path }}"
PAYLOAD_B64="{{ rest_payload_b64 }}"
CONTENT_TYPE="{{ rest_content_type }}"
HEALTH_PATH="{{ rest_health_path }}"

export REST_OIDC_ISSUER="{{ oidc_issuer_url }}"
export REST_OIDC_CLIENT_ID="{{ oidc_client_id }}"
export REST_OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"

if [ -z "$PAYLOAD_B64" ] || [ "$PAYLOAD_B64" = "NOT_DEFINED" ]; then
  echo "post-rest-upload: no payload provided, skipping" >&2
  echo '[{"id":"rest_uploaded","value":"false"}]'
  exit 0
fi

rest_wait_for_ready "${URL}${HEALTH_PATH}" 60 || {
  echo "post-rest-upload: target not ready, aborting" >&2
  exit 1
}

rest_post "$URL" "$PATH_VAL" "$PAYLOAD_B64" "$CONTENT_TYPE"

echo '[{"id":"rest_uploaded","value":"true"}]'
