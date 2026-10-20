import { expect, test, type Page } from "@playwright/test";

const confirmedMedication = {
  id: "chat-confirmed",
  name: "問答流程合成藥品",
  confirmed: true,
  licenseNo: "SYNTHETIC-E2E-5",
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
};

async function openChat(page: Page) {
  await page.goto("/#chat");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用藥問答", exact: true }),
  ).toBeVisible();
}

async function mockChat(page: Page) {
  const posts: { question: string; medicationIds: string[] }[] = [];
  let failNext = false;
  let finishJob = false;
  let failHistory = false;
  let historyReads = 0;
  let jobReads = 0;
  let completedReads = 0;
  let postGate: Promise<void> | undefined;
  await page.route("**/api/v1/chat", async (route) => {
    if (route.request().method() === "GET") {
      historyReads++;
      await route.fulfill(
        failHistory
          ? { status: 503, json: { message: "合成紀錄讀取失敗" } }
          : { json: { items: [] } },
      );
      return;
    }
    posts.push(route.request().postDataJSON());
    const currentGate = postGate;
    postGate = undefined;
    await currentGate;
    if (failNext) {
      failNext = false;
      await route.fulfill({
        status: 503,
        json: {
          code: "service_unavailable",
          message: "合成連線失敗，請再試一次。",
        },
      });
      return;
    }
    await route.fulfill({
      status: 202,
      json: { jobId: "chat-ui-fixture-job" },
    });
  });
  await page.route("**/api/v1/jobs/chat-ui-fixture-job", async (route) => {
    jobReads++;
    if (finishJob) completedReads++;
    await route.fulfill({
      json: {
        id: "chat-ui-fixture-job",
        status: finishJob ? "succeeded" : "running",
      },
    });
  });
  return {
    posts,
    historyReads: () => historyReads,
    jobReads: () => jobReads,
    completedReads: () => completedReads,
    holdNextPost: () => {
      let release!: () => void;
      postGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failNext: () => {
      failNext = true;
    },
    complete: () => {
      finishJob = true;
    },
    failHistory: () => {
      failHistory = true;
    },
    restoreHistory: () => {
      failHistory = false;
    },
  };
}

test("empty medication list explains the disabled send button beside the draft and links to adding", async ({
  page,
}) => {
  const chat = await mockChat(page);
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題", exact: true });
  await input.fill("我想了解我服用的藥物");
  await expect(page.locator("#chat-prerequisite")).toContainText(
    "目前還沒有可提問的藥品",
  );
  await expect(
    page.getByRole("link", { name: "新增並確認藥品", exact: true }),
  ).toHaveAttribute("href", "#add");
  await expect(
    page.getByRole("button", { name: "送出", exact: true }),
  ).toBeDisabled();
  await page.locator(".chat-main form").dispatchEvent("submit");
  await expect(input).toHaveValue("我想了解我服用的藥物");
  expect(chat.posts).toEqual([]);
  await page.getByRole("link", { name: "新增並確認藥品", exact: true }).click();
  await page.goto("/#chat");
  await expect(input).toHaveValue("我想了解我服用的藥物");
});

test("route navigation retains selection and draft only in memory; completed send survives history failure", async ({
  page,
}) => {
  const chat = await mockChat(page);
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: [confirmedMedication] } }),
  );
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題" });
  await input.fill("暫存的合成問題");
  await page.getByLabel(confirmedMedication.name, { exact: true }).check();
  await page.evaluate(() => {
    location.hash = "#medications";
  });
  await expect(page.getByRole("textbox", { name: "用藥問題" })).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = "#chat";
  });
  await expect(input).toHaveValue("暫存的合成問題");
  await expect(
    page.getByLabel(confirmedMedication.name, { exact: true }),
  ).toBeChecked();
  expect(
    await page.evaluate((question) => {
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          if (storage.getItem(storage.key(i)!)?.includes(question)) return true;
        }
      }
      return false;
    }, "暫存的合成問題"),
  ).toBe(false);
  chat.failHistory();
  chat.complete();
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(
    page.getByText("問題已處理完成", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("合成紀錄讀取失敗");
  await expect(input).toHaveValue("");
  chat.restoreHistory();
  await page
    .getByRole("button", { name: "重新讀取問答紀錄", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(chat.posts).toHaveLength(1);
  await input.fill("重新整理應清除的合成問題");
  await page.reload();
  await expect(input).toHaveValue("");
});

test("navigation during POST and polling shares one send; completion while away clears the returned draft", async ({
  page,
}) => {
  const chat = await mockChat(page);
  const releasePost = chat.holdNextPost();
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: [confirmedMedication] } }),
  );
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題" });
  const medication = page.getByLabel(confirmedMedication.name, { exact: true });
  const send = page.getByRole("button", { name: "送出", exact: true });
  await input.fill("切換頁面期間只送出一次的合成問題");
  await medication.check();
  await send.click();
  await expect.poll(() => chat.posts.length).toBe(1);
  try {
    await page.evaluate(() => {
      location.hash = "#medications";
    });
    await expect(input).toHaveCount(0);
    await page.evaluate(() => {
      location.hash = "#chat";
    });
    await expect(input).toHaveValue("切換頁面期間只送出一次的合成問題");
    await expect(input).toBeDisabled();
    await expect(medication).toBeChecked();
    await expect(medication).toBeDisabled();
    await expect(send).toBeDisabled();
    await page.locator(".chat-main form").dispatchEvent("submit");
    releasePost();
    await expect.poll(() => chat.jobReads()).toBeGreaterThan(0);
    await expect(input).toBeDisabled();
    await page.locator(".chat-main form").dispatchEvent("submit");
    expect(chat.posts).toHaveLength(1);
    await page.evaluate(() => {
      location.hash = "#medications";
    });
    await expect(input).toHaveCount(0);
    chat.complete();
    await expect.poll(() => chat.completedReads()).toBeGreaterThan(0);
    await page.evaluate(() => {
      location.hash = "#chat";
    });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
    await expect(medication).toBeChecked();
    await expect(
      page.getByText("問題已處理完成", { exact: false }),
    ).toBeVisible();
    expect(chat.historyReads()).toBeGreaterThanOrEqual(3);
    expect(chat.posts).toHaveLength(1);
  } finally {
    releasePost();
  }
});

