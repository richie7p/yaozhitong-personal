import { expect, test, type Page } from "@playwright/test";
import type { GroundedResult } from "../../shared/schema";

// Synthetic presentation fixtures only. Every API request is fulfilled in the
// browser, and external requests are blocked; no model or real identity is used.
const medication = {
  id: "synthetic-storage-medication",
  name: "合成儲存問答測試藥品",
  confirmed: true,
  licenseNo: "SYNTHETIC-CHAT-STORAGE",
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
};
const storageQuote = "儲存條件：25℃以下保存。此為合成軟體測試資料。";
const handlingQuote = "保存提醒：保留原包裝。此為合成軟體測試資料。";
const storageResult: GroundedResult = {
  status: "supported",
  claims: [
    {
      text: "依這份合成仿單，請於 25℃ 以下保存。",
      category: "other",
      citations: [{ chunkId: "synthetic-storage-pdf", quote: storageQuote }],
    },
    {
      text: "保存時保留原包裝。",
      category: "other",
      citations: [{ chunkId: "synthetic-storage-html", quote: handlingQuote }],
    },
  ],
  chunks: [
    {
      id: "synthetic-storage-pdf",
      licenseNo: medication.licenseNo,
      version: "storage-v1",
      page: 3,
      start: 0,
      text: storageQuote,
    },
    {
      id: "synthetic-storage-html",
      licenseNo: medication.licenseNo,
      version: "storage-v1",
      page: 2,
      start: 0,
      text: handlingQuote,
      sourceFormat: "html",
    },
  ],
  quiz: [],
  followups: [],
  rejectedCount: 0,
  sourceVersions: { [medication.licenseNo]: "storage-v1" },
  verification: "model_assisted",
};

interface ChatPresentationRecord {
  id: string;
  question: string;
  createdAt: string;
  medicationIds?: string[];
  result: GroundedResult;
}

async function mockHistory(
  page: Page,
  items: ChatPresentationRecord[],
  medications: object[] = [medication],
) {
  const unexpected: string[] = [];
  await page.addInitScript(() => {
    sessionStorage.setItem("yzt-local-token", "synthetic-presentation-only");
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
    const json: Record<string, unknown> = {
      "/api/v1/config": { mode: "local", ai: false },
      "/api/v1/me": {
        account: {
          id: "synthetic-presentation-owner",
          displayName: "合成展示使用者",
          eligible: true,
          admin: false,
        },
        profile: { displayName: "合成展示使用者" },
      },
      "/api/v1/medications": { items: medications },
      "/api/v1/chat": { items },
    };
    if (request.method() === "GET" && url.pathname in json) {
      await route.fulfill({ json: json[url.pathname] });
      return;
    }
    unexpected.push(request.method() + " " + url.pathname);
    await route.abort();
  });
  return unexpected;
}

async function openAnswer(page: Page, result: GroundedResult) {
  const unexpected = await mockHistory(page, [
    {
      id: "synthetic-storage-answer",
      question: "這款合成測試藥品要怎麼保存？",
      createdAt: "2026-10-21T02:00:00.000Z",
      medicationIds: [medication.id],
      result,
    },
  ]);
  await page.goto("/#chat");
  const exchange = page.locator(".chat-exchange").first();
  await expect(exchange).toBeVisible();
  const answer = exchange.locator(".chat-answer");
  if (!(await answer.isVisible()))
    await exchange.locator("summary").first().click();
  await expect(answer).toBeVisible();
  return { answer, unexpected };
}

test("storage answers show every returned claim and keyboard-expandable citations without education placeholders", async ({
  page,
}) => {
  const { answer, unexpected } = await openAnswer(page, storageResult);
  await expect(
    answer.locator(".chat-answer-claim > div:last-child > p"),
  ).toHaveText(storageResult.claims.map((claim) => claim.text));
  await expect(answer).toContainText("25℃ 以下保存");
  await expect(answer).toContainText("已附仿單依據");
  await expect(
    answer.locator(
      ".reading-sections, .reading-use, .reading-warnings, .quiz, .confirmed-usage",
    ),
  ).toHaveCount(0);
  for (const label of ["用途與用法", "藥品用途", "完整警語"])
    await expect(answer.getByText(label, { exact: true })).toHaveCount(0);
  await expect(answer.getByText(/目前沒有可引用的用途說明/)).toHaveCount(0);
  await expect(
    answer.getByText(/目前沒有可確認與你健康資料相關的提醒/),
  ).toHaveCount(0);
  await expect(answer.locator("blockquote")).toHaveCount(2);
  await expect(answer.locator("blockquote").nth(0)).not.toBeVisible();
  await expect(answer.locator("blockquote").nth(1)).not.toBeVisible();
  const citations = answer.getByText("對照仿單原文", { exact: true });
  await expect(citations).toHaveCount(2);
  await citations.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(answer.locator("blockquote").nth(0)).toBeVisible();
  await expect(answer.locator("blockquote").nth(0)).toContainText(storageQuote);
  await expect(answer.locator("blockquote").nth(0)).toContainText("第 3 頁");
  await citations.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(answer.locator("blockquote").nth(1)).toBeVisible();
  await expect(answer.locator("blockquote").nth(1)).toContainText(
    handlingQuote,
  );
  await expect(answer.locator("blockquote").nth(1)).toContainText(
    "官方網頁 · 區塊 2",
  );
  expect(unexpected).toEqual([]);
});

