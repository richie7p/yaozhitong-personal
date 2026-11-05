import { expect, test, type Locator, type Page } from "@playwright/test";
import { syntheticAiUsage } from "../support/ai-usage-fixture";
import type { GroundedResult } from "../../shared/schema";

// Synthetic display fixtures only. No account, model, source download, or
// external API is involved; every API read is fulfilled in the browser.
const medication = {
  id: "synthetic-source-review-medication",
  name: "合成來源待整理藥品",
  licenseNo: "SYNTHETIC-SOURCE-REVIEW",
  confirmed: true,
  revision: 1,
  identityReview: {
    status: "confirmed",
    message: "合成產品已核對。",
    missingFields: [],
  },
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
};
const version = "0123456789abcdef";
const sourceUrl = "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2";
const pendingMessage = "AI 說明暫待整理，理解測驗尚未提供";
const pendingResult: GroundedResult = {
  status: "insufficient_data",
  claims: [],
  chunks: [],
  quiz: [],
  followups: [],
  rejectedCount: 0,
  sourceVersions: { [medication.licenseNo]: version },
  verification: "model_assisted",
  sourceReview: {
    reason: "safety_sections_pending",
    sources: [{ licenseNo: medication.licenseNo, version, sourceUrl }],
  },
};
const recordId = "synthetic-source-review-record";
const generalId = "synthetic-general-fallback";
const generalText =
  "合成一般解說：此處只驗證用途與注意事項能顯示，不是醫療建議。";
function generalResult(searchState = "found", withClaims = true) {
  return {
    ...pendingResult,
    sourceReview: undefined,
    sourceVersions: {},
    status: withClaims ? "supported" : "insufficient_data",
    mode: "general_information",
    identityStatus: "confirmed",
    queriedProduct: { name: medication.name, strength: "", form: "錠" },
    assistance: {
      version: "reliable-reference-v6",
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      searchState,
      missingLicenses: [],
      sources: [
        {
          id: "synthetic-general-source",
          title: "合成一般資訊來源",
          url: sourceUrl,
          kind: "official",
        },
        {
          id: "unsafe-source",
          title: "不可開啟來源",
          url: "https://fda.gov.tw.evil.invalid/source",
          kind: "official",
        },
      ],
      claims: withClaims
        ? [
            {
              text: generalText,
              basis: "reference",
              sourceIds: ["synthetic-general-source"],
            },
          ]
        : [],
      uncertainties: ["此為合成一般資訊，未確認個人適用性。"],
    },
  };
}
async function mockGeneralFallback(page: Page, result = generalResult()) {
  const requests: unknown[] = [];
  await page.route("**/api/v1/explanations", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { jobId: generalId, status: "queued" },
    });
  });
  await page.route("**/api/v1/jobs/" + generalId, (route) =>
    route.fulfill({
      json: {
        id: generalId,
        kind: "explanation",
        status: "succeeded",
        result,
      },
    }),
  );
  return requests;
}

