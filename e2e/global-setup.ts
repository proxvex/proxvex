import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureTestCerts } from './utils/cert-generator';
import { getPveHost, getDeployerPort } from './fixtures/test-base';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface BuildInfo {
  gitHash: string;
  buildTime: string;
  dirty: boolean;
}

/**
 * Playwright global setup: verify the running backend matches the local build.
 *
 * Compares backend/dist/build-info.json (written by postbuild) with /api/version
 * from the running server. Fails early if the backend needs a restart.
 */
export default async function globalSetup() {
  // Generate self-signed test certificates for HTTPS E2E tests (idempotent)
  ensureTestCerts();
  // Read local build info
  const buildInfoPath = join(__dirname, '..', 'backend', 'dist', 'build-info.json');
  if (!existsSync(buildInfoPath)) {
    console.warn('\n⚠ No backend/dist/build-info.json found. Run: cd backend && pnpm run build\n');
    return;
  }

  const localBuild: BuildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf-8'));

  // Determine which project is used
  const isLocal = process.argv.includes('--project=local');
  const frontendPort = process.env.FRONTEND_PORT || '4200';
  const baseURL = isLocal
    ? `http://localhost:${frontendPort}`
    : `http://${getPveHost()}:${getDeployerPort()}`;

  // Fetch version from running backend
  try {
    const response = await fetch(`${baseURL}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      console.warn(`\n⚠ /api/version returned ${response.status} - backend may need update\n`);
      return;
    }

    const remoteBuild: BuildInfo & { startTime: string } = await response.json();

    // Skip version check when git info is unavailable (e.g. CI without .git)
    if (localBuild.gitHash === 'unknown') {
      console.log(`✓ Backend version check skipped (local build has no git info)`);
    } else if (remoteBuild.gitHash !== localBuild.gitHash || remoteBuild.buildTime !== localBuild.buildTime) {
      const msg = [
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║  BACKEND OUT OF DATE - restart required!                    ║',
        '╠══════════════════════════════════════════════════════════════╣',
        `║  Local build:  ${localBuild.gitHash} (${localBuild.buildTime.substring(0, 19)})`.padEnd(63) + '║',
        `║  Running:      ${remoteBuild.gitHash} (${remoteBuild.buildTime.substring(0, 19)})`.padEnd(63) + '║',
        `║  Server start: ${remoteBuild.startTime.substring(0, 19)}`.padEnd(63) + '║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
      ].join('\n');

      throw new Error(msg);
    }

    console.log(`✓ Backend version verified: ${remoteBuild.gitHash} (${remoteBuild.buildTime.substring(0, 19)})`);

    // SSL is now always active when the SSL addon is selected (no separate toggle needed)
  } catch (err: any) {
    if (err.message?.includes('BACKEND OUT OF DATE')) {
      throw err; // Re-throw our own error
    }
    console.warn(`\n⚠ Could not reach backend at ${baseURL}/api/version: ${err.message}\n`);
  }
}
