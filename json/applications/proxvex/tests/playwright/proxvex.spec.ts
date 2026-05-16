import { test, expect } from "../../../_fixtures/diagnostics.js";
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
}, testInfo) => {
  const hostname = process.env.APP_HOSTNAME;
  if (!hostname) throw new Error("APP_HOSTNAME env var is required");
  const scheme = process.env.APP_HTTPS === "true" ? "https" : "http";
  // proxvex listens on HTTP_PORT=3080 / HTTPS_PORT=3443 (set in
  // json/applications/proxvex/application.json envs default).
  const port = scheme === "https" ? 3443 : 3080;
  const appUrl = `${scheme}://${hostname}:${port}`;

  // Attach the resolved target URL so post-mortem analysis (HTML report)
  // can confirm WHICH container was probed.
  await testInfo.attach("00-target-url.txt", {
    body: `appUrl: ${appUrl}\nhostname: ${hostname}\nscheme: ${scheme}\nport: ${port}\n`,
    contentType: "text/plain",
  });

  // BASELINE: hit /api/auth/config BEFORE establishing the dev-session.
  // If proxvex's auth config endpoint is reachable AND reports
  // authenticated=false, we've proven OIDC is wired up. If it's already
  // true here, something is wrong (we'd have a passing-by-default oracle).
  const cfgBeforeResp = await page.request.get(`${appUrl}/api/auth/config`);
  const cfgBeforeBody = await cfgBeforeResp.text();
  await testInfo.attach("01-auth-config-before.txt", {
    body: `status: ${cfgBeforeResp.status()}\nbody: ${cfgBeforeBody}\n`,
    contentType: "text/plain",
  });
  expect(
    cfgBeforeResp.status(),
    "baseline /api/auth/config must be reachable before dev-session",
  ).toBe(200);
  const cfgBefore = JSON.parse(cfgBeforeBody);
  expect(
    cfgBefore.oidcEnabled,
    `OIDC must be enabled on the container — got ${JSON.stringify(cfgBefore)}`,
  ).toBe(true);
  expect(
    cfgBefore.authenticated,
    `baseline must NOT be authenticated; got ${JSON.stringify(cfgBefore)} — is the bypass leaking?`,
  ).toBe(false);

  // `context.request` is the BrowserContext's APIRequestContext — it routes
  // through the remote Playwright server (inside the playwright-default LXC
  // in the nested VM), so the Zitadel token-endpoint hostname resolves via
  // the nested-VM dnsmasq. The bare `request` test-fixture from
  // @playwright/test runs in the LOCAL Node process and would resolve the
  // hostname against the laptop's DNS / /etc/hosts — that's a footgun (the
  // dev laptop may have a stale `127.0.0.1 zitadel-default` mapping).
  const token = await getDeployerToken(context.request);
  await testInfo.attach("02-token-prefix.txt", {
    body: `token (first 20 chars): ${token.slice(0, 20)}…  length: ${token.length}\n`,
    contentType: "text/plain",
  });

  // POST the token via the request context — this lands in the same cookie
  // jar as page.goto(), so the session cookie applies on the subsequent
  // navigation.
  const devSession = await context.request.post(`${appUrl}/api/auth/dev-session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const devSessionBody = await devSession.text();
  await testInfo.attach("03-dev-session-response.txt", {
    body: `status: ${devSession.status()}\nheaders: ${JSON.stringify(devSession.headersArray(), null, 2)}\nbody: ${devSessionBody}\n`,
    contentType: "text/plain",
  });
  expect(
    devSession.status(),
    `dev-session endpoint returned ${devSession.status()} body=${devSessionBody} — is PROXVEX_E2E_MODE=1 and the token role-valid?`,
  ).toBe(200);

  const response = await page.goto(appUrl);
  await testInfo.attach("04-page-goto.txt", {
    body: `status: ${response?.status()}\nurl: ${response?.url()}\n`,
    contentType: "text/plain",
  });
  expect(response?.status()).toBe(200);

  // POST-bypass: /api/auth/config must now flip to authenticated=true. The
  // baseline check above proves the test would fail loudly if the endpoint
  // mis-reports the field, so the assertion here is decisive.
  const cfgAfterResp = await page.request.get(`${appUrl}/api/auth/config`);
  const cfgAfterBody = await cfgAfterResp.text();
  await testInfo.attach("05-auth-config-after.txt", {
    body: `status: ${cfgAfterResp.status()}\nbody: ${cfgAfterBody}\n`,
    contentType: "text/plain",
  });
  const cfgAfter = JSON.parse(cfgAfterBody);
  expect(
    cfgAfter.authenticated,
    `dev-session bypass did not flip authenticated to true; cfgAfter=${JSON.stringify(cfgAfter)}`,
  ).toBe(true);
});