async function mockSavedReview(
  page: Page,
  result = pendingResult,
  sourceUpdated = false,
) {
  const unexpected: string[] = [];
  const reads: string[] = [];
  const record = {
    id: recordId,
    ownerId: "synthetic-source-review-owner",
    medicationIds: [medication.id],
    medicationRevisions: [{ id: medication.id, revision: 1 }],
    profileVersion: 0,
    result,
    answers: {},
    createdAt: "2026-10-23T01:00:00Z",
  };
  const job = {
    id: recordId,
    kind: "bundle",
    status: "succeeded",
    attempts: 1,
    error: null,
    createdAt: record.createdAt,
    updatedAt: "2026-10-23T01:00:01Z",
    sourceReviewPending: !!result.sourceReview && !sourceUpdated,
    sourceUpdateRequired: sourceUpdated,
    sourceReadingPending: !!result.sourceReading,
    resultRequiresCheck: true,
    result: null,
  };
  await page.addInitScript(() => {
    sessionStorage.setItem("yzt-local-token", "synthetic-source-review-only");
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:5190") {
      unexpected.push(request.method() + " " + url.origin + url.pathname);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      await route.continue();
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/v1/ai/usage": syntheticAiUsage(),
      "/api/v1/config": { mode: "local", ai: false },
      "/api/v1/me": {
        account: {
          id: record.ownerId,
          displayName: "合成待整理使用者",
          eligible: true,
          admin: false,
        },
        profile: { displayName: "合成待整理使用者" },
      },
      "/api/v1/medications": { items: [medication] },
      "/api/v1/learning": { items: [record] },
      "/api/v1/chat": {
        items: [{ ...record, question: "這份合成仿單的注意事項是什麼？" }],
      },
      "/api/v1/jobs": { items: [job] },
      ["/api/v1/jobs/" + recordId]: { ...job, result },
    };
    if (request.method() === "GET" && url.pathname in responses) {
      reads.push(url.pathname);
      await route.fulfill({ json: responses[url.pathname] });
      return;
    }
    unexpected.push(request.method() + " " + url.pathname);
    await route.abort();
  });
  return { unexpected, reads };
}

