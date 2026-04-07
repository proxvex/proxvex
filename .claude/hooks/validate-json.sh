#!/bin/bash
# Validates JSON files at end of Claude response (Stop hook)
# Only runs if mark-json-edit.sh marked that JSON files were edited

MARKER="$CLAUDE_PROJECT_DIR/.claude/claude.json-edited"

# Only validate if marker exists (JSON was edited)
if [ ! -f "$MARKER" ]; then
  echo "JSON validation: skipped (no changes)" >&2
  exit 0
fi

# Remove marker
rm -f "$MARKER"

# Check if backend/dist exists
if [ ! -d "$CLAUDE_PROJECT_DIR/backend/dist" ]; then
  echo "Backend not built - skipping validation" >&2
  exit 0
fi

# Run validation, capture output
OUTPUT=$(cd "$CLAUDE_PROJECT_DIR/backend" && node dist/oci-lxc-deployer.mjs validate 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "JSON validation: OK" >&2
  exit 0
else
  # Output errors to stdout so Claude sees them
  echo "=== JSON VALIDATION FAILED ==="
  echo "$OUTPUT"
  echo "=============================="
  exit 1
fi
