#!/bin/sh
# Install Git hooks for the proxvex project
# Only installs if hook is missing or outdated (silent if up-to-date)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
SOURCE_HOOKS_DIR="$SCRIPT_DIR/git-hooks"

# Check if .git directory exists
if [ ! -d "$PROJECT_ROOT/.git" ]; then
  exit 0
fi

# Create hooks directory if it doesn't exist
mkdir -p "$HOOKS_DIR"

# Install every hook script that ships under scripts/git-hooks/.
# Currently: pre-push (rebase + dependency sync), pre-commit (lint:json gate
# triggered by JSON or backend changes — see git-hooks/pre-commit).
for SOURCE_HOOK in "$SOURCE_HOOKS_DIR"/*; do
  [ -f "$SOURCE_HOOK" ] || continue
  HOOK_NAME=$(basename "$SOURCE_HOOK")
  TARGET_HOOK="$HOOKS_DIR/$HOOK_NAME"

  if [ -f "$TARGET_HOOK" ] && cmp -s "$SOURCE_HOOK" "$TARGET_HOOK"; then
    continue
  fi

  cp "$SOURCE_HOOK" "$TARGET_HOOK"
  chmod +x "$TARGET_HOOK"
  echo "${GREEN}✓ ${HOOK_NAME} hook installed${NC}"
done
