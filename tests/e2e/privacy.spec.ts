import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("data information is readable without login even while service configuration is unavailable", async ({ page }) => {
  let privateReads = 0;
  await page.route("**/api/v1/me", (route) => {
    privateReads++;
    return route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "請先登入。" } } });
  });
  await page.route("**/api/v1/config", (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "暫時無法連線。" } } }));
  await page.goto("/#privacy");
  const heading = page.getByRole("heading", { name: "資料使用與隱私", exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("heading", { name: "會處理哪些資料", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "OpenAI 資料處理說明", exact: true })).toHaveAttribute("href", "https://developers.openai.com/api/docs/guides/your-data");
  expect(privateReads).toBe(0);
  await page.getByRole("link", { name: "返回藥智通", exact: true }).click();
  await expect(page.getByRole("link", { name: "資料使用與隱私", exact: true })).toBeVisible();
});