test("actual safety claims and their health references remain in the answer", async ({
  page,
}) => {
  const warningText = "本合成資料只供測試，不能據此調整用藥。";
  const sourceMentionText = "合成情境B的讀者應核對這段合成原文。";
  const result: GroundedResult = {
    ...storageResult,
    claims: [
      ...storageResult.claims,
      {
        text: warningText,
        category: "warning",
        profileRefs: [{ field: "conditions", value: "合成情境A" }],
        citations: [{ chunkId: "synthetic-warning", quote: warningText }],
      },
      {
        text: sourceMentionText,
        kind: "source_exact_safety",
        sourceMentions: [{ field: "conditions", value: "合成情境B" }],
        citations: [
          { chunkId: "synthetic-source-mention", quote: sourceMentionText },
        ],
      },
    ],
    chunks: [
      ...storageResult.chunks,
      {
        ...storageResult.chunks[0],
        id: "synthetic-warning",
        text: warningText,
      },
      {
        ...storageResult.chunks[1],
        id: "synthetic-source-mention",
        text: sourceMentionText,
      },
    ],
    rejectedCount: 1,
  };
  const { answer, unexpected } = await openAnswer(page, result);
  await expect(answer.locator(".chat-answer-claim")).toHaveCount(4);
  await expect(answer.getByText(warningText, { exact: true })).toBeVisible();
  await expect(
    answer.getByText(sourceMentionText, { exact: true }),
  ).toBeVisible();
  await expect(answer.getByText("警語與注意事項", { exact: true })).toHaveCount(
    2,
  );
  await expect(answer.getByText(/健康狀況：合成情境A/)).toBeVisible();
  await expect(answer.locator(".source-mention")).toHaveText(
    "仿單原文提到你填寫的「合成情境B」；請對照原文中的適用條件。",
  );
  await expect(answer.getByText("對照仿單原文", { exact: true })).toHaveCount(
    4,
  );
  await expect(answer.locator(".chat-answer-validation")).toHaveText(
    "1 條內容未通過驗證，已隱藏。",
  );
  expect(unexpected).toEqual([]);
});

test("validation failures remain visible while withheld content and raw chunks stay hidden", async ({
  page,
}) => {
  const withheldText = "未通過驗證的合成答案不可顯示";
  const result: GroundedResult = {
    ...storageResult,
    status: "insufficient_data",
    claims: [],
    chunks: [{ ...storageResult.chunks[0], text: withheldText }],
    rejectedCount: 2,
  };
  const { answer, unexpected } = await openAnswer(page, result);
  await expect(
    answer.getByText("目前仿單資料不足", { exact: true }),
  ).toBeVisible();
  await expect(answer.locator(".chat-answer-validation")).toHaveText(
    "2 條內容未通過驗證，已隱藏。",
  );
  await expect(answer).toContainText("沒有記載不代表沒有風險");
  await expect(answer.getByText(withheldText, { exact: false })).toHaveCount(0);
  await expect(answer.locator(".chat-answer-claim, blockquote")).toHaveCount(0);
  await expect(answer.getByText("對照仿單原文", { exact: true })).toHaveCount(
    0,
  );
  await expect(answer.getByText("已附仿單依據", { exact: true })).toHaveCount(
    0,
  );
  expect(unexpected).toEqual([]);
});

