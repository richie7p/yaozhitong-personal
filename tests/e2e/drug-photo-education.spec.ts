import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

// Only the photo transcription is synthetic. Identity check, persistence,
// education job admission and readback use the isolated local backend.
test("ointment label without personal dose can be saved, explained and queried", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.route("**/api/v1/jobs/synthetic-ointment-label", (route) =>
    route.fulfill({
      json: {
        id: "synthetic-ointment-label",
        kind: "recognition",
        status: "succeeded",
        result: {
          status: "succeeded",
          guidance: "照片未標示個人用量或頻次，可以先核對藥品並閱讀衛教。",
          medications: [
            {
              name: "流程測試軟膏 1%",
              strength: "1%",
              form: "軟膏劑",
              doseAmount: null,
              doseUnit: null,
              doseText: null,
              frequencyRaw: null,
              route: null,
              durationDays: null,
              confidence: "high",
              rawText: "合成外盒：流程測試軟膏 1%；10g／管",
              candidates: [],
            },
          ],
        },
      },
    }),
  );
  await page.goto("/#add?mode=chronic&recognition=synthetic-ointment-label");
  await expect(
    page.getByText("藥膏可拍管身或外盒", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await page.getByRole("button", { name: "編輯這筆資料", exact: true }).click();
  await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("");
  await page.getByLabel("包裝上的完整許可證字號").fill("SYNTHETIC-E2E-TOPICAL");
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "儲存藥品，閱讀衛教", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel(
      "我已依藥袋或醫藥人員指示確認個人用法（每次用量、頻次與途徑）",
    ),
  ).not.toBeChecked();

  // Saving a resumed recognition is covered elsewhere. Use the real manual
  // endpoint here because this read-only recognition fixture has no server job.
  await page.route(
    "**/api/v1/recognitions/synthetic-ointment-label/medications/0",
    async (route) => {
      const response = await route.fetch({
        url: "http://127.0.0.1:5190/api/v1/medications",
      });
      await route.fulfill({ response });
    },
  );
  await page
    .getByRole("button", { name: "儲存藥品，閱讀衛教", exact: true })
    .click();
  await expect(page).toHaveURL(/#medications\?saved=/);
  const id = new URLSearchParams(page.url().split("?")[1]).get("saved")!;
  const card = page.locator(`[data-medication-id="${id}"]`);
  await expect(card.getByText("個人用法未確認", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "排定提醒", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "記錄服用", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "AI 藥品解說", exact: true }),
  ).toBeEnabled();
  const admission = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/api/v1/bundles"),
  );
  await card.getByRole("button", { name: "AI 藥品解說", exact: true }).click();
  expect((await admission).status()).toBe(202);
  await expect(
    page.getByRole("region", { name: "藥品衛教導覽", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.screenshot({
    path: testInfo.outputPath("ointment-education.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    card.getByRole("button", { name: "AI 藥品解說", exact: true }),
  ).toBeEnabled();

  await page.goto("/#chat");
  await expect(
    page
      .getByRole("checkbox", { name: "流程測試軟膏 1%", exact: true })
      .first(),
  ).toBeEnabled();
  let submitted = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/chat"))
      submitted++;
  });
  await page.getByRole("button", { name: "保存方式", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "用藥問題" })).toHaveValue(
    "這款藥應如何保存？仿單有沒有開封後的注意事項？",
  );
  expect(submitted).toBe(0);
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
