#!/bin/sh
# Inject nginx SSL proxy service into Docker-Compose file.
#
# For proxy mode: Adds an nginx-ssl-proxy service to the compose file,
# removes external HTTP port mapping (port stays container-internal),
# and writes the nginx SSL configuration.
#
# For native/certs mode: Does nothing (app handles HTTPS itself or only certs needed).
#
# Limitation v1: Only supports compose files with a single app service.
# The first service listed under 'services:' is used as upstream.
#
# Requires:
#   - compose_project: Docker-Compose project name
#   - ssl_mode: "proxy", "native", or "certs"
#   - http_port: Application HTTP port
#   - https_port: HTTPS port for nginx proxy
#   - uid/gid: Application user (for cert file access in nginx container)
#
# Output: errors to stderr only

COMPOSE_PROJECT="{{ compose_project }}"
SSL_MODE="{{ ssl_mode }}"
HTTP_PORT="{{ http_port }}"
HTTPS_PORT="{{ https_port }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"

[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""
[ "$COMPOSE_PROJECT" = "NOT_DEFINED" ] && COMPOSE_PROJECT=""
[ "$UID_VALUE" = "NOT_DEFINED" ] && UID_VALUE="0"
[ "$GID_VALUE" = "NOT_DEFINED" ] && GID_VALUE="0"

# Native mode: nothing to do
if [ "$SSL_MODE" = "native" ]; then
  echo "SSL native mode: app handles HTTPS itself, no compose modification needed" >&2
  exit 0
fi

# Certs mode: nothing to do (only certificates provisioned, no proxy)
if [ "$SSL_MODE" = "certs" ]; then
  echo "SSL certs mode: certificates only, no compose modification needed" >&2
  exit 0
fi

# No compose project: not a Docker-Compose app, skip
if [ -z "$COMPOSE_PROJECT" ]; then
  echo "Not a Docker-Compose app, skipping SSL proxy compose injection" >&2
  exit 0
fi

COMPOSE_DIR="/opt/docker-compose/${COMPOSE_PROJECT}"

# Support both .yaml and .yml extensions
if [ -f "${COMPOSE_DIR}/docker-compose.yaml" ]; then
  COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yaml"
elif [ -f "${COMPOSE_DIR}/docker-compose.yml" ]; then
  COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"
else
  echo "Error: Compose file not found in: $COMPOSE_DIR" >&2
  exit 1
fi

# --- Extract first service name ---
# Find first line under 'services:' that matches a service definition (word followed by colon)
UPSTREAM_SERVICE=""
IN_SERVICES=0
while IFS= read -r line; do
  # Detect 'services:' section
  case "$line" in
    services:*)
      IN_SERVICES=1
      continue
      ;;
  esac

  if [ "$IN_SERVICES" = "1" ]; then
    # Skip empty lines and comments
    case "$line" in
      ""|\#*) continue ;;
    esac
    # Check if this is a top-level key (starts with 2 spaces + word + colon)
    # or a non-indented key (would indicate end of services section)
    case "$line" in
      "  "[a-zA-Z_-]*:*)
        # Extract service name (strip leading spaces and trailing colon/content)
        UPSTREAM_SERVICE=$(echo "$line" | sed 's/^[[:space:]]*//' | cut -d: -f1)
        break
        ;;
      [a-zA-Z_-]*:*)
        # Non-indented key = new top-level section, stop
        break
        ;;
    esac
  fi
done < "$COMPOSE_FILE"

if [ -z "$UPSTREAM_SERVICE" ]; then
  echo "Error: Could not find any service in $COMPOSE_FILE" >&2
  exit 1
fi

echo "Detected upstream service: $UPSTREAM_SERVICE" >&2

# --- Check for HTTPS port conflict ---
if grep -q "\"${HTTPS_PORT}:" "$COMPOSE_FILE" 2>/dev/null || \
   grep -q "'${HTTPS_PORT}:" "$COMPOSE_FILE" 2>/dev/null || \
   grep -q "- ${HTTPS_PORT}:" "$COMPOSE_FILE" 2>/dev/null; then
  echo "Error: HTTPS port ${HTTPS_PORT} is already used by a service in $COMPOSE_FILE" >&2
  echo "Please choose a different HTTPS port to avoid conflicts." >&2
  exit 1
fi

# --- Remove external HTTP port mapping ---
# Remove lines matching patterns like: - "3000:3000", - '3000:3000', - 3000:3000
# The port stays container-internal (accessible via Docker network)
echo "Removing external HTTP port mapping for port ${HTTP_PORT}..." >&2
sed -i "s|.*\"${HTTP_PORT}:${HTTP_PORT}\".*||;s|.*'${HTTP_PORT}:${HTTP_PORT}'.*||;s|.*- ${HTTP_PORT}:${HTTP_PORT}.*||" "$COMPOSE_FILE"
# Clean up empty lines left by sed
sed -i '/^$/d' "$COMPOSE_FILE"
# Remove orphaned 'ports:' key with no entries (next line is a different key or less indented)
# Use awk to detect ports: followed by a non-list-item line
awk '
  /^\s+ports:\s*$/ { hold=$0; next }
  hold {
    if ($0 ~ /^\s+-/) { print hold; hold="" }
    else { hold="" }
  }
  { print }
' "$COMPOSE_FILE" > "${COMPOSE_FILE}.tmp" && mv "${COMPOSE_FILE}.tmp" "$COMPOSE_FILE"

# --- Write nginx SSL config ---
NGINX_CONF="${COMPOSE_DIR}/nginx-ssl.conf"
cat > "$NGINX_CONF" <<NGINXEOF
server {
    listen ${HTTPS_PORT} ssl;
    server_name _;

    ssl_certificate /etc/ssl/addon/fullchain.pem;
    ssl_certificate_key /etc/ssl/addon/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://${UPSTREAM_SERVICE}:${HTTP_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 86400;
    }
}
NGINXEOF
echo "Wrote nginx SSL config to ${NGINX_CONF}" >&2

# --- Append nginx-ssl-proxy service to compose file ---
# Remove trailing 'volumes:' section if it exists at the end (we'll re-add it)
# First check if compose file ends with a volumes section

cat >> "$COMPOSE_FILE" <<COMPOSEEOF

  nginx-ssl-proxy:
    image: nginx:alpine
    user: "${UID_VALUE}:${GID_VALUE}"
    ports:
      - "${HTTPS_PORT}:${HTTPS_PORT}"
    volumes:
      - ./nginx-ssl.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/ssl/addon:/etc/ssl/addon:ro
    depends_on:
      - ${UPSTREAM_SERVICE}
    restart: unless-stopped
COMPOSEEOF

echo "Added nginx-ssl-proxy service to $COMPOSE_FILE" >&2
echo "Upstream: ${UPSTREAM_SERVICE}:${HTTP_PORT} -> HTTPS port ${HTTPS_PORT}" >&2
