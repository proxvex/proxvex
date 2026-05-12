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

export default defineConfig({
  testDir: resolve(repoRoot, "json/applications"),
  testMatch: "**/tests/playwright/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    connectOptions: { wsEndpoint: resolveWsEndpoint() },
    launchOptions: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    // Apps use the proxvex internal CA for TLS; specs reach them via internal
    // hostnames that won't be in any external trust store.
    ignoreHTTPSErrors: true,
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
});