test("logout and account switch clear the memory draft before a delayed send can complete", async ({
  page,
}) => {
  const chat = await mockChat(page);
  const releasePost = chat.holdNextPost();
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: [confirmedMedication] } }),
  );
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題" });
  const medication = page.getByLabel(confirmedMedication.name, { exact: true });
  await input.fill("帳號甲延遲完成的合成問題");
  await medication.check();
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect.poll(() => chat.posts.length).toBe(1);
  try {
    await page.getByRole("button", { name: "登出", exact: true }).click();
    await page.getByRole("button", { name: "本機家人", exact: true }).click();
    await page.evaluate(() => {
      location.hash = "#chat";
    });
    await expect(input).toHaveValue("");
    await expect(input).toBeEnabled();
    await expect(medication).not.toBeChecked();
    await input.fill("帳號乙保留的合成問題");
    await medication.check();
    const oldResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/chat") &&
        response.request().method() === "POST",
    );
    releasePost();
    await (await oldResponse).finished();
    await expect(input).toHaveValue("帳號乙保留的合成問題");
    await expect(medication).toBeChecked();
    chat.complete();
    await page.getByRole("button", { name: "送出", exact: true }).click();
    await expect(input).toHaveValue("");
    expect(chat.posts).toHaveLength(2);
    expect(chat.posts[1].question).toBe("帳號乙保留的合成問題");
    await page.getByRole("button", { name: "登出", exact: true }).click();
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await page.evaluate(() => {
      location.hash = "#chat";
    });
    await expect(input).toHaveValue("");
    await expect(medication).not.toBeChecked();
    await expect(
      page.getByText("問題已處理完成", { exact: false }),
    ).toHaveCount(0);
  } finally {
    releasePost();
  }
});

for (const staleStatus of [200, 503]) {
  test(`a delayed initial history ${staleStatus} cannot replace the completed send's newer history`, async ({
    page,
  }) => {
    const chat = await mockChat(page);
    let historyReads = 0;
    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const freshQuestion = "應保留最新問答紀錄的合成問題";
    await page.route("**/api/v1/medications", (route) =>
      route.fulfill({ json: { items: [confirmedMedication] } }),
    );
    await page.route("**/api/v1/chat", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      if (++historyReads === 1) {
        await initialGate;
        await route.fulfill({
          status: staleStatus,
          headers: { "X-Synthetic-History": "stale-initial" },
          json:
            staleStatus === 200
              ? { items: [] }
              : {
                  code: "synthetic_old_failure",
                  message: "不得顯示過期的合成讀取錯誤",
                },
        });
        return;
      }
      await route.fulfill({
        json: {
          items: [
            {
              id: "synthetic-fresh-history",
              question: freshQuestion,
              createdAt: "2026-10-20T16:00:00.000Z",
              result: {
                status: "insufficient_data",
                claims: [],
                chunks: [],
                quiz: [],
                followups: [],
                rejectedCount: 0,
                sourceVersions: {},
                verification: "model_assisted",
              },
            },
          ],
        },
      });
    });
    await openChat(page);
    try {
      await expect.poll(() => historyReads).toBe(1);
      await page.getByRole("textbox", { name: "用藥問題" }).fill(freshQuestion);
      await page.getByLabel(confirmedMedication.name, { exact: true }).check();
      chat.complete();
      await page.getByRole("button", { name: "送出", exact: true }).click();
      const savedQuestion = page.locator(".chat-exchange .question-bubble");
      await expect(savedQuestion).toHaveText(freshQuestion);
      expect(historyReads).toBe(2);
      const staleResponse = page.waitForResponse(
        (response) =>
          response.headers()["x-synthetic-history"] === "stale-initial",
      );
      releaseInitial();
      await (await staleResponse).finished();
      // Allow the old fetch's JSON promise and React rendering to finish before
      // checking that its empty list or error did not overwrite the newer result.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await expect(savedQuestion).toHaveText(freshQuestion);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "用藥問題" })).toHaveValue(
        "",
      );
      expect(chat.posts).toHaveLength(1);
    } finally {
      releaseInitial();
    }
  });
}

