#!/bin/sh
# Install passport-openidconnect for Node-RED OIDC authentication (post-start)
#
# Runs inside the container after start. Installs the npm package needed
# for the OIDC strategy configured in settings.js by the pre-start script.
#
# Output: JSON to stdout

echo "Installing passport-openidconnect for Node-RED OIDC..." >&2

cd /data || {
  echo "ERROR: /data directory not found" >&2
  echo '[]'
  exit 1
}

# Check if already installed
if [ -d "node_modules/passport-openidconnect" ]; then
  echo "passport-openidconnect already installed" >&2
  echo '[]'
  exit 0
fi

npm install --save passport-openidconnect >&2 2>&1

if [ $? -eq 0 ]; then
  echo "passport-openidconnect installed successfully" >&2
else
  echo "ERROR: Failed to install passport-openidconnect" >&2
fi

echo '[]'
