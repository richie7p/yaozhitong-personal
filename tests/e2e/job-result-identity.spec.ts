import { expect, test } from "@playwright/test";

const unsafe = "不應顯示的錯誤產品仿單";
const supported = {
  status: "supported",
  claims: [
    {
      text: "合成核對後內容，僅供流程測試。",
      category: "purpose",
      citations: [
        {
          chunkId: "synthetic-source",
          quote: "合成核對後內容，僅供流程測試。",
        },
      ],
    },
  ],
  chunks: [
    {
      id: "synthetic-source",
      licenseNo: "SYNTHETIC-ONLY",
      version: "fixture",
      page: 1,
      start: 0,
      text: "合成核對後內容，僅供流程測試。",
    },
  ],
  quiz: [],
  followups: [],
  sourceVersions: { "SYNTHETIC-ONLY": "fixture" },
  rejectedCount: 0,
  verification: "model_assisted",
};
const job = (id: string) => ({
  id,
  kind: "bundle",
  status: "succeeded",
  createdAt: "2026-10-21T01:00:00Z",
  updatedAt: "2026-10-21T01:00:01Z",
  attempts: 1,
  resultRequiresCheck: true,
  result: { ...supported, claims: [{ ...supported.claims[0], text: unsafe }] },
});
const withheld = (id: string) => ({
  ...job(id),
  identityReviewRequired: true,
  result: {
    ...supported,
    status: "insufficient_data",
    claims: [],
    chunks: [],
    quiz: [],
    sourceVersions: {},
  },
});

test("job summaries never show answers or fetch each result until the requested identity check", async ({
  page,
}) => {
  const reads: string[] = [];
  await page.route("**/api/v1/jobs**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/jobs")
      return route.fulfill({
        json: { items: [job("legacy-source"), job("current-source")] },
      });
    const id = path.split("/").at(-1)!;
    reads.push(id);
    await route.fulfill({
      json:
        id === "legacy-source" ||
        reads.filter((value) => value === id).length > 1
          ? withheld(id)
          : { ...job(id), result: supported },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#jobs");
  await expect(page.locator('[data-job-id="legacy-source"]')).toBeVisible();
  expect(reads).toEqual([]);
  await expect(page.getByText(unsafe, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重新整理", exact: true }).click();
  await expect(page.locator('[data-job-id="current-source"]')).toBeVisible();
  expect(reads).toEqual([]);
  const old = page.locator('[data-job-id="legacy-source"]');
  await old.locator("summary").click();
  await expect(old).toContainText("暫不提供先前仿單回答");
  await expect(
    old.getByRole("link", { name: "補齊產品資料", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(unsafe, { exact: true })).toHaveCount(0);
  expect(reads).toEqual(["legacy-source"]);
  const current = page.locator('[data-job-id="current-source"]');
  await current.locator("summary").click();
  await expect(
    current
      .locator(".claim > div:last-child > p")
      .filter({ hasText: "合成核對後內容" }),
  ).toHaveCount(1);
  expect(reads).toEqual(["legacy-source", "current-source"]);
  const citation = current.locator(".claim details summary");
  await expect(citation).toHaveCount(1);
  await citation.click();
  expect(reads).toHaveLength(2);
  await current.locator("summary").first().click();
  await current.locator("summary").first().click();
  await expect(current).toContainText("暫不提供先前仿單回答");
  expect(reads).toEqual(["legacy-source", "current-source", "current-source"]);
  await expect(current.locator(".claim")).toHaveCount(0);
});

test("job preview can retry failed reads and a late pre-refresh answer cannot reappear", async ({
  page,
}) => {
  let attempt = 0,
    release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/jobs**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/jobs")
      return route.fulfill({ json: { items: [job("guarded-result")] } });
    attempt++;
    if (attempt === 1)
      return route.fulfill({
        status: 503,
        json: { code: "unavailable", message: "合成讀取失敗" },
      });
    if (attempt === 2) {
      await delayed;
      return route.fulfill({
        json: { ...job("guarded-result"), result: supported },
      });
    }
    return route.fulfill({ json: withheld("guarded-result") });
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await page.goto("/#jobs");
    const card = page.locator('[data-job-id="guarded-result"]');
    await card.locator("summary").click();
    await expect(card.getByRole("alert")).toContainText("合成讀取失敗");
    await card
      .getByRole("button", { name: "重新核對結果", exact: true })
      .click();
    await expect.poll(() => attempt).toBe(2);
    await page.getByRole("button", { name: "重新整理", exact: true }).click();
    release();
    await expect(card.locator("details")).not.toHaveAttribute("open", "");
    await expect(
      page.getByText("合成核對後內容，僅供流程測試。", { exact: true }),
    ).toHaveCount(0);
    await card.locator("summary").click();
    await expect(card).toContainText("暫不提供先前仿單回答");
    expect(attempt).toBe(3);
    await expect(page.getByText(unsafe, { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});
