#!/usr/bin/env bash
#
# new-branch.sh — Create a new feature branch from a synced main
#
# Usage: ./scripts/new-branch.sh <branch-name>
#
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
success() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
die()     { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; exit 1; }

ORIGIN_REPO="volkmarnissen/oci-lxc-deployer"
BRANCH_NAME="${1:-}"

[ -n "$BRANCH_NAME" ] || die "Usage: $0 <branch-name>"

# ── 1. Stash local changes if needed ─────────────────────────────────
STASHED=false
if ! git diff --quiet || ! git diff --cached --quiet; then
  info "Stashing local changes..."
  git stash push -m "new-branch: auto-stash before creating $BRANCH_NAME"
  STASHED=true
  success "Changes stashed"
fi

# ── 2. Sync fork with upstream ───────────────────────────────────────
info "Syncing fork with upstream..."
gh repo sync "$ORIGIN_REPO" --branch main || warn "Fork sync failed (continuing with local state)"

# ── 3. Fetch and update main ─────────────────────────────────────────
info "Fetching origin..."
git fetch origin main || die "git fetch failed"

git checkout main || die "git checkout main failed"
git pull --rebase origin main || die "git pull --rebase failed"
success "main is up to date"

# ── 4. Create and switch to new branch ───────────────────────────────
git branch "$BRANCH_NAME" || die "Branch '$BRANCH_NAME' already exists"
git checkout "$BRANCH_NAME" || die "git checkout failed"
success "On new branch: $BRANCH_NAME"

# ── 5. Restore stashed changes ───────────────────────────────────────
if [ "$STASHED" = true ]; then
  info "Restoring stashed changes..."
  if git stash pop; then
    success "Stash restored"
  else
    warn "Stash pop had conflicts. Resolve manually with: git stash show / git stash drop"
  fi
fi

printf "\n${GREEN}Ready!${NC} Working on branch: ${BRANCH_NAME}\n"
