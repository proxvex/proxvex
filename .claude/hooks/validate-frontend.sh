#!/bin/bash
# Validates frontend after changes: lint, build, test

MARKER="$CLAUDE_PROJECT_DIR/.claude/claude.frontend-edited"

if [ ! -f "$MARKER" ]; then
  echo "Frontend validation: skipped (no changes)" >&2
  exit 0
fi

rm -f "$MARKER"

cd "$CLAUDE_PROJECT_DIR/frontend" || exit 0

# Lint
echo "Frontend: lint..." >&2
LINT_OUTPUT=$(npm run lint:fix 2>&1)
LINT_EXIT=$?

# Build
echo "Frontend: build..." >&2
BUILD_OUTPUT=$(npm run build 2>&1)
BUILD_EXIT=$?

# Test
echo "Frontend: test..." >&2
TEST_OUTPUT=$(npm test 2>&1)
TEST_EXIT=$?

# On failure, output the failed step to stdout
if [ $LINT_EXIT -ne 0 ]; then
  echo "=== FRONTEND LINT FAILED ==="
  echo "$LINT_OUTPUT"
  echo "============================"
  exit 1
fi

if [ $BUILD_EXIT -ne 0 ]; then
  echo "=== FRONTEND BUILD FAILED ==="
  echo "$BUILD_OUTPUT"
  echo "============================="
  exit 1
fi

if [ $TEST_EXIT -ne 0 ]; then
  echo "=== FRONTEND TEST FAILED ==="
  echo "$TEST_OUTPUT"
  echo "============================"
  exit 1
fi

echo "Frontend: OK" >&2
exit 0
