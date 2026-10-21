import { expect, test, type Page } from "@playwright/test";
import type {
  GroundedResult,
  LearningRecord,
  Medication,
} from "../../shared/schema";

test.use({ serviceWorkers: "block" });

const ownerId = "synthetic-discovery-owner";
const confirmedIdentity = {
  licenseNo: "SYNTHETIC-DISCOVERY-IDENTITY",
  identityReview: {
    status: "confirmed" as const,
    message: "合成包裝許可證已核對。",
    missingFields: [],
  },
};
const fixtureResult: GroundedResult = {
  status: "insufficient_data",
  claims: [],
  chunks: [],
  quiz: [],
  followups: [],
  rejectedCount: 0,
  sourceVersions: {},
  verification: "model_assisted",
};

function medication(
  index: number,
  overrides: Partial<Medication> = {},
): Medication {
  return {
    id: `synthetic-discovery-medication-${String(index).padStart(8, "0")}`,
    ownerId,
    name: `合成清單藥品 ${index}`,
    licenseNo: null,
    strength: "10mg",
    form: "錠劑",
    doseAmount: 1,
    doseUnit: "錠",
    doseText: "",
    frequencyRaw: "QD",
    route: "口服",
    rawText: "",
    durationDays: null,
    instructions: "",
    confirmed: true,
    prn: false,
    revision: 1,
    archived: false,
    createdAt: "2026-10-20T23:30:12.000Z",
    updatedAt: "2026-10-20T23:30:12.000Z",
    ...overrides,
  };
}

function learningRecord(id: string, medicationIds: string[]): LearningRecord {
  return {
    id,
    ownerId,
    medicationIds,
    medicationRevisions: medicationIds.map((id) => ({ id, revision: 1 })),
    profileVersion: 1,
    result: fixtureResult,
    answers: {},
    createdAt: "2026-10-21T01:45:16.000Z",
  };
}

// Fulfill every API call in the browser and reject external requests. This
// exercises UI routing and payloads without creating backend records or AI jobs.
async function discoveryFixture(
  page: Page,
  initialMedications: Medication[],
  initialLearning: LearningRecord[] = [],
) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const unexpected: string[] = [];
  const medicationPosts: Record<string, unknown>[] = [];
  const chatPosts: { question: string; medicationIds: string[] }[] = [];
  const interactionPosts: { medicationIds: string[] }[] = [];
  const medications = [...initialMedications];
  const learning = [...initialLearning];
  const chat: Record<string, unknown>[] = [];
  const savedId = "synthetic-manual-saved-0000abcd";
  const chatId = "synthetic-discovery-chat-0000cafe";
  const interactionId = "synthetic-discovery-interaction-0000babe";

  await page.addInitScript(() => {
    sessionStorage.setItem("yzt-local-token", "synthetic-discovery-only");
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.method() + " " + url.origin + url.pathname);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      await route.continue();
      return;
    }
    const path = url.pathname.slice("/api/v1".length);
    if (request.method() === "GET") {
      const responses: Record<string, unknown> = {
        "/config": { mode: "local", ai: false },
        "/me": {
          account: {
            id: ownerId,
            displayName: "合成探索測試",
            eligible: true,
            admin: false,
          },
          profile: { displayName: "合成探索測試" },
        },
        "/medications": { items: medications, duplicates: [] },
        "/learning": { items: learning },
        "/chat": { items: chat },
        [`/jobs/${chatId}`]: { id: chatId, status: "succeeded" },
        [`/jobs/${interactionId}`]: { id: interactionId, status: "succeeded" },
      };
      if (Object.hasOwn(responses, path)) {
        await route.fulfill({ json: responses[path] });
        return;
      }
    }
    if (request.method() === "POST" && path === "/medications") {
      const body = request.postDataJSON();
      medicationPosts.push(body);
      const saved = medication(99, { ...body, id: savedId });
      // Deliberately return the saved item last: finding it first must be a UI behavior.
      medications.push(saved);
      await route.fulfill({ status: 201, json: saved });
      return;
    }
    if (request.method() === "POST" && path === "/chat") {
      const body = request.postDataJSON();
      chatPosts.push(body);
      chat.push({
        id: chatId,
        question: body.question,
        medicationIds: body.medicationIds,
        createdAt: "2026-10-21T02:00:00.000Z",
        result: fixtureResult,
      });
      await route.fulfill({ status: 202, json: { jobId: chatId } });
      return;
    }
    if (request.method() === "POST" && path === "/interactions") {
      const body = request.postDataJSON();
      interactionPosts.push(body);
      learning.push(learningRecord(interactionId, body.medicationIds));
      await route.fulfill({ status: 202, json: { jobId: interactionId } });
      return;
    }
    unexpected.push(request.method() + " " + url.pathname);
    await route.abort();
  });
  return {
    unexpected,
    medicationPosts,
    chatPosts,
    interactionPosts,
    savedId,
    interactionId,
  };
}

