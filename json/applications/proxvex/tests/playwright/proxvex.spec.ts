import { test, expect } from "@playwright/test";
import { getDeployerToken } from "../../../_fixtures/oidc.js";

/**
 * Validates the OIDC-bypass mechanism for proxvex.
 *
 * Pipeline:
 *   1. Get a Zitadel access token via client_credentials grant
 *      (deployer machine user, no UI involved).
 *   2. POST the token to /api/auth/dev-session — backend (in PROXVEX_E2E_MODE)
 *      validates against UserInfo and populates the express session.
 *   3. Navigate to the proxvex landing page; expect HTTP 200 and the
 *      authenticated UI marker.
 *
 * Required env (set by livetest runner in phase D, or manually):
 *   - APP_URL                                  (e.g. http://proxvex:3080)
 *   - OIDC_ISSUER_URL
 *   - DEPLOYER_OIDC_MACHINE_CLIENT_ID
 *   - DEPLOYER_OIDC_MACHINE_CLIENT_SECRET
 *
 * Container backend must run with PROXVEX_E2E_MODE=1 for the dev-session
 * endpoint to be registered.
 */
test("proxvex authenticated home loads via dev-session bypass", async ({
  page,
  context,
}) => {
  const hostname = process.env.APP_HOSTNAME;
  if (!hostname) throw new Error("APP_HOSTNAME env var is required");
  const scheme = process.env.APP_HTTPS === "true" ? "https" : "http";
  // proxvex listens on HTTP_PORT=3080 / HTTPS_PORT=3443 (set in
  // json/applications/proxvex/application.json envs default).
  const port = scheme === "https" ? 3443 : 3080;
  const appUrl = `${scheme}://${hostname}:${port}`;

  const token = await getDeployerToken();

  // POST the token via the request context — this lands in the same cookie
  // jar as page.goto(), so the session cookie applies on the subsequent
  // navigation.
  const devSession = await context.request.post(`${appUrl}/api/auth/dev-session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    devSession.status(),
    `dev-session endpoint returned ${devSession.status()} — is PROXVEX_E2E_MODE=1?`,
  ).toBe(200);

  const response = await page.goto(appUrl);
  expect(response?.status()).toBe(200);

  // /api/auth/config should now report authenticated=true (the session
  // cookie travels with the navigation request).
  const cfgResp = await page.request.get(`${appUrl}/api/auth/config`);
  const cfg = await cfgResp.json();
  expect(cfg.authenticated).toBe(true);
});
