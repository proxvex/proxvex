#!/bin/sh
# Upload Docker Compose files to LXC container
#
# This script:
# 1. Decodes base64-encoded Docker Compose file
# 2. Writes it to /opt/docker-compose/<project>/docker-compose.yaml
# 3. Decodes base64-encoded .env file (if provided)
# 4. Writes it to /opt/docker-compose/<project>/.env
# 5. Sets correct permissions
#
# Requires:
#   - compose_file: Base64-encoded Docker Compose file (from upload parameter)
#   - env_file: Base64-encoded .env file (optional, from upload parameter)
#   - compose_project: Project name (directory name)
#
# Output: JSON to stdout (errors to stderr)

COMPOSE_FILE_B64="{{ compose_file }}"
ENV_FILE_B64="{{ env_file }}"
COMPOSE_PROJECT="{{ compose_project }}"
VMID="{{ vm_id }}"
STACK_SECRET_NAMES="{{ stack_secret_names }}"

[ "$STACK_SECRET_NAMES" = "NOT_DEFINED" ] && STACK_SECRET_NAMES=""

if [ -z "$COMPOSE_PROJECT" ]; then
  echo "Error: Required parameter 'compose_project' must be set" >&2
  exit 1
fi

if [ -z "$COMPOSE_FILE_B64" ] || [ "$COMPOSE_FILE_B64" = "" ]; then
  echo "Error: Required parameter 'compose_file' must be set" >&2
  exit 1
fi

# Create project directory
PROJECT_DIR="/opt/docker-compose/$COMPOSE_PROJECT"
mkdir -p "$PROJECT_DIR"

# Decode and write docker-compose.yaml
echo "Writing docker-compose.yaml to $PROJECT_DIR/docker-compose.yaml..." >&2
echo "$COMPOSE_FILE_B64" | base64 -d > "$PROJECT_DIR/docker-compose.yaml"
if [ $? -ne 0 ]; then
  echo "Error: Failed to decode or write docker-compose.yaml" >&2
  exit 1
fi

# Set permissions for compose file
chmod 644 "$PROJECT_DIR/docker-compose.yaml"

# Decode and write .env file if provided
if [ -n "$ENV_FILE_B64" ] && [ "$ENV_FILE_B64" != "" ] && [ "$ENV_FILE_B64" != "NOT_DEFINED" ]; then
  echo "Writing .env file to $PROJECT_DIR/.env..." >&2
  echo "$ENV_FILE_B64" | base64 -d > "$PROJECT_DIR/.env"
  if [ $? -ne 0 ]; then
    echo "Error: Failed to decode or write .env file" >&2
    exit 1
  fi
  chmod 644 "$PROJECT_DIR/.env"
else
  echo "No .env file provided, skipping" >&2
fi

# Set directory permissions
chmod 755 "$PROJECT_DIR"

# Extract user from docker-compose.yaml and set ownership
# Look for 'user: "NNN"' or 'user: NNN' pattern (first service's user as default)
COMPOSE_USER=$(grep -E '^\s+user:\s*["\x27]?[0-9]+' "$PROJECT_DIR/docker-compose.yaml" | head -n1 | sed -E 's/.*user:\s*["\x27]?([0-9]+).*/\1/')

if [ -n "$COMPOSE_USER" ]; then
  echo "Setting ownership of $PROJECT_DIR to UID $COMPOSE_USER" >&2
  chown -R "$COMPOSE_USER:$COMPOSE_USER" "$PROJECT_DIR"
else
  echo "No specific user found in compose file, keeping root ownership" >&2
fi

# Create symlinks from compose-relative volume dirs to LXC mount points.
# Docker resolves ./xxx relative to compose file dir (PROJECT_DIR), but the actual
# files are bind-mounted to /xxx in the LXC by template 160. Symlinks bridge this gap.
grep -E '^\s*-\s*\./[^:]+:/[^:]+' "$PROJECT_DIR/docker-compose.yaml" 2>/dev/null | while IFS= read -r vline; do
  # Extract host-side relative path (./xxx) and container path (/xxx)
  rel_path=$(echo "$vline" | sed -E 's/^\s*-\s*\.\/([^:]+):.*/\1/')
  container_path=$(echo "$vline" | sed -E 's/^\s*-\s*\.[^:]+:([^:]+).*/\1/')

  # Skip if we couldn't parse
  [ -z "$rel_path" ] && continue
  [ -z "$container_path" ] && continue

  target="$PROJECT_DIR/$rel_path"

  # Only create symlink if the LXC mount point exists and target doesn't already exist
  if [ -d "$container_path" ] && [ ! -e "$target" ]; then
    ln -sf "$container_path" "$target"
    echo "Symlinked $target -> $container_path" >&2
  elif [ -d "$container_path" ] && [ -L "$target" ]; then
    # Update existing symlink
    ln -sf "$container_path" "$target"
    echo "Updated symlink $target -> $container_path" >&2
  fi
done

# Create sanitized template file (secrets replaced with placeholder markers)
# This template is used during upgrades to preserve the compose structure
# while keeping secrets out of the persistent file.
if [ -n "$STACK_SECRET_NAMES" ]; then
  TEMPLATE_FILE="$PROJECT_DIR/docker-compose.template.yaml"
  cp "$PROJECT_DIR/docker-compose.yaml" "$TEMPLATE_FILE"

  # For each secret name, find its resolved value in the compose file
  # and replace it back with a placeholder marker
  echo "$STACK_SECRET_NAMES" | tr ',' '\n' | while IFS='=' read -r secret_name secret_value; do
    secret_name=$(echo "$secret_name" | tr -d ' ')
    secret_value=$(echo "$secret_value" | tr -d ' ')
    if [ -n "$secret_name" ] && [ -n "$secret_value" ]; then
      # Use sed to replace the value with the placeholder
      # Escape special chars in the value for sed
      escaped_value=$(printf '%s\n' "$secret_value" | sed 's/[[\.*^$()+?{|\\]/\\&/g')
      OPEN_BRACE="{{"
      CLOSE_BRACE="}}"
      sed -i "s|${escaped_value}|${OPEN_BRACE} ${secret_name} ${CLOSE_BRACE}|g" "$TEMPLATE_FILE"
      echo "Sanitized secret: $secret_name" >&2
    fi
  done

  chmod 644 "$TEMPLATE_FILE"
  echo "Created sanitized template at $TEMPLATE_FILE" >&2
fi

echo "Docker Compose files uploaded successfully to $PROJECT_DIR" >&2
echo '[{"id": "compose_files_uploaded", "value": "true"}, {"id": "compose_dir", "value": "'"$PROJECT_DIR"'"}]'
