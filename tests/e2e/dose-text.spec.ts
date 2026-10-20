import { expect, test } from "@playwright/test";

test("a confirmed literal amount survives reload and can switch to numeric dosing without a fabricated one", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.getByRole("button", { name: "手動建檔", exact: true }).click();
  const name = "合成用量切換驗收-" + Date.now();
  await page.getByLabel("藥品名稱", { exact: true }).fill(name);
  const text = page.getByLabel("每次用量原文（非數字用量時填寫）", {
    exact: true,
  });
  await text.fill("適量");
  await page.getByLabel("頻次原文", { exact: true }).fill("BID");
  await page.getByLabel("給藥途徑", { exact: true }).fill("外用");
  await page.getByLabel("我已對照藥袋確認藥品與用法").check();
  await page
    .getByRole("button", { name: "確認並儲存藥品", exact: true })
    .click();
  const card = page.locator("article.med-card").filter({ hasText: name });
  await expect(card.locator(".usage-box")).toContainText("適量");
  await page.reload();
  await expect(card.locator(".usage-box")).toContainText("適量");
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const rows = async () =>
    (await (await request.get("/api/v1/medications", { headers })).json())
      .items;
  expect((await rows()).find((m: any) => m.name === name)).toMatchObject({
    doseAmount: null,
    doseUnit: "",
    doseText: "適量",
    confirmed: true,
  });
  await card.getByRole("button", { name: "編輯用法", exact: true }).click();
  await page.getByLabel("每次劑量", { exact: true }).fill("0.5");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await expect(text).toHaveValue("");
  await page
    .getByRole("button", { name: "確認並儲存藥品", exact: true })
    .click();
  await expect(card.locator(".usage-box")).toContainText("0.5 錠");
  await card.getByRole("button", { name: "編輯用法", exact: true }).click();
  await text.fill("薄薄一層");
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("劑量單位", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "確認並儲存藥品", exact: true })
    .click();
  await page.reload();
  await expect(card.locator(".usage-box")).toContainText("薄薄一層");
  expect((await rows()).find((m: any) => m.name === name)).toMatchObject({
    doseAmount: null,
    doseUnit: "",
    doseText: "薄薄一層",
    confirmed: true,
  });
});
