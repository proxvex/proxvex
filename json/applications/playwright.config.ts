import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

function resolveWsEndpoint(): string {
  if (process.env.PLAYWRIGHT_WS) return process.env.PLAYWRIGHT_WS;

  const pveHost = process.env.PVE_HOST || "ubuntupve";

  if (process.env.PORT_PLAYWRIGHT_WS) {
    return `ws://${pveHost}:${process.env.PORT_PLAYWRIGHT_WS}`;
  }

  const instance =
    process.env.E2E_INSTANCE ||
    readFileSync(resolve(repoRoot, "e2e", ".current-instance"), "utf-8").trim();
  const config = JSON.parse(
    readFileSync(resolve(repoRoot, "e2e", "config.json"), "utf-8"),
  );
  const fwd = config.instances?.[instance]?.portForwarding?.find(
    (f: { hostname: string }) => f.hostname === "playwright",
  );
  if (!fwd) {
    throw new Error(
      `No portForwarding entry for hostname "playwright" in instance "${instance}" — add it to e2e/config.json`,
    );
  }
  return `ws://${pveHost}:${fwd.port}`;
}

// When the livetest runner invokes a spec it sets PLAYWRIGHT_OUTPUT_DIR to
// `livetest-results/<runId>/<scenarioId>/playwright-artifacts/` so Playwright's
// `outputDir` (trace.zip, screenshots, videos, error context) lands in the
// debug bundle alongside the backend index.md. Stand-alone runs fall back to
// the default `test-results/` next to playwright.config.ts.
const playwrightOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR
  || resolve(repoRoot, "test-results");

// HTML reporter wants its own folder; it MUST be a sibling of outputDir, not
// nested inside (Playwright refuses to start otherwise). Place it next to
// playwright-artifacts so both end up in livetest-results/<runId>/<scenarioId>/.
const playwrightReportDir = playwrightOutputDir.endsWith("playwright-artifacts")
  ? resolve(playwrightOutputDir, "..", "playwright-report-html")
  : resolve(playwrightOutputDir, "report-html");

export default defineConfig({
  // testDir is the repo root so testMatch can pick up specs from both
  // json/applications (production apps) and livetest-local/applications
  // (test-only overlays like test-proxvex-deployer).
  testDir: repoRoot,
  testMatch: "**/applications/**/tests/playwright/*.spec.ts",
  outputDir: playwrightOutputDir,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // Reporters:
  // - `list`        — live console output during the run
  // - `json`        — machine-readable summary at report.json (for tooling)
  // - `html`        — self-contained report with an embedded trace viewer at
  //                   <outputDir>-html/index.html (sibling of outputDir to
  //                   avoid the "HTML reporter folder clashes with tests
  //                   output folder" guard Playwright raises when its html
  //                   path sits inside outputDir).
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(playwrightOutputDir, "report.json") }],
    ["html", { outputFolder: playwrightReportDir, open: "never" }],
  ],
  use: {
    connectOptions: { wsEndpoint: resolveWsEndpoint() },
    launchOptions: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    // Apps use the proxvex internal CA for TLS; specs reach them via internal
    // hostnames that won't be in any external trust store.
    ignoreHTTPSErrors: true,
    actionTimeout: 15000,
    navigationTimeout: 30000,
    // Retain rich post-mortem artifacts on failure: trace.zip (replayable via
    // `npx playwright show-trace`), screenshot + video. Pure-pass runs stay
    // lean — these only land in outputDir for the failing test attempt.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
