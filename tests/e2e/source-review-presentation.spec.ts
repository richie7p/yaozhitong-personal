import { expect, test, type Locator, type Page } from "@playwright/test";
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

async function mockSavedReview(page: Page, result = pendingResult) {
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
    sourceReviewPending: !!result.sourceReview,
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
    container.getByRole("heading", { name: "完整警語", exact: true }),
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
  await expect(record.getByText("已完成", { exact: true })).toHaveCount(0);
  await page.reload();
  await expectPendingSource(record, page);
  await expect(record.getByText("尚無測驗", { exact: true })).toBeVisible();
  expect(reads.filter((path) => path === "/api/v1/learning")).toHaveLength(2);
  await page.goto("/#learning");
  const directory = page.locator(
    `.learning-index-card[data-learning-id="${recordId}"]`,
  );
  await expect(directory).toContainText("尚無測驗");
  await expect(directory.getByText("已完成", { exact: true })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("reopening pending medication education reuses saved content after reload without another AI request", async ({
  page,
}) => {
  const { unexpected, reads } = await mockSavedReview(page);
  await page.goto("/#medications");
  const card = page.locator(`.med-card[data-medication-id="${medication.id}"]`);
  const detail = page.locator(".medication-detail");
  for (let opening = 1; opening <= 2; opening++) {
    await expect(card).toBeVisible();
    await expect(
      card.getByRole("button", { name: "排定提醒", exact: true }),
    ).toBeEnabled();
    await expect(card.locator(".usage-box strong")).toHaveText("1 錠");
    await card.getByRole("button", { name: "仿單說明", exact: true }).click();
    await expectPendingSource(detail, page);
    await expect(
      detail.getByRole("link", { name: "繼續理解測驗", exact: true }),
    ).toHaveCount(0);
    expect(reads.filter((path) => path === "/api/v1/learning")).toHaveLength(
      opening,
    );
    // Any POST, including /bundles, is blocked and recorded by the fixture.
    expect(unexpected).toEqual([]);
    if (opening === 1) await page.reload();
  }
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

for (const view of ["chat", "learning", "jobs", "medications"] as const)
  test(`preserved source capacity notice survives reload in ${view} without implying a complete AI answer`, async ({
    page,
  }) => {
    const result: GroundedResult = {
      ...pendingResult,
      sourceReview: undefined,
      chunks: canonicalResult().chunks,
      sourceReading: {
        reason: "model_source_capacity",
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
        await expect(card.getByText("已完成", { exact: true })).toHaveCount(0);
        await card.locator("summary").first().click();
      }
      if (view === "medications")
        await page
          .locator(".med-card")
          .getByRole("button", { name: "仿單說明", exact: true })
          .click();
      const notice = page.locator(".source-reading");
      await expect(
        notice.getByRole("heading", { name: "部分內容尚未整理", exact: true }),
      ).toBeVisible();
      await expect(notice).toContainText("本次回答沒有涵蓋這些內容");
      await notice.getByText("警語：展開完整仿單原文", { exact: true }).click();
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