test("manual save reveals its exact record above a long list and name search can recover from no matches", async ({
  page,
}) => {
  const fixture = await discoveryFixture(
    page,
    Array.from({ length: 12 }, (_, index) => medication(index + 1)),
  );
  await page.goto("/#add");
  await page.getByRole("button", { name: "手動建檔", exact: true }).click();
  const name = "合成新存紀錄 25mg";
  await page.getByLabel("藥品名稱", { exact: true }).fill(name);
  await page.getByLabel("每次劑量", { exact: true }).fill("0.5");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("TID");
  await page.getByLabel("給藥途徑", { exact: true }).fill("口服");
  await page
    .getByLabel("我已對照藥袋確認用法（每次用量、頻次與途徑）", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();

  await expect(page).toHaveURL(
    new RegExp(`#medications\\?saved=${fixture.savedId}$`),
  );
  await expect(
    page.locator(".notice").filter({ hasText: `已儲存「${name}」` }),
  ).toBeVisible();
  const cards = page.locator(".med-card");
  const saved = page.locator(
    `.med-card[data-medication-id="${fixture.savedId}"]`,
  );
  const savedHeading = saved.getByRole("heading", { name, exact: true });
  await expect(cards).toHaveCount(13);
  await expect(cards.first()).toHaveAttribute(
    "data-medication-id",
    fixture.savedId,
  );
  await expect(saved.getByText("本次儲存", { exact: true })).toBeVisible();
  await expect(savedHeading).toBeFocused();
  await expect(savedHeading).toBeInViewport({ ratio: 1 });
  await expect(saved).toContainText("TID（每日三次）");
  expect(fixture.medicationPosts).toHaveLength(1);
  expect(fixture.medicationPosts[0]).toMatchObject({
    name,
    doseAmount: 0.5,
    doseUnit: "錠",
    frequencyRaw: "TID",
    confirmed: true,
  });

  const search = page.getByRole("searchbox", {
    name: "搜尋我的藥品",
    exact: true,
  });
  await search.fill("  合成新存  ");
  await expect(cards).toHaveCount(1);
  await expect(saved).toBeVisible();
  await search.fill("完全不吻合XYZ");
  await expect(cards).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "沒有符合搜尋的藥品", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜尋", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(cards).toHaveCount(13);
  await expect(cards.first()).toHaveAttribute(
    "data-medication-id",
    fixture.savedId,
  );
  await page.getByRole("link", { name: "查看這筆藥品", exact: true }).click();
  await expect(savedHeading).toBeFocused();
  await expect(savedHeading).toBeInViewport({ ratio: 1 });
  expect(fixture.unexpected).toEqual([]);
});

test("same-name prescriptions keep separate identities in lists, chat and learning selections", async ({
  page,
}) => {
  const first = medication(1, {
    ...confirmedIdentity,
    name: "合成同名藥品",
    doseAmount: 0.5,
    frequencyRaw: "QD",
  });
  const second = medication(2, {
    ...confirmedIdentity,
    name: first.name,
    doseAmount: 2,
    frequencyRaw: "BID",
    createdAt: "2026-10-21T01:00:00.000Z",
  });
  const comparator = medication(3, {
    ...confirmedIdentity,
    name: "合成比較藥品",
  });
  const firstRecord = learningRecord("synthetic-learning-00001111", [first.id]);
  const secondRecord = learningRecord("synthetic-learning-00002222", [
    second.id,
  ]);
  const fixture = await discoveryFixture(
    page,
    [first, second, comparator],
    [firstRecord, secondRecord],
  );
  await page.goto("/#medications");
  const sameNameCards = page.locator(".med-card").filter({
    has: page.getByRole("heading", { name: first.name, exact: true }),
  });
  await expect(sameNameCards).toHaveCount(2);
  const firstCard = page.locator(`.med-card[data-medication-id="${first.id}"]`);
  const secondCard = page.locator(
    `.med-card[data-medication-id="${second.id}"]`,
  );
  await expect(firstCard).toContainText("每次 0.5 錠");
  await expect(firstCard).toContainText("2026/10/21 07:30:12（臺北時間）");
  await expect(firstCard).toContainText("…00000001");
  await expect(secondCard).toContainText("每次 2 錠");
  await expect(secondCard).toContainText("BID（每日兩次）");
  await expect(secondCard).toContainText("2026/10/21 09:00:00（臺北時間）");
  await expect(secondCard).toContainText("…00000002");

  await page.goto("/#chat");
  const chatChoices = page.getByRole("checkbox", {
    name: first.name,
    exact: true,
  });
  await expect(chatChoices).toHaveCount(2);
  const firstChatChoice = page.locator(
    `input[aria-describedby="chat-medication-${first.id}"]`,
  );
  const secondChatChoice = page.locator(
    `input[aria-describedby="chat-medication-${second.id}"]`,
  );
  await expect(firstChatChoice).toHaveAccessibleDescription(
    /每次 0\.5 錠.*QD（每日一次）.*00000001/,
  );
  await expect(secondChatChoice).toHaveAccessibleDescription(
    /每次 2 錠.*BID（每日兩次）.*00000002/,
  );
  await secondChatChoice.check();
  await expect(firstChatChoice).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "用藥問題", exact: true })
    .fill("請說明這筆合成藥品的仿單。");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect.poll(() => fixture.chatPosts.length).toBe(1);
  expect(fixture.chatPosts[0].medicationIds).toEqual([second.id]);
  await expect(
    page.getByRole("textbox", { name: "用藥問題", exact: true }),
  ).toHaveValue("");
  await expect(page.locator(".chat-record-medications")).toContainText(
    "每次 2 錠",
  );

  await page.goto("/#learning");
  const firstLearning = page.locator(`[data-learning-id="${firstRecord.id}"]`);
  const secondLearning = page.locator(
    `[data-learning-id="${secondRecord.id}"]`,
  );
  await expect(firstLearning).toContainText(
    "建立 2026/10/21 09:45:16（臺北時間）",
  );
  await expect(firstLearning).toContainText("…00001111");
  await expect(firstLearning).toContainText("每次 0.5 錠");
  await expect(secondLearning).toContainText("…00002222");
  await expect(secondLearning).toContainText("每次 2 錠");
  const firstLearningChoice = page.locator(
    `input[aria-describedby="learning-medication-${first.id}"]`,
  );
  const secondLearningChoice = page.locator(
    `input[aria-describedby="learning-medication-${second.id}"]`,
  );
  await expect(firstLearningChoice).toHaveAccessibleDescription(
    /每次 0\.5 錠.*00000001/,
  );
  await expect(secondLearningChoice).toHaveAccessibleDescription(
    /每次 2 錠.*BID（每日兩次）.*00000002/,
  );
  await secondLearningChoice.check();
  await page
    .getByRole("checkbox", { name: comparator.name, exact: true })
    .check();
  await expect(firstLearningChoice).not.toBeChecked();
  await page.getByRole("button", { name: "比對交互作用", exact: true }).click();
  await expect.poll(() => fixture.interactionPosts.length).toBe(1);
  expect(fixture.interactionPosts[0].medicationIds).toEqual([
    second.id,
    comparator.id,
  ]);
  await expect(page).toHaveURL(new RegExp(`record=${fixture.interactionId}`));
  expect(fixture.unexpected).toEqual([]);
});

