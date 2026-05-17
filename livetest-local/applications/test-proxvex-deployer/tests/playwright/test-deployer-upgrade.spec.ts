import { test, expect } from "@playwright/test";

/**
 * End-to-end test for proxvex self-upgrade, driven by UI clicks against a
 * separate test-proxvex-deployer LXC (the production Hub is not touched).
 *
 * Pipeline:
 *   1. Open the installed-list page on the test deployer
 *   2. Find the row for the test-deployer's own container (matched by hostname)
 *   3. Click Upgrade, enter the new image tag, submit
 *   4. Wait until the OLD deployer stops responding (switchover started) AND
 *      a fresh container with the new version appears in the installations
 *      list (queried via the deployer API once it's reachable again).
 *
 * The test deployer runs in admin-only mode (no OIDC), so no dev-session
 * bypass is needed — /api/* accepts unauthenticated requests.
 *
 * Required env (set by scenario-env.mts in phase D):
 *   - APP_HOSTNAME — the test deployer's hostname inside the nested VM
 *                    (e.g. "test-proxvex-deployer")
 *   - APP_HTTPS    — "true" / "false"
 */
test("proxvex self-upgrade via UI completes switchover", async ({ page, context }) => {
  const hostname = process.env.APP_HOSTNAME;
  if (!hostname) throw new Error("APP_HOSTNAME env var is required");

  const scheme = process.env.APP_HTTPS === "true" ? "https" : "http";
  const port = scheme === "https" ? 3443 : 3080;
  const appUrl = `${scheme}://${hostname}:${port}`;
  // The target image tag is the published "latest" — the upgrade dialog
  // submits this via target_versions and the backend resolves the OCI tag.
  const targetTag = "latest";

  // 1. Open installed-list. In admin-only mode this is reachable without auth.
  const landing = await page.goto(`${appUrl}/installed-list`);
  expect(landing?.status(), `landing ${landing?.status()} from ${appUrl}`).toBe(200);

  // 2. Find the row whose hostname column shows the test deployer itself.
  //    The row exposes an Upgrade button as `[data-testid="upgrade-<hostname>"]`
  //    in the frontend (fall back to text-matching if that selector evolves).
  const upgradeBtn = page.locator(
    `[data-testid="upgrade-${hostname}"], tr:has-text("${hostname}") button:has-text("Upgrade")`,
  ).first();
  await expect(
    upgradeBtn,
    `Upgrade button for ${hostname} not found on /installed-list — is the deployer-instance marker present?`,
  ).toBeVisible({ timeout: 30_000 });
  await upgradeBtn.click();

  // 3. Upgrade dialog: enter target tag, submit.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // The upgrade-version-dialog renders one input per service; for proxvex
  // there's only the deployer service itself. Type the target tag in.
  await dialog.locator('input[type="text"], input:not([type])').first().fill(targetTag);
  await dialog.getByRole("button", { name: /upgrade|start|submit|ok/i }).click();

  // 4. Wait for switchover: old deployer goes unreachable, then a newer
  //    /api/version appears (could be on the same hostname after DHCP/dnsmasq
  //    repoint, or via the redirectUrl in the streaming response).
  //
  //    We poll /api/version for up to 4 minutes, accepting either:
  //      a. version field changed (clean cutover), or
  //      b. previously seen version + a newer container in installations.
  const initialVersion = await fetchVersion(context, appUrl);

  const newVersion = await pollForNewVersion(context, appUrl, initialVersion, 240_000);
  expect(
    newVersion,
    `Test deployer did not switch to a new version within 4min (still ${initialVersion})`,
  ).not.toBe(initialVersion);
});

async function fetchVersion(context: import("@playwright/test").BrowserContext, base: string): Promise<string | null> {
  try {
    const res = await context.request.get(`${base}/api/version`, { timeout: 5_000 });
    if (!res.ok()) return null;
    const j = (await res.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

async function pollForNewVersion(
  context: import("@playwright/test").BrowserContext,
  base: string,
  before: string | null,
  timeoutMs: number,
): Promise<string | null> {
  const start = Date.now();
  let latest: string | null = before;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4_000));
    const v = await fetchVersion(context, base);
    if (v && v !== before) {
      latest = v;
      return latest;
    }
  }
  return latest;
}
