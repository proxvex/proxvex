#!/usr/bin/env bash
#
# release.sh — Push, PR, merge, and trigger release workflow
#
# Usage: ./scripts/release.sh [patch|minor|major]  (default: patch)
#
set -euo pipefail

UPSTREAM_REPO="modbus2mqtt/oci-lxc-deployer"
UPSTREAM_GH_USER="modbus2mqtt"
ORIGIN_OWNER="volkmarnissen"
ORIGIN_REPO="${ORIGIN_OWNER}/oci-lxc-deployer"
VERSION="${1:-patch}"

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()    { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
success() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
die()     { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; exit 1; }

confirm() {
  local prompt="$1"
  printf "${YELLOW}%s [y/N]${NC} " "$prompt"
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Switch gh CLI to a specific GitHub account
gh_switch() {
  local user="$1"
  info "Switching gh auth to $user..."
  gh auth switch --user "$user" 2>/dev/null || die "gh auth switch to $user failed. Run: gh auth login"
}

# Remember initial gh user to restore later
INITIAL_GH_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")

# ── 1. Preflight checks ──────────────────────────────────────────────
info "Preflight checks..."

command -v gh >/dev/null 2>&1 || die "gh CLI not found. Install: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

BRANCH=$(git branch --show-current)
[ "$BRANCH" != "main" ] || die "You are on main. Switch to a feature branch first."

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Uncommitted changes. Commit or stash first."
fi

git remote get-url upstream >/dev/null 2>&1 || die "Remote 'upstream' not configured."

case "$VERSION" in
  patch|minor|major) ;;
  *) die "Invalid version type: $VERSION (use patch, minor, or major)" ;;
esac

success "Preflight OK — branch: $BRANCH, version: $VERSION"

# ── 2. Sync fork with upstream ───────────────────────────────────────
info "Syncing fork with upstream..."
gh repo sync "$ORIGIN_REPO" --branch main --force || die "Fork sync failed"
git fetch origin main || die "git fetch origin main failed"
success "Fork synced"

# ── 3. Rebase feature branch onto synced main ────────────────────────
info "Rebasing '$BRANCH' onto origin/main..."
if ! git rebase origin/main; then
  git rebase --abort 2>/dev/null
  die "Rebase failed — resolve conflicts manually: git rebase origin/main"
fi
success "Branch rebased"

# ── 4. Push feature branch ───────────────────────────────────────────
info "Pushing branch '$BRANCH' to origin..."
git push --force-with-lease -u origin "$BRANCH" || die "git push failed"
success "Branch pushed"

# ── 5. Create PR ─────────────────────────────────────────────────────
info "Creating PR against $UPSTREAM_REPO..."

# Check if a PR already exists for this branch
EXISTING_PR=$(gh pr list --repo "$UPSTREAM_REPO" --head "${ORIGIN_OWNER}:${BRANCH}" --json number --jq '.[0].number // empty' 2>/dev/null || true)

if [ -n "$EXISTING_PR" ]; then
  warn "PR #$EXISTING_PR already exists for this branch"
  PR_NUMBER="$EXISTING_PR"
else
  # Use last commit message as PR title, rest as body
  COMMIT_TITLE=$(git log -1 --format='%s')
  COMMIT_BODY=$(git log -1 --format='%b')

  PR_URL=$(gh pr create \
    --repo "$UPSTREAM_REPO" \
    --base main \
    --head "${ORIGIN_OWNER}:${BRANCH}" \
    --title "$COMMIT_TITLE" \
    --body "${COMMIT_BODY:-_No description_}")

  PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
  success "PR created: $PR_URL"
fi

# ── 6. Wait for CI checks ────────────────────────────────────────────
info "Waiting for CI checks on PR #$PR_NUMBER..."
if ! gh pr checks "$PR_NUMBER" --repo "$UPSTREAM_REPO" --watch --fail-level all 2>/dev/null; then
  warn "Some checks failed or no checks configured. Review before merging."
fi

# ── 7. Merge PR (confirm) ────────────────────────────────────────────
PR_TITLE=$(gh pr view "$PR_NUMBER" --repo "$UPSTREAM_REPO" --json title --jq '.title')
if ! confirm "Merge PR #$PR_NUMBER '$PR_TITLE' with rebase?"; then
  die "Aborted. PR #$PR_NUMBER is still open — merge manually when ready."
fi

# Switch to upstream account for merge + release
gh_switch "$UPSTREAM_GH_USER"

info "Merging PR #$PR_NUMBER..."
if ! gh pr merge "$PR_NUMBER" --repo "$UPSTREAM_REPO" --rebase --delete-branch --admin; then
  gh_switch "$ORIGIN_OWNER"
  die "Merge failed"
fi
success "PR merged"

# ── 8. Re-sync fork and local main ───────────────────────────────────
# Switch back to origin account for fork sync
gh_switch "$ORIGIN_OWNER"

info "Re-syncing fork and local main..."
gh repo sync "$ORIGIN_REPO" --branch main || warn "Fork re-sync failed (non-critical)"
git checkout main || die "git checkout main failed"
git pull origin main || die "git pull failed"
success "Local main is up to date"

# ── 9. Trigger release (confirm) ─────────────────────────────────────
if ! confirm "Trigger release with version=$VERSION on $UPSTREAM_REPO?"; then
  info "Skipped. Trigger manually: gh workflow run release-assets-on-dispatch.yml --repo $UPSTREAM_REPO -f version=$VERSION"
  exit 0
fi

# Switch to upstream account for workflow dispatch
gh_switch "$UPSTREAM_GH_USER"

info "Triggering release-assets-on-dispatch with version=$VERSION..."
if ! gh workflow run release-assets-on-dispatch.yml \
  --repo "$UPSTREAM_REPO" \
  -f "version=$VERSION"; then
  gh_switch "$ORIGIN_OWNER"
  die "Workflow dispatch failed"
fi

success "Release workflow triggered!"

# Show link to the workflow run
sleep 2
RUN_URL=$(gh run list --repo "$UPSTREAM_REPO" --workflow="release-assets-on-dispatch.yml" --limit=1 --json url --jq '.[0].url' 2>/dev/null || true)
if [ -n "$RUN_URL" ]; then
  info "Follow progress: $RUN_URL"
fi

# Restore original gh user
if [ -n "$INITIAL_GH_USER" ] && [ "$INITIAL_GH_USER" != "$UPSTREAM_GH_USER" ]; then
  gh_switch "$INITIAL_GH_USER"
fi

printf "\n${GREEN}Done!${NC} Release pipeline is running.\n"
