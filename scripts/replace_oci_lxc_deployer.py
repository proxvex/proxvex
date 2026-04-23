#!/usr/bin/env python3
"""Replace variants of 'oci-lxc-deployer' with 'proxvex'.

Renames files/directories and replaces occurrences in file contents.

Design notes (learned from the earlier lxc-manager → oci-lxc-deployer run):
- No `.bak` files. Git is the rollback mechanism — use `git reset --hard`
  or `git checkout -- .` if the rename needs to be undone.
- Pre-flight: refuse to run on a dirty working tree (unless --allow-dirty),
  so that the diff produced by this script is cleanly reviewable.
- Manifest lists only real renames (src != dst) and only files whose
  content actually changed.

Usage:
  python3 scripts/replace_oci_lxc_deployer.py /path/to/repo
  python3 scripts/replace_oci_lxc_deployer.py --dry-run /path/to/repo
  python3 scripts/replace_oci_lxc_deployer.py --allow-dirty /path/to/repo
"""
import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone


DEFAULT_EXCLUDE_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".angular",
    "coverage",
    # Local Hub/Spoke dev state — not part of the product (analogous to .dev/).
    ".hubs",
}

# Files this script must never modify or rename.
DEFAULT_EXCLUDE_FILES = {
    "replace_oci_lxc_deployer.py",
    "replace_oci_lxc_deployer_changes.json",
    # Keep the previous rename script + its manifest as historical artifacts.
    "replace_lxc_manager.py",
    "replace_lxc_manager_changes.json",
    "find_lxc_manager.py",
    "find_lxc_manager_variants.py",
    "cleanup_rename_artifacts.py",
}


# Match any spelling/separator variant of "oci lxc deployer", the legacy
# pre-rename form "lxc manager" that survived in a few doc blocks and SSH
# control-socket paths, AND the plain "modbus2mqtt" org name (so references
# like ghcr.io/modbus2mqtt/oci-lxc-deployer or github.com/modbus2mqtt/… are
# rewritten to the new org "proxvex"). All alternatives map through the
# same case-aware replacement_for() below.
#
# Word boundaries (?<!\w)/(?!\w) protect shell variable names such as
# OCI_modbus2mqtt_TAG — the leading "_" is \w, so the inner token is not
# matched. The json/applications/modbus2mqtt/ broker app directory is
# exempted separately (see MODBUS2MQTT_APP_REL below).
PATTERN = re.compile(
    r"(?<!\w)("
    r"oci[\s._\-]?lxc[\s._\-]?deployer"
    r"|lxc[\s._\-]?manager"
    r"|modbus2mqtt"
    r")(?!\w)",
    re.IGNORECASE,
)

# Broker app directory: its contents legitimately carry the "modbus2mqtt"
# brand (it references github.com/modbus2mqtt/modbus2mqtt — a separate
# product not owned by the proxvex org). We skip it both from content
# rewriting and from the directory rename.
MODBUS2MQTT_APP_REL = "json/applications/modbus2mqtt"


def is_modbus2mqtt_app_path(rel_path: str) -> bool:
    rel_norm = rel_path.replace("\\", "/")
    return rel_norm == MODBUS2MQTT_APP_REL or rel_norm.startswith(MODBUS2MQTT_APP_REL + "/")


def replacement_for(token: str) -> str:
    """Pick proxvex / Proxvex / PROXVEX based on the source token's case."""
    letters_only = re.sub(r"[\s._\-]", "", token)
    if not letters_only:
        return "proxvex"
    if letters_only.isupper():
        return "PROXVEX"
    if letters_only[0].isupper():
        return "Proxvex"
    return "proxvex"


def repl(m: "re.Match[str]") -> str:
    return replacement_for(m.group(0))


