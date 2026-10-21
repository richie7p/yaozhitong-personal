import { expect, test } from "@playwright/test";

test("completed recognition survives navigation and a lost save response without duplicate medication", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-recovery.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  let recognitionCalls = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/recognitions"))
      recognitionCalls++;
  });
  const responsePromise = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/recognitions"),
  );
  await page.getByRole("button", { name: "開始辨識" }).click();
  const { jobId } = await (await responsePromise).json();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
  await page.goto("/#jobs");
  await page.locator(`a[href="#add?recognition=${jobId}"]`).click();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "編輯這筆資料", exact: true }).click();
  const name = "辨識中斷恢復-" + Date.now();
  await page.getByLabel("藥品名稱", { exact: true }).fill(name);
  await page.getByLabel("每次劑量", { exact: true }).fill("1");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("QD");
  await page.getByLabel("我已對照藥袋確認用法（每次用量、頻次與途徑）").check();
  const saveUrl = `**/api/v1/recognitions/${jobId}/medications/0`;
  await page.route(saveUrl, async (route) => {
    const saved = await route.fetch();
    expect(saved.status()).toBe(201);
    await route.abort("connectionreset");
  });
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "無法連線到服務" }),
  ).toBeVisible();
  await page.unroute(saveUrl);
  await page.getByLabel("每次劑量", { exact: true }).fill("6");
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "與目前編輯內容不同" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "前往我的藥品確認", exact: true }),
  ).toBeVisible();
  await page.getByLabel("每次劑量", { exact: true }).fill("1");
  // A second submit after the missing response returns the same row.
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  await expect(page).toHaveURL(/#medications\?saved=[^&]+$/);
  await expect(page.locator(".med-card").filter({ hasText: name })).toHaveCount(
    1,
  );
  await page.goto(`/#add?recognition=${jobId}`);
  await expect(
    page.getByRole("status").filter({ hasText: "這份辨識的 1 筆資料已儲存" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).toBeVisible();
  const login = await request.post("/api/v1/auth/local", {
    data: { uid: "local-owner" },
  });
  const { token } = await login.json();
  const meds = await (
    await request.get("/api/v1/medications", {
      headers: { authorization: "Bearer " + token },
    })
  ).json();
  expect(meds.items.filter((m: any) => m.name === name)).toHaveLength(1);
  expect(recognitionCalls).toBe(1);
});
