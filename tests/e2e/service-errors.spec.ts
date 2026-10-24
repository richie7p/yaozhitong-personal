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
    page.getByText("這次回應無法讀取。若剛送出資料，請先查看相關紀錄；仍無法操作時，請聯絡管理員。", { exact: true }),
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


test("saved job failures give prerequisite-specific guidance without backend details", async ({ page }) => {
  await page.route("**/api/v1/jobs", (route) => route.fulfill({
    json: { items: [
      { id: "synthetic-format-failure", kind: "bundle", status: "failed", attempts: 3, createdAt: "2026-10-24T00:00:00Z", error: { code: "invalid_ai_output", message: "AI 結果未通過資料格式檢查。" } },
      { id: "synthetic-daily-limit", kind: "chat", status: "failed", attempts: 3, createdAt: "2026-10-24T00:00:00Z", error: { code: "quota_exceeded", message: "今日 AI 使用額度已達上限。" } },
      { id: "synthetic-source-hold", kind: "bundle", status: "failed", attempts: 3, createdAt: "2026-10-24T00:00:00Z", error: { code: "source_requires_review", message: "仿單欄位的原始頁面或完整段落無法核對。" } },
    ] },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#jobs");
  await expect(page.getByRole("heading", { name: "AI 處理紀錄", exact: true })).toBeVisible();
  await expect(page.locator('[data-job-id="synthetic-format-failure"]')).toContainText("系統這次沒能整理出可用內容");
  await expect(page.locator('[data-job-id="synthetic-format-failure"]')).not.toContainText("資料格式檢查");
  await expect(page.locator('[data-job-id="synthetic-daily-limit"]')).toContainText("請勿重複送出");
  await expect(page.locator('[data-job-id="synthetic-source-hold"]')).toContainText("來源狀態與可用原文");
  await expect(page.locator('[data-job-id="synthetic-source-hold"]')).toContainText("請先依上方訊息處理");
});
