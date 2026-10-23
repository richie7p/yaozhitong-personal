import { expect, test, type Page } from "@playwright/test";
import type { GroundedResult, LearningRecord } from "../../shared/schema";
test.use({serviceWorkers: "block"});
const med = {id: "synthetic-completion-med", name: "合成補充藥品", licenseNo: "SYNTHETIC-COMPLETION", confirmed: true, revision: 1, identityReview: {status: "confirmed", missingFields: []}, frequencyRaw: "QD", doseAmount: 1, doseUnit: "錠"};
const base: GroundedResult = {status: "supported", claims: [{text: "已核對的合成警語，原有內容保留。", category: "warning", kind: "source_plain_language", citations: [{chunkId: "synthetic-source", quote: "【警語】合成原文。"}]}], chunks: [{id: "synthetic-source", licenseNo: med.licenseNo, version: "synthetic-v1", page: 1, start: 0, sourceFormat: "html", text: "【警語】合成原文。"}], quiz: [], followups: [], rejectedCount: 0, sourceVersions: {[med.licenseNo]: "synthetic-v1"}, verification: "model_assisted", plainLanguageCoverage: {scope: "recognized_source_fields", status: "partial", fields: [{fieldId: "synthetic-field", licenseNo: med.licenseNo, sourceSection: "警語", sourceSpanCount: 2, explainedSpanCount: 1, status: "partial", claimIndices: [0], quizIds: [], reason: "verification_incomplete"}]}};
const saved: LearningRecord = {id: "synthetic-completion-old", ownerId: "synthetic-completion-owner", medicationIds: [med.id], medicationRevisions: [{id: med.id, revision: 1}], profileVersion: 1, result: base, answers: {}, createdAt: "2026-10-23T01:00:00Z"};
async function setup(page: Page, partial = true, loseFirst = false) {
  const records = [{...saved, result: partial ? base : {...base, plainLanguageCoverage: {...base.plainLanguageCoverage!, status: "complete" as const}}}];
  const posts: {body: Record<string, unknown>; key: string | undefined}[] = [];
  const unexpected: string[] = [];
  await page.addInitScript(() => sessionStorage.setItem("yzt-local-token", "synthetic-completion-only"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL!).origin) {unexpected.push(request.method()+" "+url.origin+url.pathname);await route.abort();return;}
    if (!url.pathname.startsWith("/api/v1/")) {await route.continue();return;}
    const path = url.pathname.slice("/api/v1".length);
    if (request.method() === "POST" && path === "/bundles") {
      posts.push({body: request.postDataJSON(), key: request.headers()["idempotency-key"]});
      if (loseFirst && posts.length === 1) {await route.abort("connectionreset");return;}
      if (records.length === 1) records.push({...saved, id: "synthetic-completion-new", result: {...base, claims: [{...base.claims[0], text: "補齊後的合成說明。"}], plainLanguageCoverage: {...base.plainLanguageCoverage!, status: "complete"}}, answers: {}});
      await route.fulfill({status: 202, json: {jobId: "synthetic-completion-new"}});return;
    }
    const reads: Record<string, unknown> = {"/config": {mode: "local", ai: false}, "/me": {account: {id: saved.ownerId, eligible: true, admin: false, displayName: "合成補充驗收"}, profile: {displayName: "合成補充驗收"}}, "/medications": {items: [med]}, "/learning": {items: records}, "/jobs/synthetic-completion-new": {id: "synthetic-completion-new", status: "succeeded"}};
    if (request.method() === "GET" && path in reads) {await route.fulfill({json: reads[path]});return;}
    unexpected.push(request.method()+" "+path);await route.abort();
  });
  return {records, posts, unexpected};
}
test("partial teaching can explicitly recover from a lost response while preserving old learning and idempotency", async ({page}) => {
  const fixture = await setup(page, true, true);
  await page.goto("/#learning?record="+saved.id);
  const action = page.getByRole("button", {name: "補齊說明與測驗", exact: true});
  await expect(action).toBeVisible();
  await expect(page.getByText(/會使用 1 次 AI 額度/)).toBeVisible();
  await action.evaluate((button: HTMLButtonElement) => {button.click();button.click();});
  await expect.poll(() => fixture.posts.length).toBe(1);
  await expect(action).toBeEnabled();
  await expect(page.getByText("已核對的合成警語，原有內容保留。", {exact: true})).toBeVisible();
  await action.click();
  await expect(page).toHaveURL(/#learning\?record=synthetic-completion-new/);
  expect(fixture.posts).toHaveLength(2);
  expect(fixture.posts[0].key).toBeTruthy();
  expect(fixture.posts[1].key).toBe(fixture.posts[0].key);
  expect(fixture.posts[1].body).toEqual({medicationIds: [med.id], previousLearningId: saved.id});
  expect(fixture.records[0]).toEqual(saved);
  expect(fixture.unexpected).toEqual([]);
  await expect(page.getByRole("button", {name: "補齊說明與測驗", exact: true})).toHaveCount(0);
});
test("complete saved teaching opens without a paid completion action", async ({page}) => {
  const fixture = await setup(page, false);
  await page.goto("/#medications");
  await page.getByRole("button", {name: "仿單說明", exact: true}).click();
  await expect(page.getByRole("heading", {name: "合成補充藥品｜仿單白話說明"})).toBeVisible();
  await expect(page.getByRole("button", {name: "補齊說明與測驗", exact: true})).toHaveCount(0);
  expect(fixture.posts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
test("leaving while the completed teaching catalogue refreshes does not navigate back later", async ({page}) => {
  const fixture = await setup(page);
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/learning", async (route) => {
    reads++;
    if (reads === 3) await held;
    await route.fallback();
  });
  await page.goto("/#learning?record=" + saved.id);
  await page.getByRole("button", {name: "補齊說明與測驗", exact: true}).click();
  await expect.poll(() => reads).toBe(3);
  await page.locator('a[href="#medications"]:visible').first().click();
  await expect(page).toHaveURL(/#medications$/);
  release();
  await expect(page.getByRole("heading", {name: "我的藥品", exact: true})).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/#medications$/);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.records[0]).toEqual(saved);
  expect(fixture.unexpected).toEqual([]);
});