test("dated history keeps exact same-name record identities and expands the latest answer while legacy identity stays unknown", async ({
  page,
}) => {
  const firstMedication = {
    ...medication,
    id: "synthetic-same-name-first-11111111",
    strength: "5mg",
    createdAt: "2026-10-20T01:00:00.000Z",
  };
  const secondMedication = {
    ...medication,
    id: "synthetic-same-name-second-22222222",
    strength: "10mg",
    doseAmount: 2,
    frequencyRaw: "BID",
    createdAt: "2026-10-20T02:00:00.000Z",
  };
  const unselectedMedication = {
    ...medication,
    id: "synthetic-same-name-unselected-33333333",
    strength: "20mg",
    doseAmount: 3,
    createdAt: "2026-10-20T03:00:00.000Z",
  };
  const newest: ChatPresentationRecord = {
    id: "synthetic-chat-newest-abcdefgh",
    question: "較新的合成保存問題",
    createdAt: "2026-10-21T05:00:00.000Z",
    medicationIds: [secondMedication.id],
    result: storageResult,
  };
  const older: ChatPresentationRecord = {
    id: "synthetic-chat-older-ijklmnop",
    question: "較早的合成保存問題",
    createdAt: "2026-10-20T23:00:00.000Z",
    medicationIds: [firstMedication.id],
    result: storageResult,
  };
  const legacy: ChatPresentationRecord = {
    id: "synthetic-chat-legacy-qrstuvwx",
    question: "未保存項目編號的舊合成問題",
    createdAt: "2026-10-19T23:00:00.000Z",
    result: storageResult,
  };
  // Deliberately provide unsorted history and three prescriptions with the same
  // name/license; only the saved record IDs can identify each selected item.
  const unexpected = await mockHistory(
    page,
    [legacy, older, newest],
    [firstMedication, secondMedication, unselectedMedication],
  );
  await page.goto("/#chat");
  const exchanges = page.locator(".chat-exchange");
  await expect(exchanges).toHaveCount(3);
  await expect(exchanges.nth(0)).toHaveAttribute("data-chat-id", newest.id);
  await expect(exchanges.nth(1)).toHaveAttribute("data-chat-id", older.id);
  await expect(exchanges.nth(2)).toHaveAttribute("data-chat-id", legacy.id);
  await expect(exchanges.nth(0)).toHaveJSProperty("open", true);
  await expect(exchanges.nth(1)).toHaveJSProperty("open", false);
  await expect(exchanges.nth(2)).toHaveJSProperty("open", false);
  await expect(exchanges.nth(0).locator(".record-identity")).toHaveText(
    "建立 2026/10/21 13:00:00（臺北時間） · 編號 …abcdefgh",
  );
  await expect(exchanges.nth(1).locator(".record-identity")).toHaveText(
    "建立 2026/10/21 07:00:00（臺北時間） · 編號 …ijklmnop",
  );
  const latestMedication = exchanges.nth(0).locator(".chat-record-medications");
  await expect(latestMedication.locator(".medication-identity")).toHaveCount(1);
  await expect(
    latestMedication.locator(".medication-identity"),
  ).toHaveAttribute("title", `完整編號：${secondMedication.id}`);
  await expect(latestMedication).toContainText("10mg");
  await expect(latestMedication).toContainText("BID（每日兩次）");
  await expect(latestMedication).not.toContainText("…11111111");
  await expect(latestMedication).not.toContainText("…33333333");
  await expect(page.locator(".chat-selector input[type=checkbox]")).toHaveCount(
    3,
  );

  await exchanges.nth(1).locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(exchanges.nth(1)).toHaveJSProperty("open", true);
  const olderMedication = exchanges
    .nth(1)
    .locator(".chat-record-medications .medication-identity");
  await expect(olderMedication).toHaveCount(1);
  await expect(olderMedication).toHaveAttribute(
    "title",
    `完整編號：${firstMedication.id}`,
  );
  await expect(exchanges.nth(1).locator(".chat-answer")).toBeVisible();
  await expect(
    exchanges.nth(1).locator("blockquote").first(),
  ).not.toBeVisible();

  await exchanges.nth(2).locator(":scope > summary").click();
  const legacyMedication = exchanges.nth(2).locator(".chat-record-medications");
  await expect(legacyMedication).toContainText(
    `仿單來源：${medication.licenseNo}`,
  );
  await expect(legacyMedication).toContainText(
    "舊紀錄未保存所選藥品項目編號，無法確認當時選取的是同名藥品中的哪一筆。",
  );
  await expect(legacyMedication.locator(".medication-identity")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("a newly completed answer is focused and revealed above long retained history after the refreshed record arrives", async ({
  page,
}) => {
  const oldRecords: ChatPresentationRecord[] = Array.from(
    { length: 14 },
    (_, index) => ({
      id: `synthetic-old-chat-${index}`,
      question: `舊紀錄 ${index + 1}：這款合成測試藥品的保存條件與原包裝說明是什麼？`,
      createdAt: new Date(Date.UTC(2026, 9, 20, index)).toISOString(),
      medicationIds: [medication.id],
      result: storageResult,
    }),
  );
  const newRecord: ChatPresentationRecord = {
    id: "synthetic-just-completed-answer",
    question: "剛送出的合成保存問題",
    createdAt: "2026-10-21T02:00:00.000Z",
    medicationIds: [medication.id],
    result: storageResult,
  };
  const unexpected = await mockHistory(page, oldRecords);
  const posts: { question: string; medicationIds: string[] }[] = [];
  let historyReads = 0;
  let releaseHistory!: () => void;
  const refreshedHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route("**/api/v1/chat", async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        json: { jobId: newRecord.id },
      });
      return;
    }
    if (++historyReads === 1) {
      await route.fallback();
      return;
    }
    if (historyReads === 2) {
      await route.fulfill({
        status: 503,
        json: {
          code: "synthetic_history_failure",
          message: "合成新回答紀錄讀取失敗，請重試。",
        },
      });
      return;
    }
    await refreshedHistory;
    await route.fulfill({ json: { items: [...oldRecords, newRecord] } });
  });
  await page.route(`**/api/v1/jobs/${newRecord.id}`, (route) =>
    route.fulfill({
      json: { id: newRecord.id, status: "succeeded" },
    }),
  );
  await page.goto("/#chat");
  const exchanges = page.locator(".chat-exchange");
  await expect(exchanges).toHaveCount(oldRecords.length);
  await expect(page.locator(".chat-exchange[open]")).toHaveCount(1);
  const oldLatestSummary = page.locator(
    `[data-chat-id="${oldRecords.at(-1)!.id}"] > summary`,
  );
  await expect(oldLatestSummary).toBeVisible();
  await oldLatestSummary.evaluate((summary) => {
    summary.setAttribute("data-fixture-focus-count", "0");
    summary.addEventListener("focus", () => {
      summary.setAttribute(
        "data-fixture-focus-count",
        String(Number(summary.getAttribute("data-fixture-focus-count")) + 1),
      );
    });
  });
  await page.getByLabel(medication.name, { exact: true }).check();
  const composer = page.getByRole("textbox", { name: "用藥問題", exact: true });
  await composer.fill(newRecord.question);
  await composer.scrollIntoViewIfNeeded();
  await expect(composer).toBeInViewport();
  await expect(oldLatestSummary).not.toBeInViewport();
  await page.getByRole("button", { name: "送出", exact: true }).click();
  try {
    await expect.poll(() => historyReads).toBe(2);
    await expect(page.getByRole("alert")).toContainText(
      "合成新回答紀錄讀取失敗，請重試。",
    );
    await expect(oldLatestSummary).not.toBeFocused();
    await expect(oldLatestSummary).not.toBeInViewport();
    await page
      .getByRole("button", { name: "重新讀取問答紀錄", exact: true })
      .click();
    await expect.poll(() => historyReads).toBe(3);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await composer.scrollIntoViewIfNeeded();
    // Clearing the read error must not focus an old answer. Record every focus
    // event as well as the final focus, since clicking retry scrolls to the error.
    // The retried history response remains withheld through these render frames.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(oldLatestSummary).not.toBeFocused();
    await expect(oldLatestSummary).toHaveAttribute(
      "data-fixture-focus-count",
      "0",
    );
    await expect(oldLatestSummary).not.toBeInViewport();
    await expect(page.locator(`[data-chat-id="${newRecord.id}"]`)).toHaveCount(
      0,
    );
    releaseHistory();

    const latest = page.locator(`[data-chat-id="${newRecord.id}"]`);
    const latestSummary = latest.locator(":scope > summary");
    await expect(exchanges).toHaveCount(oldRecords.length + 1);
    await expect(exchanges.first()).toHaveAttribute(
      "data-chat-id",
      newRecord.id,
    );
    await expect(latest).toHaveJSProperty("open", true);
    await expect(latestSummary).toBeFocused();
    await expect(latestSummary).toBeInViewport();
    await expect(latest.locator(".chat-answer")).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(page.locator(".chat-exchange[open]")).toHaveCount(1);
    for (const record of oldRecords) {
      const old = page.locator(`[data-chat-id="${record.id}"]`);
      await expect(old.locator(":scope > summary .question-bubble")).toHaveText(
        record.question,
      );
      await expect(old).toHaveJSProperty("open", false);
    }
    expect(posts).toEqual([
      { question: newRecord.question, medicationIds: [medication.id] },
    ]);
    expect(unexpected).toEqual([]);
  } finally {
    releaseHistory();
  }
});
