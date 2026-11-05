import { expect, test, type Page } from "@playwright/test";
import { ASSISTANCE_VERSION } from "../../shared/assistance";
import { DRUG_EXPLANATION_VERSION } from "../../shared/drug-explanation";
import { syntheticAiUsage } from "../support/ai-usage-fixture";

test.use({ serviceWorkers: "block" });

const medication = {
  id: "synthetic-basic-info-med", name: "合成基本資訊測試眼藥膏",
  licenseNo: "SYNTHETIC-BASIC-INFO", strength: "1%", form: "眼藥膏",
  confirmed: true, revision: 1, doseAmount: 1, doseUnit: "次", frequencyRaw: "QD",
  identityReview: { status: "confirmed", missingFields: [] },
};
const checkedAt = new Date().toISOString();
const referenceClaim = {
  text: "用途：合成測試用途。注意事項：合成測試注意事項；這是流程測試內容。",
  basis: "reference", sourceIds: ["synthetic-reference"],
};
const answered = {
  status: "supported", claims: [], chunks: [], quiz: [], followups: [],
  rejectedCount: 0, sourceVersions: {}, verification: "model_assisted",
  mode: "general_information", explanationVersion: DRUG_EXPLANATION_VERSION,
  queriedProduct: { name: medication.name, strength: medication.strength, form: medication.form },
  identityStatus: "unverified",
  assistance: {
    version: ASSISTANCE_VERSION, checkedAt,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    searchState: "found", missingLicenses: [],
    sources: [{ id: "synthetic-reference", title: "合成醫院資料（流程測試）", url: "https://www.ntuh.gov.tw/synthetic-basic-info", kind: "hospital" }],
    claims: [referenceClaim], uncertainties: ["本站未收錄完整產品仿單。"],
  },
};

async function mockRecovery(page: Page, savedLabels: boolean) {
  const payloads: unknown[] = [], unexpected: string[] = [];
  const empty = {
    ...answered, status: "insufficient_data",
    // Extra stored fields must never become a new public search input.
    queriedProduct: { ...answered.queriedProduct, patientNote: "SYNTHETIC-NOT-FOR-SEARCH" },
    assistance: { ...answered.assistance, searchState: "not_found", claims: [], sources: [] },
  };
  const labelResult = {
    ...answered,
    assistance: {
      ...answered.assistance, searchState: "not_found", sources: [],
      claims: [{ text: "你記錄的 QD 是每日一次。", basis: "user_label", sourceIds: [] }],
    },
  };
  await page.addInitScript(() => sessionStorage.setItem("yzt-local-token", "synthetic-basic-info-user"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice("/api/v1".length);
    if (route.request().method() === "POST" && path === "/explanations") {
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { jobId: "synthetic-new-explanation", status: "queued" } });
    }
    const reads: Record<string, unknown> = {
      "/config": { mode: "local", ai: true, dailyUserLimit: 30, dailyGlobalLimit: 2000 },
      "/me": { account: { id: "synthetic-basic-info-user", eligible: true, admin: false }, profile: {} },
      "/ai/usage": syntheticAiUsage(payloads.length),
      "/medications": { items: [medication] },
      "/learning": { items: savedLabels ? [{ id: "synthetic-label-only", medicationIds: [medication.id], result: labelResult, answers: {}, createdAt: checkedAt }] : [] },
      "/jobs": { items: [{ id: "synthetic-old-empty", kind: "explanation", status: "succeeded", result: null, attempts: 1, createdAt: checkedAt, updatedAt: checkedAt }] },
      "/jobs/synthetic-old-empty": { id: "synthetic-old-empty", kind: "explanation", status: "succeeded", result: empty },
      "/jobs/synthetic-new-explanation": { id: "synthetic-new-explanation", kind: "explanation", status: "succeeded", result: answered },
    };
    if (route.request().method() === "GET" && path in reads)
      return route.fulfill({ json: reads[path] });
    unexpected.push(route.request().method() + " " + path);
    return route.abort();
  });
  return { payloads, unexpected };
}

test("saved dose-label-only answer cannot suppress basic medication information", async ({ page }) => {
  const { payloads, unexpected } = await mockRecovery(page, true);
  await page.goto("/#medications");
  await page.locator(`[data-medication-id="${medication.id}"]`)
    .getByRole("button", { name: "AI 藥品解說", exact: true }).click();
  const answer = page.getByRole("region", { name: "AI 藥品解說與問答", exact: true });
  await expect(answer).toContainText(referenceClaim.text);
  await expect(answer).not.toContainText("你記錄的 QD");
  await expect(answer.getByRole("link", { name: /合成醫院資料/ })).toBeVisible();
  expect(payloads).toEqual([{ medicationId: medication.id }]);
  expect(unexpected).toEqual([]);
});

test("an empty completed result can explicitly search again with only its public drug query", async ({ page }) => {
  const { payloads, unexpected } = await mockRecovery(page, false);
  await page.goto("/#jobs");
  await page.getByText("查看一般藥品解說", { exact: true }).click();
  await expect(page.getByText("本次未取得基本用藥資訊。", { exact: false })).toBeVisible();
  expect(payloads).toEqual([]);
  await page.getByRole("button", { name: "重新查詢基本用藥資訊", exact: true }).click();
  const answer = page.getByRole("region", { name: "AI 藥品解說與問答", exact: true });
  await expect(answer).toContainText(referenceClaim.text);
  await expect(page.getByRole("button", { name: "重新查詢基本用藥資訊", exact: true })).toHaveCount(0);
  expect(payloads).toEqual([{ query: answered.queriedProduct }]);
  expect(unexpected).toEqual([]);
});
