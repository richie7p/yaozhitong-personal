import { test, expect } from "@playwright/test";

const image = {
  name: "first-synthetic.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=",
    "base64",
  ),
};

test("changing photos clears stale results and a failed upload can be retried", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.goto("/#add");
  const upload = page.locator('input[type="file"]');
  const recognized = page.getByRole("heading", {
    name: "流程測試片 5mg",
    exact: true,
  });
  await upload.setInputFiles(image);
  await page.getByRole("button", { name: "開始辨識" }).click();
  await expect(recognized).toBeVisible();
  await page.getByRole("button", { name: "編輯這筆資料" }).click();
  await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
    "流程測試片 5mg",
  );

  await upload.setInputFiles({ ...image, name: "second-synthetic.png" });
  await expect(recognized).toHaveCount(0);
  await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveCount(0);
  await page.route("**/api/v1/recognitions", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "ai_busy",
        message: "合成測試：服務暫時忙碌",
      }),
    }),
  );
  await page.getByRole("button", { name: "開始辨識" }).click();
  await expect(
    page.getByText("合成測試：服務暫時忙碌", { exact: true }),
  ).toBeVisible();
  await expect(recognized).toHaveCount(0);
  await expect(upload).toBeEnabled();

  await page.unroute("**/api/v1/recognitions");
  await page.getByRole("button", { name: "開始辨識" }).click();
  await expect(recognized).toBeVisible();
  await expect(
    page.getByText("合成測試：服務暫時忙碌", { exact: true }),
  ).toHaveCount(0);
});

test("recognition rejection is shown as unreadable with a recovery link", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.route("**/api/v1/jobs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "synthetic-rejection",
            kind: "recognition",
            status: "succeeded",
            createdAt: new Date().toISOString(),
            result: {
              status: "failed",
              guidance: "合成測試：請重新拍攝",
              medications: [],
            },
          },
        ],
      }),
    }),
  );
  await page.goto("/#profile");
  await expect(page.getByText("未能辨識", { exact: true })).toBeVisible();
  await expect(
    page.getByText("合成測試：請重新拍攝", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "重新上傳藥袋" })).toBeVisible();
  await expect(page.getByText("查看辨識原文", { exact: true })).toHaveCount(0);
});
