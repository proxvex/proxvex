#!/bin/sh
# Check OIDC endpoint is reachable and API is protected.
#
# Template variables:
#   vm_id - Container VM ID
#   local_https_port - HTTPS port of the deployer (OIDC requires HTTPS)
#
# Outputs JSON array with check results.
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"
HTTPS_PORT="{{ local_https_port }}"

# Probe from inside the container against loopback. During proxvex self-upgrade
# the new container shares the static IP with the old one — a host-side curl
# would route via the bridge to whichever container the MAC table currently
# points at (typically the still-running old deployer). Loopback is namespace-
# local, so this always hits the new deployer's listener.
#
# The proxvex LXC has no curl/wget — use the bundled node binary directly.
# OIDC enforcement runs on the HTTPS port (HTTP port serves a 301 redirect to
# HTTPS), so we hit HTTPS with cert verification disabled (private CA).
status=$(pct exec "$VM_ID" -- node -e "
const https = require('https');
const req = https.get({hostname:'localhost',port:${HTTPS_PORT},path:'/api/applications',rejectUnauthorized:false}, (res) => {
  process.stdout.write(String(res.statusCode));
  process.exit(0);
});
req.on('error', () => { process.stdout.write('000'); process.exit(0); });
req.setTimeout(10000, () => { req.destroy(); process.stdout.write('000'); process.exit(0); });
" 2>/dev/null || true)

if [ "$status" = "401" ]; then
    echo "CHECK: oidc_endpoint PASSED (API returns 401 - protected)" >&2
    printf '[{"id":"check_oidc","value":"ok (401 protected)"}]'
elif [ "$status" = "200" ]; then
    echo "CHECK: oidc_endpoint WARNING (API returns 200 - not protected)" >&2
    printf '[{"id":"check_oidc","value":"warning (200 unprotected)"}]'
else
    echo "CHECK: oidc_endpoint FAILED (HTTP status: $status)" >&2
    printf '[{"id":"check_oidc","value":"failed (HTTP %s)"}]' "$status"
    exit 1
fi
