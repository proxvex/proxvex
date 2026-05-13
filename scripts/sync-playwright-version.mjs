#!/usr/bin/env node
/**
 * Single source of truth: frontend `@playwright/test` version.
 * Patches `json/shared/scripts/library/versions.sh` so OCI_playwright_TAG
 * always matches the Microsoft image tag for the version the frontend tests
 * are pinned to. Client (frontend) and server (LXC container) must match
 * exactly, otherwise the Playwright library cannot find the browser binaries.
 *
 * Idempotent. Exits 0 with "in sync" if no change was needed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// Read the *installed* version, not the semver range. Range like "^1.50.0"
// resolves to whatever pnpm picked (e.g. 1.57.0); the image tag must match
// the resolved version exactly, otherwise client and server browsers diverge.
const installedPkgPath = join(
  repoRoot,
  "frontend/node_modules/@playwright/test/package.json",
);
if (!existsSync(installedPkgPath)) {
  console.error(
    `sync-playwright-version: ${installedPkgPath} not found — run "pnpm install" in frontend/ first`,
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(installedPkgPath, "utf-8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `sync-playwright-version: unexpected version "${version}" in installed @playwright/test`,
  );
  process.exit(1);
}

const targetTag = `v${version}-noble`;
const versionsPath = join(
  repoRoot,
  "json/shared/scripts/library/versions.sh",
);
const current = readFileSync(versionsPath, "utf-8");

const re = /^OCI_playwright_TAG=.*$/m;
if (!re.test(current)) {
  console.error(
    "sync-playwright-version: OCI_playwright_TAG line not found in versions.sh — add it once manually, then this script will keep it in sync",
  );
  process.exit(1);
}

const updated = current.replace(
  re,
  `OCI_playwright_TAG="\${OCI_playwright_TAG:-${targetTag}}"     # mcr.microsoft.com/playwright (synced from frontend/package.json)`,
);

if (updated === current) {
  console.log(`sync-playwright-version: in sync (${targetTag})`);
  process.exit(0);
}

writeFileSync(versionsPath, updated);
console.log(`sync-playwright-version: patched OCI_playwright_TAG → ${targetTag}`);