def load_gitignore_patterns(root: str) -> list[str]:
    gitignore = os.path.join(root, ".gitignore")
    patterns: list[str] = []
    if not os.path.exists(gitignore):
        return patterns
    try:
        with open(gitignore, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("!"):
                    continue
                if line.endswith("/"):
                    line = line.rstrip("/")
                patterns.append(line)
    except Exception:
        return []
    return patterns


def matches_gitignore(relpath: str, name: str, patterns: list[str]) -> bool:
    for pat in patterns:
        if "/" in pat:
            if relpath == pat or relpath.startswith(pat + "/"):
                return True
            if fnmatch.fnmatch(relpath, pat):
                return True
        else:
            if fnmatch.fnmatch(name, pat) or fnmatch.fnmatch(relpath, pat):
                return True
    return False


def is_binary_file(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            chunk = f.read(1024)
            return b"\0" in chunk
    except Exception:
        return True


def preflight_clean_tree(root: str) -> None:
    """Abort if the git working tree has uncommitted changes."""
    try:
        result = subprocess.run(
            ["git", "-C", root, "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"Error: could not run 'git status' in {root}: {e}", file=sys.stderr)
        sys.exit(2)

    if result.stdout.strip():
        print(
            "Error: working tree is not clean.\n"
            "Commit, stash, or clean your changes before running this script.\n"
            "(Use --allow-dirty to override — not recommended.)",
            file=sys.stderr,
        )
        print(result.stdout, file=sys.stderr)
        sys.exit(3)


def walk_candidates(root: str, excludes: set[str], gitignore: list[str]):
    """Yield (dirpath, dirnames, filenames) after filtering excludes/gitignore."""
    for dirpath, dirnames, filenames in os.walk(root):
        kept = []
        for d in dirnames:
            rel = os.path.normpath(os.path.relpath(os.path.join(dirpath, d), root)).replace("\\", "/")
            if any(fnmatch.fnmatch(d, pat) for pat in excludes):
                continue
            if matches_gitignore(rel, d, gitignore):
                continue
            kept.append(d)
        dirnames[:] = kept
        yield dirpath, dirnames, filenames


def replace_in_files(root: str, excludes: set[str], gitignore: list[str], dry_run: bool) -> list[str]:
    changed: list[str] = []
    root = os.path.abspath(root)

    for dirpath, _dirnames, filenames in walk_candidates(root, excludes, gitignore):
        for fname in filenames:
            if fname in DEFAULT_EXCLUDE_FILES:
                continue
            fpath = os.path.join(dirpath, fname)
            rel = os.path.normpath(os.path.relpath(fpath, root)).replace("\\", "/")
            if matches_gitignore(rel, fname, gitignore):
                continue
            if is_modbus2mqtt_app_path(rel):
                continue
            if is_binary_file(fpath):
                continue
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except Exception:
                continue
            new_text = PATTERN.sub(repl, text)
            if new_text == text:
                continue
            changed.append(rel)
            if not dry_run:
                try:
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(new_text)
                except Exception as e:
                    print(f"Failed to write {fpath}: {e}", file=sys.stderr)
    return changed


def _ignored_dir(rel_dir: str, excludes: set[str], gitignore: list[str]) -> bool:
    if rel_dir in (".", ""):
        return False
    parts = rel_dir.split("/")
    # Any ancestor segment in DEFAULT_EXCLUDE_DIRS → skip
    if any(p in excludes for p in parts):
        return True
    # Any ancestor segment gitignored → skip (check each prefix as a candidate name)
    acc = ""
    for p in parts:
        acc = p if not acc else f"{acc}/{p}"
        if matches_gitignore(acc, p, gitignore):
            return True
    return False


def rename_paths(root: str, excludes: set[str], gitignore: list[str], dry_run: bool):
    """Rename files/dirs containing the pattern, bottom-up. Returns (file_renames, dir_renames)."""
    file_renames: list[tuple[str, str]] = []
    dir_renames: list[tuple[str, str]] = []
    root = os.path.abspath(root)

    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        rel_dir = os.path.normpath(os.path.relpath(dirpath, root)).replace("\\", "/")
        if _ignored_dir(rel_dir, excludes, gitignore):
            continue
        if is_modbus2mqtt_app_path(rel_dir):
            continue

        # Directories first (bottom-up ensures deepest first)
        for d in list(dirnames):
            if d in excludes:
                continue
            if not PATTERN.search(d):
                continue
            new_name = PATTERN.sub(repl, d)
            if new_name == d:
                continue
            src = os.path.join(dirpath, d)
            dst = os.path.join(dirpath, new_name)
            src_rel = os.path.normpath(os.path.relpath(src, root)).replace("\\", "/")
            dst_rel = os.path.normpath(os.path.relpath(dst, root)).replace("\\", "/")
            if is_modbus2mqtt_app_path(src_rel):
                continue  # do not rename the broker app directory itself
            dir_renames.append((src_rel, dst_rel))
            if not dry_run:
                if os.path.exists(dst):
                    print(
                        f"Error: refusing to rename {src} → {dst} (destination already exists).",
                        file=sys.stderr,
                    )
                    sys.exit(4)
                try:
                    os.rename(src, dst)
                except Exception as e:
                    print(f"Dir rename failed {src} → {dst}: {e}", file=sys.stderr)
                    sys.exit(5)

        for fname in filenames:
            if fname in DEFAULT_EXCLUDE_FILES:
                continue
            if fname.endswith(".code-workspace"):
                # keep workspace filenames stable; only the content is updated
                continue
            fpath = os.path.join(dirpath, fname)
            if is_binary_file(fpath):
                # still allow renaming binaries (icons etc.) — just skip pattern match logic that
                # would try to read content. Rename logic below only looks at the name.
                pass
            if not PATTERN.search(fname):
                continue
            new_name = PATTERN.sub(repl, fname)
            if new_name == fname:
                continue
            src = os.path.join(dirpath, fname)
            dst = os.path.join(dirpath, new_name)
            src_rel = os.path.normpath(os.path.relpath(src, root)).replace("\\", "/")
            dst_rel = os.path.normpath(os.path.relpath(dst, root)).replace("\\", "/")
            file_renames.append((src_rel, dst_rel))
            if not dry_run:
                if os.path.exists(dst):
                    print(
                        f"Error: refusing to rename {src} → {dst} (destination already exists).",
                        file=sys.stderr,
                    )
                    sys.exit(6)
                try:
                    os.rename(src, dst)
                except Exception as e:
                    print(f"File rename failed {src} → {dst}: {e}", file=sys.stderr)
                    sys.exit(7)

    return file_renames, dir_renames


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Replace 'oci-lxc-deployer' variants with 'proxvex' in file contents and paths."
    )
    parser.add_argument("root", nargs="?", default=".", help="Repository root (default: cwd)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not modify files; only produce a manifest of planned changes.",
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Bypass the clean-working-tree pre-flight check (not recommended).",
    )
    args = parser.parse_args()

    root = os.path.abspath(args.root)

    if not args.allow_dirty:
        preflight_clean_tree(root)

    excludes = set(DEFAULT_EXCLUDE_DIRS)
    gitignore = load_gitignore_patterns(root)

    print(f"{'[DRY RUN] ' if args.dry_run else ''}Renaming paths (dirs bottom-up, then files)...")
    file_renames, dir_renames = rename_paths(root, excludes, gitignore, dry_run=args.dry_run)

    print(f"{'[DRY RUN] ' if args.dry_run else ''}Replacing content in files...")
    changed_files = replace_in_files(root, excludes, gitignore, dry_run=args.dry_run)

    manifest = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "root": root,
        "dry_run": args.dry_run,
        "content_changed": changed_files,
        "file_renames": file_renames,
        "dir_renames": dir_renames,
    }

    manifest_path = os.path.join(root, "scripts", "replace_oci_lxc_deployer_changes.json")
    try:
        with open(manifest_path, "w", encoding="utf-8") as mf:
            json.dump(manifest, mf, indent=2)
    except Exception as e:
        print(f"Failed to write manifest {manifest_path}: {e}", file=sys.stderr)

    print("\nSummary:")
    print(f"  Files with content changes: {len(changed_files)}")
    print(f"  File renames:               {len(file_renames)}")
    print(f"  Dir renames:                {len(dir_renames)}")
    print(f"  Manifest:                   {manifest_path}")
    if args.dry_run:
        print("\nNothing was modified. Re-run without --dry-run to apply.")


if __name__ == "__main__":
    main()