test("revealing a saved demo medication preserves context and frequency editing keeps its exact accessible label", async ({
  page,
}) => {
  const target = medication(7, {
    name: "合成展示已存藥品",
    frequencyRaw: "QD",
  });
  const fixture = await discoveryFixture(page, [medication(1), target]);
  const demoHash = `#medications?from=demo&medication=${target.id}&saved=${target.id}`;
  await page.goto("/" + demoHash);
  const originalUrl = page.url();
  const saved = page.locator(`.med-card[data-medication-id="${target.id}"]`);
  await expect(saved.getByText("本次儲存", { exact: true })).toBeVisible();
  await expect(page.locator(".demo-context")).toContainText("研討會展示");
  const returnToDemo = page.getByRole("link", {
    name: "返回展示導覽",
    exact: true,
  });
  await expect(returnToDemo).toHaveAttribute("href", "#demo");

  const search = page.getByRole("searchbox", {
    name: "搜尋我的藥品",
    exact: true,
  });
  await search.fill("完全不符合的合成搜尋");
  await expect(saved).toHaveCount(0);
  const reveal = page.getByRole("link", { name: "查看這筆藥品", exact: true });
  await expect(reveal).toHaveAttribute("href", demoHash);
  await reveal.click();
  await expect(page).toHaveURL(originalUrl);
  await expect(search).toHaveValue("");
  await expect(saved).toBeVisible();
  await expect(
    saved.getByRole("heading", { name: target.name, exact: true }),
  ).toBeFocused();
  await expect(page.locator(".demo-context")).toContainText(
    `${target.name}已儲存`,
  );
  await expect(returnToDemo).toHaveAttribute("href", "#demo");

  await saved.getByRole("button", { name: "編輯用法", exact: true }).click();
  const frequency = page.getByLabel("頻次原文", { exact: true });
  await expect(frequency).toHaveValue("QD");
  await expect(frequency).toHaveAccessibleName("頻次原文");
  await expect(frequency).toHaveAccessibleDescription("QD（每日一次）");
  const helpId = await frequency.getAttribute("aria-describedby");
  expect(helpId).toBeTruthy();
  await frequency.fill("BID");
  await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue("BID");
  await expect(frequency).toHaveAccessibleName("頻次原文");
  await expect(frequency).toHaveAttribute("aria-describedby", helpId!);
  await expect(frequency).toHaveAccessibleDescription("BID（每日兩次）");
  await expect(page).toHaveURL(originalUrl);
  expect(fixture.medicationPosts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
