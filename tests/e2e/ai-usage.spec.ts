import { expect, test, type Page } from "@playwright/test";
import { syntheticAiUsage } from "../support/ai-usage-fixture";

test.use({ serviceWorkers: "block" });

async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI 使用次數" })).toBeVisible();
}

test("remaining uses refresh immediately after accepting a photo task and remain visible after navigation", async ({
  page,
}) => {
  let used = 4;
  await page.route("**/api/v1/ai/usage", (route) =>
    route.fulfill({ json: syntheticAiUsage(used) }),
  );
  await page.route("**/api/v1/recognitions", (route) => {
    used++;
    return route.fulfill({
      status: 202,
      json: { jobId: "synthetic-quota-photo" },
    });
  });
  await page.route("**/api/v1/jobs/synthetic-quota-photo", (route) =>
    route.fulfill({
      json: {
        id: "synthetic-quota-photo",
        kind: "recognition",
        status: "succeeded",
        result: {
          status: "failed",
          medications: [],
          guidance: "這是合成流程測試圖片。",
        },
      },
    }),
  );
  await login(page);
  await page.goto("/#add?mode=chronic");
  const usage = page.getByRole("region", { name: "AI 使用次數" });
  await expect(usage).toContainText("今日 AI 還可使用 26 次");
  await page.getByLabel("藥品照片", { exact: true }).setInputFiles({
    name: "synthetic-quota.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "開始辨識" }).click();
  await expect(usage).toContainText("今日 AI 還可使用 25 次");
  await expect(usage).toContainText("個人額度：剩 25／每日 30 次");
  await page.goto("/#medications");
  await expect(usage).toContainText("今日 AI 還可使用 25 次");
  await usage.getByText("哪些操作會使用次數？", { exact: true }).click();
  await expect(usage).toContainText("已受理但處理失敗的任務也計次");
  expect(used).toBe(5);
  await expect(page.locator("body")).toBeVisible();
  expect(
    await usage.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});

test("global exhaustion preserves the displayed personal remainder and explains midnight reset", async ({
  page,
}) => {
  await page.route("**/api/v1/ai/usage", (route) =>
    route.fulfill({ json: syntheticAiUsage(3, 2000) }),
  );
  await login(page);
  const usage = page.getByRole("region", { name: "AI 使用次數" });
  await expect(usage).toContainText("今日 AI 還可使用 0 次");
  await expect(usage).toContainText("個人額度：剩 27／每日 30 次");
  await expect(usage).toContainText("全站今天的 AI 次數已用完");
  await expect(usage).toContainText("每日台北時間 00:00 恢復");
});

test("failed or malformed usage reads hide stale counts and recover through the refresh button", async ({
  page,
}) => {
  let state: "ok" | "failed" | "malformed" = "ok";
  await page.route("**/api/v1/ai/usage", (route) =>
    route.fulfill(
      state === "failed"
        ? {
            status: 503,
            json: { code: "synthetic_unavailable", message: "Synthetic" },
          }
        : { json: state === "ok" ? syntheticAiUsage(1) : { items: [] } },
    ),
  );
  await login(page);
  const usage = page.getByRole("region", { name: "AI 使用次數" });
  await expect(usage).toContainText("今日 AI 還可使用 29 次");
  for (const next of ["failed", "malformed"] as const) {
    state = next;
    await usage.getByRole("button", { name: "更新 AI 剩餘次數" }).click();
    await expect(usage).toContainText("暫時無法確認 AI 剩餘次數");
    await expect(usage).not.toContainText("29 次");
  }
  state = "ok";
  await usage.getByRole("button", { name: "更新 AI 剩餘次數" }).click();
  await expect(usage).toContainText("今日 AI 還可使用 29 次");
});
