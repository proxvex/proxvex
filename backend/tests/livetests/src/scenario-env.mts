/**
 * Build the environment variables passed to a Playwright spec when the
 * scenario-executor invokes `pnpm run test:applications`. Keeps the wiring
 * for env-var derivation in one place so future additions (extra OIDC
 * helpers, alternate browser endpoints, …) don't scatter through the
 * scenario-executor.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface ScenarioEnvInput {
  /** Active e2e instance (green | yellow | github-action). */
  instance: string;
  /** Outer PVE host (e.g. ubuntupve). */
  pveHost: string;
  /** Project root, for resolving e2e/config.json. */
  projectRoot: string;
  /** Container hostname of the application under test (e.g. proxvex-1234). */
  appHostname: string;
  /** True when addon-ssl is among the scenario's selected addons. */
  appHttps: boolean;
}

export interface ScenarioEnv {
  /** Externally reachable WebSocket URL of the Playwright remote browser. */
  PLAYWRIGHT_WS: string;
  /** Outer PVE host (for tests that compose their own URLs). */
  PVE_HOST: string;
  /** Container hostname of the app under test. Spec composes the URL with
   *  its own knowledge of the app's port/scheme. */
  APP_HOSTNAME: string;
  /** "true" | "false" — convenience flag so specs can pick http/https. */
  APP_HTTPS: string;
  /** Active instance (lets tests fork e.g. on github-action vs. dev). */
  E2E_INSTANCE: string;
}

/**
 * Resolve the externally reachable WS port for the playwright remote-browser
 * container from e2e/config.json's portForwarding array.
 */
function resolvePlaywrightWsPort(
  projectRoot: string,
  instance: string,
): number {
  const cfgPath = path.join(projectRoot, "e2e/config.json");
  if (!existsSync(cfgPath)) {
    throw new Error(
      `Cannot resolve PLAYWRIGHT_WS port — e2e/config.json not found at ${cfgPath}`,
    );
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
    instances?: Record<
      string,
      {
        portForwarding?: Array<{
          port: number;
          hostname: string;
          ip: string;
          containerPort: number;
        }>;
      }
    >;
  };
  const fwd = cfg.instances?.[instance]?.portForwarding?.find(
    (f) => f.hostname === "playwright",
  );
  if (!fwd) {
    throw new Error(
      `No portForwarding entry for hostname "playwright" in e2e/config.json instance "${instance}" — deploy the playwright application or add the entry manually.`,
    );
  }
  return fwd.port;
}

export function collectScenarioEnv(input: ScenarioEnvInput): ScenarioEnv {
  const wsPort = resolvePlaywrightWsPort(input.projectRoot, input.instance);
  return {
    PLAYWRIGHT_WS: `ws://${input.pveHost}:${wsPort}`,
    PVE_HOST: input.pveHost,
    APP_HOSTNAME: input.appHostname,
    APP_HTTPS: input.appHttps ? "true" : "false",
    E2E_INSTANCE: input.instance,
  };
}
