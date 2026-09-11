import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("profile, cabinet, export and cross-session persistence", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.goto("/#profile");
  await page
    .getByLabel("健康狀況（逗號分隔）")
    .fill("合成測試狀況甲,合成測試狀況乙");
  await page.getByLabel("其他健康補充").fill("自動化測試，非真實健康資料");
  await page.getByRole("button", { name: "儲存設定" }).click();
  await expect(
    page.getByText("個人資料已更新。", { exact: true }),
  ).toBeVisible();
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    await other.goto("http://127.0.0.1:5190/");
    await other
      .getByRole("button", { name: "本機使用者", exact: true })
      .click();
    await expect(
      other.getByRole("heading", { name: /今天也照顧好自己/ }),
    ).toBeVisible();
    await other.goto("http://127.0.0.1:5190/#profile");
    await expect(other.getByLabel("其他健康補充")).toHaveValue(
      "自動化測試，非真實健康資料",
    );
    await page.bringToFront();
    await page.goto("/#cabinet");
    await page.getByRole("button", { name: "新增藥箱項目" }).click();
    const name = "合成藥箱項目-" + Date.now();
    await page.getByLabel("名稱", { exact: true }).fill(name);
    await page.getByLabel("剩餘數量").fill("12");
    await page.getByLabel("單位", { exact: true }).fill("錠");
    await page.getByLabel("有效日期").fill("2020-01-01");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    const row = page.locator(".list-row").filter({ hasText: name });
    await expect(row.getByText("已過期", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "編輯", exact: true }).click();
    await page.getByLabel("剩餘數量").fill("4");
    await page.getByRole("button", { name: "儲存", exact: true }).click();
    await expect(row).toContainText("4 錠");
    await row.getByRole("button", { name: "標記已處理" }).click();
    await expect(row.getByText("已處理", { exact: true })).toBeVisible();
    await page.goto("/#profile");
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "匯出我的資料" }).click();
    const download = await downloadEvent;
    const exported = JSON.parse(
      await readFile((await download.path())!, "utf8"),
    );
    expect(exported.profile.notes).toBe("自動化測試，非真實健康資料");
    expect(
      exported.cabinet.some(
        (r: any) => r.name === name && r.quantity === 4 && r.disposed,
      ),
    ).toBe(true);
    expect(JSON.stringify(exported)).not.toContain("family@example.test");
  } finally {
    await second.close();
  }
});

test("photo correction, evidence, quiz, interaction and failed AI retry through real API", async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  // Clear only this isolated test account's active medications between viewport runs.
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const { items } = await (
    await request.get("/api/v1/medications", { headers })
  ).json();
  for (const m of items)
    await request.delete("/api/v1/medications/" + m.id, { headers });
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.goto("/#add");
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name: "synthetic.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await page.getByRole("button", { name: "開始辨識" }).click();
  await page
    .locator(".search-result")
    .filter({ hasText: "流程測試片 5mg" })
    .click();
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "儲存草稿" }).click();
  const med = page
    .locator("article.med-card")
    .filter({ hasText: "流程測試片 5mg" });
  await expect(med.getByRole("button", { name: "仿單說明" })).toBeDisabled();
  await expect(med.getByRole("button", { name: "排定提醒" })).toHaveCount(0);
  await med.getByRole("button", { name: "編輯用法" }).click();
  await page.getByLabel("每次劑量", { exact: true }).fill("1");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("QD");
  await page.getByLabel("我已對照藥袋確認藥品與用法").check();
  await page.getByRole("button", { name: "確認並儲存藥品" }).click();
  await med.getByRole("button", { name: "仿單說明" }).click();
  const evidence = page.locator(".evidence");
  await expect(evidence.getByText("已附仿單依據", { exact: true })).toBeVisible(
    { timeout: 20000 },
  );
  await evidence.getByText("對照仿單原文", { exact: true }).click();
  await expect(evidence.locator("blockquote")).toContainText("SYNTHETIC-E2E-5");
  await evidence.getByLabel("可以", { exact: true }).check();
  await evidence.getByRole("button", { name: "檢查答案" }).click();
  await expect(evidence.getByText(/再看一下：/)).toBeVisible();
  await evidence.getByLabel("不可以，只供軟體測試", { exact: true }).check();
  await evidence.getByRole("button", { name: "檢查答案" }).click();
  await expect(evidence.getByText(/答對了。/)).toBeVisible();
  await page.goto("/#add");
  await page.getByRole("button", { name: "搜尋藥名", exact: true }).click();
  await page.getByLabel("搜尋藥名", { exact: true }).fill("流程測試片 10mg");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page
    .locator(".search-result")
    .filter({ hasText: "流程測試片 10mg" })
    .click();
  await page.getByLabel("每次劑量", { exact: true }).fill("1");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("QD");
  await page.getByLabel("我已對照藥袋確認藥品與用法").check();
  await page.getByRole("button", { name: "確認並儲存藥品" }).click();
  await expect(
    page.getByRole("heading", { name: "流程測試片 10mg", exact: true }),
  ).toBeVisible();
  await page.goto("/#learning");
  await page.getByLabel("流程測試片 5mg", { exact: true }).check();
  await page.getByLabel("流程測試片 10mg", { exact: true }).check();
  await page.getByRole("button", { name: "比對交互作用" }).click();
  await expect(
    page.getByRole("heading", { name: "交互作用核對", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.goto("/#chat");
  await page.getByLabel("流程測試片 5mg", { exact: true }).check();
  const question = "測試一次失敗，請說明資料限制 " + Date.now();
  await page.locator("textarea").fill(question);
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(
    page.getByText("AI 輸出格式無法驗證，請重試。", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.locator("textarea")).toHaveValue(question);
  await page.goto("/#profile");
  await page.getByRole("button", { name: "使用原輸入重試" }).click();
  await expect(
    page.getByText("已重新排入處理，稍後請重新整理。", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const r = await request.get("/api/v1/chat", { headers });
      return (await r.json()).items.some((c: any) => c.question === question);
    })
    .toBe(true);
  await page.goto("/#chat");
  await expect(page.getByText(question, { exact: true })).toBeVisible();
});
