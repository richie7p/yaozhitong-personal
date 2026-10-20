import { test, expect } from "@playwright/test";

test("a service startup failure offers reconnection before showing sign-in methods", async ({
  page,
}) => {
  await page.route("**/api/v1/config", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/html",
      body: "<html>Unavailable</html>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("服務暫時無法回應，請稍後重試。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用 Google 登入", exact: false }),
  ).toHaveCount(0);
  await page.unroute("**/api/v1/config");
  await page.getByRole("button", { name: "重新連線", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "本機使用者", exact: true }),
  ).toBeVisible();
});