async function expectPendingSource(container: Locator, page: Page) {
  await expect(container).toContainText(pendingMessage);
  await expect(container.locator(".quiz, .claim, blockquote")).toHaveCount(0);
  await expect(
    container.getByRole("heading", { name: "警語與注意事項", exact: true }),
  ).toHaveCount(0);
  const summary = container.getByText("查看官方仿單原文", { exact: true });
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Enter");
  const link = container.getByRole("link", {
    name: "開啟官方仿單原文",
    exact: true,
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", sourceUrl);
  await expect(container).toContainText(medication.licenseNo);
  await expect(container).not.toContainText(version);
}

test("saved pending learning survives reload with official source access and no completed quiz", async ({
  page,
}) => {
  const { unexpected, reads } = await mockSavedReview(page);
  await page.goto(`/#learning?record=${recordId}&section=quiz`);
  const record = page.locator(`[data-learning-id="${recordId}"]`);
  await expect(record).toBeVisible();
  await expect(record.getByText("尚無測驗", { exact: true })).toBeVisible();
  await expectPendingSource(record, page);
  await expect(record.getByRole("radio")).toHaveCount(0);
  await expect(record.getByText("測驗已完成", { exact: true })).toHaveCount(0);
  await page.reload();
  await expectPendingSource(record, page);
  await expect(record.getByText("尚無測驗", { exact: true })).toBeVisible();
  expect(reads.filter((path) => path === "/api/v1/learning")).toHaveLength(2);
  await page.goto("/#learning");
  const directory = page.locator(
    `.learning-index-card[data-learning-id="${recordId}"]`,
  );
  await expect(directory).toContainText("尚無測驗");
  await expect(directory.getByText("測驗已完成", { exact: true })).toHaveCount(
    0,
  );
  expect(unexpected).toEqual([]);
});

test("a saved pending leaflet leads to general explanation without changing the medication or resubmitting its bundle", async ({
  page,
}) => {
  const { unexpected, reads } = await mockSavedReview(page);
  const generalRequests = await mockGeneralFallback(page);
  await page.goto("/#medications");
  const card = page.locator(`.med-card[data-medication-id="${medication.id}"]`);
  const detail = page.locator(".medication-detail");
  for (let opening = 1; opening <= 2; opening++) {
    await expect(card).toBeVisible();
    await expect(
      card.getByRole("button", { name: "排定提醒", exact: true }),
    ).toBeEnabled();
    await expect(card.locator(".usage-box strong")).toHaveText("1 錠");
    await card
      .getByRole("button", { name: "AI 藥品解說", exact: true })
      .click();
    await expect(detail).toContainText(generalText);
    await expect(detail).toContainText("一般藥品資訊");
    await expect(detail).not.toContainText("尚未核對完整產品仿單");
    await expect(
      detail.getByRole("link", { name: "繼續理解測驗", exact: true }),
    ).toHaveCount(0);
    expect(reads.filter((path) => path === "/api/v1/learning")).toHaveLength(
      opening,
    );
    expect(generalRequests).toHaveLength(opening);
    expect(generalRequests[opening - 1]).toEqual({
      medicationId: medication.id,
    });
    // Any other POST, including /bundles or medication edits, remains blocked.
    expect(unexpected).toEqual([]);
    if (opening === 1) await page.reload();
  }
});

for (const code of ["source_unavailable", "source_requires_review"] as const)
  test(`a confirmed product falls back to general information when the leaflet request returns ${code}`, async ({
    page,
  }) => {
    const { unexpected } = await mockSavedReview(page);
    const requests = await mockGeneralFallback(page);
    let bundleCalls = 0;
    await page.route("**/api/v1/learning", (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.route("**/api/v1/bundles", async (route) => {
      bundleCalls++;
      await route.fulfill({
        status: 422,
        json: { code, message: "合成仿單尚待整理。" },
      });
    });
    await page.goto("/#medications");
    const card = page.locator(`[data-medication-id="${medication.id}"]`);
    await card
      .getByRole("button", { name: "AI 藥品解說", exact: true })
      .click();
    await expect(page.locator(".medication-detail")).toContainText(generalText);
    await expect(card).toContainText("產品已核對");
    await expect(card).toContainText("用法已確認");
    expect(bundleCalls).toBe(1);
    expect(requests).toEqual([{ medicationId: medication.id }]);
    expect(unexpected).toEqual([]);
  });

test("an accepted leaflet task with no usable claims falls back once to general information", async ({
  page,
}) => {
  const { unexpected } = await mockSavedReview(page);
  const requests = await mockGeneralFallback(page);
  let submitted = false;
  await page.route("**/api/v1/learning", (route) =>
    route.fulfill({
      json: {
        items: submitted
          ? [
              {
                id: recordId,
                medicationIds: [medication.id],
                result: pendingResult,
                answers: {},
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/v1/bundles", async (route) => {
    submitted = true;
    await route.fulfill({
      status: 202,
      json: { jobId: recordId, status: "queued" },
    });
  });
  await page.goto("/#medications");
  await page.getByRole("button", { name: "AI 藥品解說", exact: true }).click();
  await expect(page.locator(".medication-detail")).toContainText(generalText);
  expect(requests).toEqual([{ medicationId: medication.id }]);
  expect(unexpected).toEqual([]);
});

test("an available saved explanation is preferred to a pending record without another AI request", async ({
  page,
}) => {
  const { unexpected } = await mockSavedReview(page);
  await page.route("**/api/v1/learning", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: recordId,
            medicationIds: [medication.id],
            result: pendingResult,
            answers: {},
          },
          {
            id: "synthetic-available-record",
            medicationIds: [medication.id],
            result: generalResult(),
            answers: {},
          },
        ],
      },
    }),
  );
  await page.goto("/#medications");
  await page.getByRole("button", { name: "AI 藥品解說", exact: true }).click();
  await expect(page.locator(".medication-detail")).toContainText(generalText);
  expect(unexpected).toEqual([]);
});

test("quota rejection never starts a second AI request", async ({ page }) => {
  const { unexpected } = await mockSavedReview(page);
  const requests = await mockGeneralFallback(page);
  await page.route("**/api/v1/learning", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/v1/bundles", (route) =>
    route.fulfill({
      status: 429,
      json: { code: "quota_exceeded", message: "今日 AI 使用額度已達上限。" },
    }),
  );
  await page.route(
    "**/api/v1/medications/" + medication.id + "/source",
    (route) =>
      route.fulfill({
        json: {
          medicationId: medication.id,
          medicationRevision: 1,
          state: "missing",
          sources: [],
        },
      }),
  );
  await page.goto("/#medications");
  await page.getByRole("button", { name: "AI 藥品解說", exact: true }).click();
  await expect(page.locator(".medication-detail")).toContainText("官方來源");
  await expect(page.getByRole("alert")).toContainText("使用額度已達上限");
  expect(requests).toEqual([]);
  expect(unexpected).toEqual([]);
});

for (const [state, message] of [
  ["found", "已找到參考資料，但尚未整理出有充分依據的用途與注意事項"],
  ["not_found", "這次沒有找到與查詢名稱相符、可引用的藥品資料"],
  ["unavailable", "這次網路來源搜尋或讀取未完成"],
  ["generation_error", "已找到參考資料，但這次 AI 整理未完成"],
] as const)
  test(`empty general information explains ${state} and exposes only safe source links`, async ({
    page,
  }) => {
    const { unexpected } = await mockSavedReview(page);
    const result = generalResult(
      state === "generation_error" ? "found" : state,
      false,
    );
    if (state === "generation_error")
      result.assistance.uncertainties.push(
        "這次 AI 回答格式無法核對，未顯示生成內容。",
      );
    await mockGeneralFallback(page, result);
    await page.goto("/#medications");
    await page
      .getByRole("button", { name: "AI 藥品解說", exact: true })
      .click();
    const answer = page.getByRole("region", {
      name: "AI 藥品解說與問答",
      exact: true,
    });
    await expect(answer).toContainText(message);
    await expect(answer.locator(".assistance-claim")).toHaveCount(0);
    await expect(answer).not.toContainText("尚未核對完整產品仿單");
    await expect(
      answer.getByRole("link", { name: /合成一般資訊來源/ }),
    ).toHaveAttribute("href", sourceUrl);
    await expect(
      answer.getByRole("link", { name: /不可開啟來源/ }),
    ).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });

test("pending chat answers explain the hold and expose official source without invented claims", async ({
  page,
}) => {
  const { unexpected } = await mockSavedReview(page);
  await page.goto("/#chat");
  const answer = page.locator(".chat-answer");
  await expectPendingSource(answer, page);
  await expect(answer.getByText("已附仿單依據", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    answer.getByText("目前仿單資料不足", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expectPendingSource(answer, page);
  expect(unexpected).toEqual([]);
});

test("job history labels pending content truthfully and checks source links again after reload", async ({
  page,
}) => {
  const { unexpected, reads } = await mockSavedReview(page);
  await page.goto("/#jobs");
  const card = page.locator(`[data-job-id="${recordId}"]`);
  const jobRead = "/api/v1/jobs/" + recordId;
  await expect(card.getByText("AI 內容待整理", { exact: true })).toBeVisible();
  await expect(card.getByText("已完成", { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "使用原輸入重試" }),
  ).toHaveCount(0);
  expect(reads).not.toContain(jobRead);
  await card.locator("summary").first().click();
  await expectPendingSource(card, page);
  expect(reads.filter((path) => path === jobRead)).toHaveLength(1);
  await page.reload();
  await expect(card.getByText("AI 內容待整理", { exact: true })).toBeVisible();
  expect(reads.filter((path) => path === jobRead)).toHaveLength(1);
  await card.locator("summary").first().click();
  await expectPendingSource(card, page);
  expect(reads.filter((path) => path === jobRead)).toHaveLength(2);
  expect(unexpected).toEqual([]);
});

test("unsafe source URLs never become links while verified official access remains available", async ({
  page,
}) => {
  const unsafeUrls = [
    "javascript:alert('synthetic')",
    "http://mcp.fda.gov.tw/synthetic",
    "https://mcp.fda.gov.tw.evil.invalid/synthetic",
    "https://mcp.fda.gov.tw@evil.invalid/synthetic",
    "https://evil.invalid/synthetic",
    "https://user:pass@mcp.fda.gov.tw/synthetic",
    "https://mcp.fda.gov.tw:444/synthetic",
  ];
  const result: GroundedResult = {
    ...pendingResult,
    sourceReview: {
      reason: "safety_sections_pending",
      sources: [
        ...pendingResult.sourceReview!.sources,
        ...unsafeUrls.map((url, index) => ({
          licenseNo: `SYNTHETIC-UNSAFE-SOURCE-${index}`,
          version,
          sourceUrl: url,
        })),
      ],
    },
  };
  const { unexpected } = await mockSavedReview(page, result);
  await page.goto("/#chat");
  const answer = page.locator(".chat-answer");
  await expectPendingSource(answer, page);
  const sourceLinks = answer.getByRole("link", {
    name: "開啟官方仿單原文",
    exact: true,
  });
  await expect(sourceLinks).toHaveCount(1);
  const hrefs = await answer
    .locator("a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  for (const unsafe of unsafeUrls) expect(hrefs).not.toContain(unsafe);
  expect(unexpected).toEqual([]);
});

test("a genuinely missing source keeps the insufficient-data state without a fabricated official link", async ({
  page,
}) => {
  const { sourceReview: _unused, ...missingSource } = pendingResult;
  const { unexpected } = await mockSavedReview(page, {
    ...missingSource,
    sourceVersions: {},
  });
  await page.goto("/#chat");
  const answer = page.locator(".chat-answer");
  await expect(
    answer.getByText("目前仿單資料不足", { exact: true }),
  ).toBeVisible();
  await expect(answer).not.toContainText(pendingMessage);
  await expect(
    answer.getByText("查看官方仿單原文", { exact: true }),
  ).toHaveCount(0);
  await expect(
    answer.getByRole("link", { name: "開啟官方仿單原文", exact: true }),
  ).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

const longCanonicalText =
  "警語：\n" +
  Array.from(
    { length: 80 },
    (_, index) =>
      `${index + 1}. 以下為合成原文，僅供軟體展示核對；請完整保留本段與下一段。`,
  ).join("\n");
const shortCanonicalText = "注意事項：本文件僅供合成軟體測試。";
function canonicalResult(): GroundedResult {
  return {
    ...pendingResult,
    status: "supported",
    sourceReview: undefined,
    claims: [longCanonicalText, shortCanonicalText].map((text, index) => ({
      text,
      kind: "source_exact_safety",
      category: "warning",
      citations: [{ chunkId: `synthetic-canonical-${index}`, quote: text }],
    })),
    chunks: [longCanonicalText, shortCanonicalText].map((text, index) => ({
      id: `synthetic-canonical-${index}`,
      licenseNo: medication.licenseNo,
      version,
      page: index + 1,
      start: 0,
      text,
    })),
    quiz: [
      {
        id: "synthetic-short-quiz",
        q: "這份合成文件用於什麼？",
        options: ["軟體測試", "個人診斷"],
        answer: 0,
        explain: shortCanonicalText,
        citations: [
          { chunkId: "synthetic-canonical-1", quote: shortCanonicalText },
        ],
      },
    ],
    safetyCoverage: {
      scope: "recognized_source_sections",
      assessmentScope: "one_key_point_per_section",
      status: "partial",
      sourceSectionCount: 2,
      coveredSectionCount: 2,
      quizCoveredSectionCount: 1,
      sections: [
        {
          id: "long",
          chunkId: "synthetic-canonical-0",
          sourceSection: "警語",
          claimIndex: 0,
          quizIds: [],
        },
        {
          id: "short",
          chunkId: "synthetic-canonical-1",
          sourceSection: "注意事項",
          claimIndex: 1,
          quizIds: ["synthetic-short-quiz"],
        },
      ],
    },
  };
}

for (const view of ["reading", "chat"] as const)
  test(`long canonical safety text remains labeled and readable in ${view} with truthful partial quiz coverage`, async ({
    page,
  }) => {
    const { unexpected } = await mockSavedReview(page, canonicalResult());
    await page.goto(
      view === "chat"
        ? "/#chat"
        : `/#learning?record=${recordId}&section=reading`,
    );
    const content = page.locator(
      view === "chat" ? ".chat-answer" : ".evidence",
    );
    const claim = content.locator(".claim").first();
    await expect(
      claim.getByText("仿單警語原文", { exact: true }),
    ).toBeVisible();
    const paragraph = claim.locator("p").last();
    await expect(paragraph).toHaveText(longCanonicalText);
    expect(await paragraph.textContent()).toBe(longCanonicalText);
    await expect(paragraph).toHaveCSS("white-space", "pre-line");
    if (view === "reading") {
      await expect(content).toContainText(
        "已列出 2 個警語與注意事項欄目，其中 1 個有理解題",
      );
      await expect(content).toContainText("理解測驗尚未涵蓋所有警語欄目");
      await page.goto(`/#learning?record=${recordId}&section=quiz`);
      await expect(page.locator(".quiz")).toContainText(
        "理解測驗僅涵蓋部分警語欄目",
      );
    }
    expect(unexpected).toEqual([]);
  });

for (const reason of [
  "model_source_capacity",
  "requested_topic_coverage",
] as const)
  for (const view of ["chat", "learning", "jobs", "medications"] as const)
    test(`preserved source ${reason} notice survives reload in ${view} without implying a complete AI answer`, async ({
      page,
    }) => {
      const result: GroundedResult = {
        ...pendingResult,
        sourceReview: undefined,
        chunks: canonicalResult().chunks,
        sourceReading: {
          reason,
          sections: [
            {
              sourceSection: "警語",
              citations: [
                { chunkId: "synthetic-canonical-0", quote: longCanonicalText },
              ],
            },
          ],
          sources: pendingResult.sourceReview!.sources,
        },
      };
      const { unexpected } = await mockSavedReview(page, result);
      const generalRequests = view === "medications"
        ? await mockGeneralFallback(page)
        : [];
      await page.goto(
        view === "learning"
          ? `/#learning?record=${recordId}&section=reading`
          : `/#${view}`,
      );
      for (let visit = 0; visit < 2; visit++) {
        if (visit) await page.reload();
        if (view === "jobs") {
          const card = page.locator(`[data-job-id="${recordId}"]`);
          await expect(
            card.getByText("部分內容尚未整理", { exact: true }),
          ).toBeVisible();
          await expect(card.getByText("已完成", { exact: true })).toHaveCount(
            0,
          );
          await card.locator("summary").first().click();
        }
        if (view === "medications") {
          await page
            .locator(".med-card")
            .getByRole("button", { name: "AI 藥品解說", exact: true })
            .click();
          await expect(page.getByText(generalText, { exact: true })).toBeVisible();
          await expect(page.locator(".source-reading, .quiz")).toHaveCount(0);
          continue;
        }
        const notice = page.locator(".source-reading");
        await expect(
          notice.getByRole("heading", {
            name: "部分內容尚未整理",
            exact: true,
          }),
        ).toBeVisible();
        await expect(notice).toContainText("本次回答尚未完整涵蓋這些內容");
        if (reason === "requested_topic_coverage")
          await expect(notice).toContainText(
            "本次問題所問的部分安全主題尚未獲得完整回答",
          );
        await notice
          .getByText("警語：展開完整仿單原文", { exact: true })
          .click();
        const quote = notice.locator("blockquote");
        await expect(quote).toBeVisible();
        await expect(quote).toContainText(longCanonicalText);
        await expect(quote).toHaveCSS("white-space", "pre-wrap");
        await notice.getByText("查看官方仿單原文", { exact: true }).click();
        await expect(
          notice.getByRole("link", { name: "開啟官方仿單原文", exact: true }),
        ).toHaveAttribute("href", sourceUrl);
        await expect(page.locator(".quiz")).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "完整警語", exact: true }),
        ).toHaveCount(0);
      }
      if (view === "medications") expect(generalRequests).toHaveLength(2);
      expect(unexpected).toEqual([]);
    });

test("a field omitted by the reading limit exposes its official source without partial or invented text", async ({
  page,
}) => {
  const result: GroundedResult = {
    ...pendingResult,
    sourceReview: undefined,
    sourceReading: {
      reason: "model_source_capacity",
      sections: [],
      unavailableSections: [
        { sourceSection: "注意事項", licenseNo: medication.licenseNo, version },
      ],
      sources: pendingResult.sourceReview!.sources,
    },
  };
  const { unexpected } = await mockSavedReview(page, result);
  await page.goto("/#chat");
  const notice = page.locator(".source-reading");
  await expect(notice).toContainText(
    "本次未載入以下欄位的完整原文，請使用官方仿單原文查看",
  );
  await expect(notice).toContainText("注意事項");
  await expect(notice.locator("blockquote")).toHaveCount(0);
  await expect(notice).not.toContainText("下方保留完整仿單原文，可展開查閱");
  await notice.getByText("查看官方仿單原文", { exact: true }).click();
  await expect(
    notice.getByRole("link", { name: "開啟官方仿單原文", exact: true }),
  ).toHaveAttribute("href", sourceUrl);
  expect(unexpected).toEqual([]);
});

test("a requested topic with no matching field is separate from an omitted canonical field and never implies no risk", async ({
  page,
}) => {
  const result: GroundedResult = {
    ...pendingResult,
    sourceReview: undefined,
    sourceReading: {
      reason: "requested_topic_coverage",
      sections: [],
      missingTopics: [
        { topic: "交互作用", licenseNo: medication.licenseNo, version },
      ],
      sources: pendingResult.sourceReview!.sources,
    },
  };
  const { unexpected } = await mockSavedReview(page, result);
  await page.goto("/#chat");
  const notice = page.locator(".source-reading");
  await expect(notice).toContainText(
    "本次問題所問的部分安全主題尚未獲得完整回答",
  );
  await expect(notice).toContainText(
    "尚未找到可核對的完整仿單欄位，不能據此判定沒有相關風險",
  );
  await expect(notice).toContainText("交互作用");
  await expect(notice).not.toContainText("本次未載入以下欄位的完整原文");
  await expect(notice.locator("blockquote")).toHaveCount(0);
  await expect(page.locator(".quiz")).toHaveCount(0);
  await notice.getByText("查看官方仿單原文", { exact: true }).click();
  await expect(
    notice.getByRole("link", { name: "開啟官方仿單原文", exact: true }),
  ).toHaveAttribute("href", sourceUrl);
  await page.reload();
  await expect(page.locator(".source-reading")).toContainText("交互作用");
  expect(unexpected).toEqual([]);
});

test("updated source reader directs old parser holds to regenerate without requesting product re-identification", async ({
  page,
}) => {
  const { unexpected, reads } = await mockSavedReview(
    page,
    pendingResult,
    true,
  );
  await page.goto("/#jobs");
  const card = page.locator(`[data-job-id="${recordId}"]`);
  await expect(card.getByText("說明規則已更新", { exact: true })).toBeVisible();
  await expect(card.getByText("AI 內容待整理", { exact: true })).toHaveCount(0);
  await expect(card.getByText("產品待核對", { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole("link", { name: "回到我的藥品", exact: true }),
  ).toHaveAttribute("href", "#medications");
  const preview = card.locator("details").first();
  const checkedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/jobs/" + recordId &&
      response.request().method() === "GET" &&
      response.status() === 200,
  );
  await preview.locator("summary").click();
  await checkedResponse;
  await expect(preview).toContainText(
    "仿單整理規則已更新，請重新產生說明與測驗。",
  );
  await expect(
    card.getByRole("link", { name: "補齊產品資料", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "使用原輸入重試", exact: true }),
  ).toHaveCount(0);
  expect(
    reads.filter((path) => path === "/api/v1/jobs/" + recordId),
  ).toHaveLength(1);
  expect(unexpected).toEqual([]);
});
