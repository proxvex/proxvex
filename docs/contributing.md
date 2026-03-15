# Contributing to OCI LXC Deployer

This guide describes the fork-based rebase workflow used by this project.
The goal is a clean, linear commit history on `main` with no merge commits.

## Prerequisites

- **Git** 2.x+
- **GitHub CLI** (`gh`) — for creating PRs ([install](https://cli.github.com/))
- **Node.js** — see `.nvmrc` for the required version
- **pnpm** — see `package.json` `packageManager` field for the required version

## One-Time Setup

### 1. Fork & Clone

Fork the repository on GitHub, then clone your fork:

```bash
git clone git@github.com:YOUR_USERNAME/oci-lxc-deployer.git
cd oci-lxc-deployer
```

### 2. Add Upstream Remote

```bash
git remote add upstream git@github.com:modbus2mqtt/oci-lxc-deployer.git
```

Verify:

```bash
git remote -v
# origin    git@github.com:YOUR_USERNAME/oci-lxc-deployer.git (fetch)
# origin    git@github.com:YOUR_USERNAME/oci-lxc-deployer.git (push)
# upstream  git@github.com:modbus2mqtt/oci-lxc-deployer.git (fetch)
# upstream  git@github.com:modbus2mqtt/oci-lxc-deployer.git (push)
```

### 3. Install Dependencies

```bash
pnpm install
```

This also installs the pre-push git hook automatically.

### 4. Recommended Git Config

```bash
git config pull.rebase true
git config push.autosetupremote true
```

### 5. Delete Local `main` Branch (Recommended)

You do **not** need a local `main` branch. Feature branches are created directly
from `upstream/main`. Removing the local `main` eliminates an entire class of
sync problems:

```bash
git checkout -b temp upstream/main
git branch -D main
```

> **Why no local `main`?** A local `main` branch can get out of sync with both
> `origin/main` (your fork) and `upstream/main` (the source repository). This
> causes merge conflicts when the pre-push hook tries to update it. By working
> directly with `upstream/main` as a remote ref, you always have the latest
> state without any sync issues.

## Development Workflow

### Starting a New Feature

Always start from the latest `upstream/main`:

```bash
./scripts/git-create-branch feat/my-feature

# or without prefix (auto-prefixes with feat/):
./scripts/git-create-branch my-feature
```

### Working on Your Feature

Commit as often as you like:

```bash
git add -A && git commit -m "feat: add user authentication"
git add -A && git commit -m "feat: add login page"
```

### First Push & Creating a PR

```bash
git push -u origin feat/my-feature
./scripts/git-pr
```

The pre-push hook will automatically rebase your branch on `upstream/main`
before pushing. This ensures your PR is always based on the latest code.

### Continuing Work

After the PR is created, just keep committing and pushing:

```bash
git add -A && git commit -m "fix: address review feedback"
git push
```

Every `git push` automatically updates the PR. The pre-push hook rebases
on `upstream/main` each time.

### Periodic Rebase

For long-lived branches, rebase periodically to avoid large conflicts:

```bash
./scripts/git-rebase          # rebase only
./scripts/git-rebase --push   # rebase + force-push in one step
```

Or manually:

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin HEAD
```

> **`--force-with-lease`** is a safe version of `--force`. It refuses to push
> if someone else has pushed to the same branch since your last fetch, preventing
> accidental overwrites.

### After Your PR Is Merged

Start a fresh branch for the next feature:

```bash
git fetch upstream
git checkout -b feat/next-feature upstream/main
```

Clean up old branches (local + remote):

```bash
./scripts/git-delete-branch feat/my-feature

# or delete the current branch:
./scripts/git-delete-branch
```

## Pre-Push Hook

The pre-push hook (`scripts/git-hooks/pre-push`) runs automatically on every
`git push` and does the following:

1. **Checks dependency sync** — ensures `package.json` and lock files are consistent
2. **Fetches `upstream/main`** — gets the latest upstream state
3. **Rebases your branch on `upstream/main`** — keeps your commits on top of the latest code

The hook skips rebase for `main`, `master`, and `release-please--*` branches.

If the hook causes issues, you can skip it temporarily:

```bash
git push --no-verify
```

> **Note:** After a rebase, your commit SHAs change. This means `git push` will
> need to force-push. The hook handles this transparently — force-pushing to
> feature branches is expected and safe in this workflow.

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).
PR titles **must** follow this format (enforced by CI):

| Prefix | Purpose | Release |
|--------|---------|---------|
| `feat:` | New feature | Minor |
| `fix:` | Bug fix | Patch |
| `feat!:` / `fix!:` | Breaking change | Major |
| `chore:` | Maintenance | No release |
| `docs:` | Documentation | No release |
| `refactor:` | Code restructuring | No release |
| `test:` | Test changes | No release |
| `ci:` | CI/CD changes | No release |

Optional scope: `feat(backend):`, `fix(frontend):`, etc.

## Language

All code, comments, commit messages, and documentation must be in **English**.
This is enforced by CI checks.

## Testing

Before submitting a PR, run:

```bash
# Backend
cd backend && pnpm run lint:fix && pnpm run build && pnpm test

# Frontend
cd frontend && pnpm run lint:fix && pnpm run build && pnpm test
```

See the project `CLAUDE.md` for detailed testing instructions.

## How PRs Are Merged

PRs are **squash-merged** into `main`. This means:

- All commits in your PR become a single commit on `main`
- The PR title becomes the commit message on `main`
- This is why the PR title must follow Conventional Commits format
- Release-please reads these commit messages to auto-generate releases

## Helper Scripts

All scripts are in `scripts/` and available via `pnpm` or VSCode tasks.

| Script | pnpm | Description |
|--------|------|-------------|
| `./scripts/git-create-branch <name>` | `pnpm git:create-branch` | Create feature branch from `upstream/main` |
| `./scripts/git-rebase` | `pnpm git:rebase` | Rebase current branch on `upstream/main` |
| `./scripts/git-rebase --push` | `pnpm git:rebase:push` | Rebase + force-push |
| `./scripts/git-pr` | `pnpm git:pr` | Create PR to upstream (or open existing) |
| `./scripts/git-delete-branch` | `pnpm git:delete-branch` | Delete current branch locally + remote |

### Recommended VSCode Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+G` | Git Workflow menu (Rebase, Push, PR, Delete) |
| `Cmd+Shift+B` | Create Feature Branch |

## Troubleshooting

### Pre-push hook fails with "Uncommitted changes"

Commit or stash your changes first:

```bash
git stash
git push
git stash pop
```

### Pre-push hook fails with "Dependency sync made changes"

The dependency sync check modified files. Stage and commit them:

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: sync dependencies"
git push
```

### Rebase conflicts during push

The pre-push hook detected conflicts when rebasing on `upstream/main`:

```bash
# Fix conflicts in your editor, then:
git add <resolved-files>
git rebase --continue
git push
```

Or abort and handle it manually:

```bash
git rebase --abort
```

### No 'upstream' remote

```bash
git remote add upstream git@github.com:modbus2mqtt/oci-lxc-deployer.git
```
