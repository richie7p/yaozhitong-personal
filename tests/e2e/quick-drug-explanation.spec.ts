import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { syntheticAiUsage } from "../support/ai-usage-fixture";

test.use({ serviceWorkers: "block" });
const photo = {
  name: "synthetic-package.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC", "base64"),
};
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI 使用次數" })).toBeVisible();
}
async function access(request: APIRequestContext) {
  const response = await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } });
  const { token } = await response.json();
  return { authorization: "Bearer " + token };
}

test("ordinary photo can be explained without creating a medication or confirming identity", async ({ page, request }, info) => {
  const headers = await access(request);
  const before = (await (await request.get("/api/v1/medications", { headers })).json()).items;
  const writes: string[] = [];
  page.on("request", r => {
    if (r.method() === "POST") writes.push(new URL(r.url()).pathname);
  });
  await login(page);
  await page.goto("/#add");
  await expect(page.getByRole("heading", { name: "一般藥品快速查詢", exact: true })).toBeVisible();
  await page.getByLabel("一般藥品照片", { exact: true }).setInputFiles(photo);
  await page.getByRole("button", { name: "辨識藥品照片", exact: true }).click();
  const explain = page.getByRole("button", { name: "AI 藥品解說", exact: true }).first();
  await expect(explain).toBeEnabled({ timeout: 30000 });
  const accepted = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/v1/explanations"));
  await explain.click();
  expect((await accepted).status()).toBe(202);
  await expect(page.getByRole("region", { name: "AI 藥品解說與問答", exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.locator("body")).toContainText("流程測試片 5mg");
  const after = (await (await request.get("/api/v1/medications", { headers })).json()).items;
  expect(after.map((m: any) => m.id).sort()).toEqual(before.map((m: any) => m.id).sort());
  expect(writes.some(p => p === "/api/v1/medications" || /\/recognitions\/[^/]+\/medications\//.test(p))).toBe(false);
  expect(writes.filter(p => p === "/api/v1/explanations")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.screenshot({ path: info.outputPath("quick-explanation.png"), fullPage: true });
  await page.goto("/#jobs");
  await expect(page.getByText("一般藥品解說", { exact: true }).first()).toBeVisible();
});

test("saved product pending review and usage can open AI explanation without changing those statuses", async ({ page, request }) => {
  const headers = await access(request);
  const response = await request.post("/api/v1/medications", {
    headers,
    data: { name: "尚待核對測試軟膏 " + Date.now(), form: "軟膏", confirmed: false },
  });
  expect(response.status()).toBe(201);
  const medication = await response.json();
  await login(page);
  await page.goto("/#medications");
  const card = page.locator(`[data-medication-id="${medication.id}"]`);
  await expect(card).toContainText("產品待核對");
  await expect(card).toContainText("個人用法未確認");
  const button = card.getByRole("button", { name: "AI 藥品解說", exact: true });
  await expect(button).toBeEnabled();
  const accepted = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/v1/explanations"));
  await button.click();
  const admitted = await accepted;
  expect(admitted.status()).toBe(202);
  expect(admitted.request().postDataJSON()).toEqual({ medicationId: medication.id });
  await expect(page.getByRole("region", { name: "AI 藥品解說與問答", exact: true })).toBeVisible({ timeout: 30000 });
  const stored = (await (await request.get("/api/v1/medications", { headers })).json()).items.find((m: any) => m.id === medication.id);
  expect(stored.confirmed).toBe(false);
  expect(stored.identityReview.status).not.toBe("confirmed");
});

test("quick explanation displays cited information, uncertainty and the new quota without saving a drug", async ({ page }, info) => {
  let used = 0;
  const payloads: unknown[] = [];
  const at = new Date();
  const result = {
    status: "supported", claims: [], chunks: [], quiz: [], followups: [], rejectedCount: 0,
    sourceVersions: {}, verification: "model_assisted", mode: "general_information", identityStatus: "unverified",
    queriedProduct: { name: "合成測試軟膏", strength: "1%", form: "軟膏", licenseNo: "" },
    catalogReference: {
      sourceUrl: "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=36&logType=5",
      catalogVersion: "synthetic-catalog", licenseNo: "SYNTHETIC-CATALOG-ONLY",
      nameZh: "合成測試軟膏", nameEn: "Synthetic ointment", strength: "1%", form: "軟膏",
      ingredients: ["synthetic-only"], matchBasis: "complete_name",
    },
    assistance: {
      version: "reliable-reference-v6", checkedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 86400000).toISOString(), searchState: "found", missingLicenses: [],
      sources: [{ id: "synthetic-source", title: "合成醫療資料（僅供測試）", url: "https://www.ntuh.gov.tw/synthetic-reference", kind: "hospital" }],
      claims: [{ text: "此合成解說只用來驗證來源連結與查詢流程，不是醫療建議。", sourceIds: ["synthetic-source"], basis: "reference" }],
      uncertainties: ["產品身分尚未核對；以下僅為查詢名稱對應的一般資訊。"],
    },
  };
  await page.route("**/api/v1/ai/usage", r => r.fulfill({ json: syntheticAiUsage(used) }));
  await page.route("**/api/v1/explanations", r => {
    payloads.push(r.request().postDataJSON()); used++;
    return r.fulfill({ status: 202, json: { jobId: "synthetic-general-info", status: "queued" } });
  });
  await page.route("**/api/v1/jobs/synthetic-general-info", r => r.fulfill({ json: { id: "synthetic-general-info", kind: "explanation", status: "succeeded", result } }));
  await login(page);
  await page.goto("/#add");
  await page.getByText("直接輸入或修正藥名", { exact: true }).click();
  await page.getByLabel("查詢藥名", { exact: true }).fill("合成測試軟膏");
  await page.getByRole("button", { name: "查詢藥品解說", exact: true }).click();
  const explanation = page.getByRole("region", { name: "AI 藥品解說與問答", exact: true });
  await expect(explanation).toContainText("此合成解說只用來驗證來源連結");
  await expect(explanation.getByRole("link", { name: /合成醫療資料/ })).toHaveAttribute("href", "https://www.ntuh.gov.tw/synthetic-reference");
  await expect(explanation).toContainText("產品身分尚未核對");
  await page.getByText("查得的官方登記資料", { exact: true }).click();
  await expect(page.getByRole("link", { name: "開啟食藥署藥品登記資料", exact: true })).toHaveAttribute("href", /https:\/\/data\.fda\.gov\.tw\//);
  await expect(page.locator(".drug-explanation")).toContainText("尚未確認手上產品");
  const quota = page.getByRole("region", { name: "AI 使用次數" });
  await expect(quota).toContainText("今日 AI 還可使用 29 次");
  await expect(quota).toContainText("每日 30 次");
  await expect(quota).toContainText("每日 2000 次");
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ query: { name: "合成測試軟膏" } });
  await page.screenshot({ path: info.outputPath("quick-cited-information.png"), fullPage: true });
});
