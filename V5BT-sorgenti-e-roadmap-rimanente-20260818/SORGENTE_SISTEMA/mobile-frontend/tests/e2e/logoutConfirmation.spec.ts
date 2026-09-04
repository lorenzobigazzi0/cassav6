import { expect, test } from "@playwright/test";

const AUTH_VALUES: Record<string, string> = {
  pos_token: "e2e-token",
  pos_user_id: "e2e-admin",
  pos_user: "admin",
  pos_full_name: "Admin Test",
  pos_role: "admin",
  pos_role_label: "Amministratore",
  pos_permissions: JSON.stringify(["collect_payments"]),
  pos_allowed_payment_method_ids: "[]",
  pos_auth_session_started_at: String(Date.now()),
  pos_device_uuid: "e2e-device",
};

test("manual logout requires confirmation", async ({ page }) => {
  await page.addInitScript((values) => {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const [key, value] of Object.entries(values)) {
        storage.setItem(key, value);
      }
    }
  }, AUTH_VALUES);

  await page.route("**/api/auth/session/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, valid: true }),
    });
  });

  await page.goto("./");
  await expect(page.locator(".home-page")).toBeVisible();

  await page.locator(".avatar").click();
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page.getByRole("alertdialog", { name: "Conferma logout" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("pos_token")))
    .toBe("e2e-token");

  await page.getByRole("button", { name: "ANNULLA" }).click();
  await expect(page.getByRole("alertdialog", { name: "Conferma logout" })).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("pos_token")))
    .toBe("e2e-token");

  await page.locator(".avatar").click();
  await page.getByRole("button", { name: "Logout" }).click();
  await page.getByRole("button", { name: "ESCI" }).click();

  await expect(page.getByRole("heading", { name: "Accedi" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("pos_token"))).toBeNull();
});
