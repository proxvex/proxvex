import { test, expect } from "@playwright/test";

test("remote chromium reaches google", async ({ page }) => {
  await page.goto("https://google.de");
  await expect(page).toHaveTitle(/Google/);
});