test("draft medications offer confirmation rather than bypassing the confirmed-medication gate", async ({
  page,
}) => {
  const chat = await mockChat(page);
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({
      json: { items: [{ ...confirmedMedication, confirmed: false }] },
    }),
  );
  await openChat(page);
  await expect(page.locator("#chat-prerequisite")).toContainText(
    "藥品尚未確認",
  );
  await expect(
    page.getByRole("link", { name: "前往確認藥品", exact: true }),
  ).toHaveAttribute("href", "#medications");
  await expect(page.locator(".chat-selector input[type=checkbox]")).toHaveCount(
    0,
  );
  await page.getByRole("textbox", { name: "用藥問題" }).fill("請說明仿單");
  await expect(
    page.getByRole("button", { name: "送出", exact: true }),
  ).toBeDisabled();
  expect(chat.posts).toEqual([]);
});

test("selection preserves the question, whitespace cannot send, Enter composes text and one valid submission succeeds", async ({
  page,
}) => {
  const chat = await mockChat(page);
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: [confirmedMedication] } }),
  );
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題", exact: true });
  const send = page.getByRole("button", { name: "送出", exact: true });
  await input.fill("合成問題");
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: "選擇提問藥品", exact: true }).click();
  await expect(page.locator(".chat-selector")).toBeFocused();
  await expect(input).toHaveValue("合成問題");
  await page.getByLabel(confirmedMedication.name, { exact: true }).check();
  await input.fill("  \n　");
  await expect(send).toBeDisabled();
  await page.locator(".chat-main form").dispatchEvent("submit");
  expect(chat.posts).toEqual([]);
  await input.fill("合成問題");
  await input.press("End");
  await input.press("Enter");
  await expect(input).toHaveValue("合成問題\n");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  expect(chat.posts).toEqual([]);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toBeDisabled();
  await expect(
    page.getByLabel(confirmedMedication.name, { exact: true }),
  ).toBeDisabled();
  await page.locator(".chat-main form").dispatchEvent("submit");
  await expect.poll(() => chat.posts.length).toBe(1);
  expect(chat.posts[0]).toEqual({
    question: "合成問題",
    medicationIds: [confirmedMedication.id],
  });
  chat.complete();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  expect(chat.posts).toHaveLength(1);
});

test("medication read failure can retry in place without losing the question or enabling send during loading", async ({
  page,
}) => {
  const chat = await mockChat(page);
  let reads = 0;
  let releaseRead!: () => void;
  const retryRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route("**/api/v1/medications", async (route) => {
    if (++reads === 1) {
      await route.fulfill({
        status: 503,
        json: { code: "fixture_failure", message: "合成藥品讀取失敗。" },
      });
      return;
    }
    await retryRead;
    await route.fulfill({ json: { items: [confirmedMedication] } });
  });
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題" });
  await input.fill("讀取失敗仍保留的合成問題");
  await expect(page.locator("#chat-prerequisite")).toContainText(
    "藥品讀取失敗",
  );
  await page.getByRole("button", { name: "重新讀取藥品", exact: true }).click();
  await expect(page.locator("#chat-prerequisite")).toContainText(
    "正在讀取藥品",
  );
  await expect(
    page.getByRole("button", { name: "送出", exact: true }),
  ).toBeDisabled();
  releaseRead();
  await expect(
    page.getByLabel(confirmedMedication.name, { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("讀取失敗仍保留的合成問題");
  await page.getByLabel(confirmedMedication.name, { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "送出", exact: true }),
  ).toBeEnabled();
  expect(chat.posts).toEqual([]);
});

test("failed submission keeps the selected medication and question for a successful retry", async ({
  page,
}) => {
  const chat = await mockChat(page);
  chat.failNext();
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: [confirmedMedication] } }),
  );
  await openChat(page);
  const input = page.getByRole("textbox", { name: "用藥問題" });
  await page.getByLabel(confirmedMedication.name, { exact: true }).check();
  await input.fill("失敗重試的合成問題");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("合成連線失敗");
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("失敗重試的合成問題");
  await expect(
    page.getByLabel(confirmedMedication.name, { exact: true }),
  ).toBeChecked();
  chat.complete();
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(input).toHaveValue("");
  expect(chat.posts).toHaveLength(2);
  expect(chat.posts[0]).toEqual(chat.posts[1]);
});
