#!/usr/bin/env node
/**
 * Syncs dependencies from backend/package.json to root package.json
 * and ensures all pnpm-lock.yaml files are up to date.
 *
 * Fast path: If everything is in sync, exits immediately (~30ms).
 * Slow path: If out of sync, repairs automatically.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Project directories
const projects = [
  { name: 'root', dir: rootDir },
  { name: 'backend', dir: join(rootDir, 'backend') },
  { name: 'frontend', dir: join(rootDir, 'frontend') }
];

/**
 * Fast check: Does pnpm-lock.yaml exist and contain all dependencies?
 *
 * For the root project, checks that all dependencies appear in the lock file.
 * For sub-projects in a pnpm workspace, only checks existence — pnpm resolves
 * their dependencies via the root lock file, so sub-project locks may not
 * contain all deps listed in their package.json.
 */
function isLockInSync(projectDir, isRoot = false) {
  try {
    const lockPath = join(projectDir, 'pnpm-lock.yaml');

    if (!existsSync(lockPath)) {
      return false;
    }

    // Sub-projects: just check lock file exists (pnpm workspace handles the rest)
    if (!isRoot) {
      return true;
    }

    // Root: verify all dependencies appear in the lock file
    const pkgPath = join(projectDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const lockContent = readFileSync(lockPath, 'utf-8');

    const allDeps = {
      ...pkg.dependencies || {},
      ...pkg.devDependencies || {}
    };

    for (const dep of Object.keys(allDeps)) {
      // Check importers section (indented) and packages section (top-level)
      const patterns = [
        `\n      ${dep}:`,           // importers: "      ajv:"
        `\n      '${dep}':`,         // importers: "      '@scope/pkg':"
        `\n  '${dep}@`,              // packages: "  '@scope/pkg@version':"
        `\n  ${dep}@`                // packages: "  ajv@version:"
      ];
      if (!patterns.some(p => lockContent.includes(p))) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Repair pnpm-lock.yaml by running pnpm install
 */
function repairLock(projectName, projectDir) {
  console.error(`Updating ${projectName}/pnpm-lock.yaml...`);
  const result = spawnSync('pnpm', ['install', '--lockfile-only'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true
  });

  if (result.status === 0) {
    console.error(`✓ Updated ${projectName}/pnpm-lock.yaml`);
    return true;
  } else {
    console.error(`✗ Failed to update ${projectName}/pnpm-lock.yaml`);
    return false;
  }
}

// --- Main ---

// Check 1: Are root dependencies synced from backend?
const backendPkgPath = join(rootDir, 'backend', 'package.json');
const rootPkgPath = join(rootDir, 'package.json');

const backendPkg = JSON.parse(readFileSync(backendPkgPath, 'utf-8'));
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));

const backendDeps = JSON.stringify(backendPkg.dependencies || {});
const rootDeps = JSON.stringify(rootPkg.dependencies || {});
const rootDepsInSync = backendDeps === rootDeps;

// Check 2: Are all lock files in sync?
const lockStatus = projects.map(p => ({
  ...p,
  inSync: isLockInSync(p.dir, p.name === 'root')
}));

const allLocksInSync = lockStatus.every(p => p.inSync);

// Fast path: Everything in sync
if (rootDepsInSync && allLocksInSync) {
  console.error('✓ All dependencies in sync');
  process.exit(0);
}

// Slow path: Need to repair
console.error('Dependencies out of sync, repairing...');
let hasError = false;

// Step 1: Sync root package.json from backend
if (!rootDepsInSync) {
  rootPkg.dependencies = { ...backendPkg.dependencies };
  writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
  console.error('✓ Synced root dependencies from backend/package.json');
  // Mark root lock as needing repair since we changed package.json
  const rootStatus = lockStatus.find(p => p.name === 'root');
  if (rootStatus) rootStatus.inSync = false;
}

// Step 2: Repair any out-of-sync lock files
for (const project of lockStatus) {
  if (!project.inSync) {
    if (!repairLock(project.name, project.dir)) {
      hasError = true;
    }
  }
}

if (hasError) {
  process.exit(1);
} else {
  console.error('✓ All dependencies repaired');
  process.exit(0);
}
