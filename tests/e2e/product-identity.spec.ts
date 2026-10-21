import { expect, test, type Page, type Route } from "@playwright/test";

// All product data and API replies below are synthetic browser fixtures. These
// tests block external traffic and never call an AI service or cloud account.
const candidate = {
  licenseNo: "SYNTHETIC-SECORINE-IDENTITY",
  nameZh: "合成息咳寧糖漿（甲廠草莓口味）",
  nameEn: "Synthetic Secorine Strawberry Syrup",
  strength: "2.5mg/mL",
  form: "糖漿劑",
  ingredients: ["synthetic-only"],
  revoked: false,
  hasLeaflet: true,
};
const photoMedication = {
  name: "息咳寧",
  strength: null,
  form: null,
  doseAmount: 5,
  doseUnit: "毫升",
  frequencyRaw: "TID PC",
  route: "口服",
  rawText: "合成照片：息咳寧；每次5毫升；TID PC；口服",
  candidates: [candidate],
};
const usageLabel = "我已對照藥袋確認用法（每次用量、頻次與途徑）";
const pending = (message = "完整品名與規格不足，請補拍或抄錄完整許可證。") => ({
  status: "needs_information",
  message,
  missingFields: ["printedLicenseNo"],
  candidate,
});
const confirmed = () => ({
  status: "confirmed",
  message: "合成包裝資料已核對。",
  missingFields: [],
  candidate,
});
const result = {
  status: "supported",
  claims: [],
  chunks: [],
  quiz: [],
  followups: [],
  rejectedCount: 0,
  sourceVersions: { [candidate.licenseNo]: "synthetic-v1" },
  verification: "model_assisted",
};

async function fixture(page: Page, initial: any[] = []) {
  let medications = initial;
  const saved: any[] = [];
  const checks: any[] = [];
  const aiCalls: string[] = [];
  const unexpected: string[] = [];
  let checkHandler: ((route: Route, body: any) => Promise<void>) | undefined;
  let learning: any[] = [];
  let chats: any[] = [];
  let historyExtra: any = {};
  let accountId = "identity-owner";
  const review = (body: any) => {
    const e = body.identityEvidence;
    return e?.method === "license" && e.printedLicenseNo === candidate.licenseNo
      ? confirmed()
      : e?.method === "details" &&
          e.printedName === candidate.nameZh &&
          e.printedStrength === candidate.strength &&
          e.printedForm === candidate.form
        ? confirmed()
        : pending();
  };
  await page.addInitScript(() =>
    sessionStorage.setItem("yzt-local-token", "synthetic-identity-only"),
  );
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.origin !== "http://127.0.0.1:5190") {
      unexpected.push(request.method() + " " + url.origin);
      return route.abort();
    }
    if (!path.startsWith("/api/v1/")) return route.continue();
    const body =
      request.method() === "POST" || request.method() === "PUT"
        ? request.postDataJSON()
        : null;
    if (request.method() === "POST" && path === "/api/v1/auth/local") {
      accountId = "identity-second-owner";
      medications = [];
      return route.fulfill({ json: { token: "synthetic-identity-second" } });
    }
    if (path === "/api/v1/medications/identity-check") {
      checks.push(body);
      if (checkHandler) return checkHandler(route, body);
      return route.fulfill({ json: { identityReview: review(body) } });
    }
    if (request.method() === "POST" && path === "/api/v1/recognitions") {
      aiCalls.push(path);
      return route.fulfill({
        status: 202,
        json: { jobId: "identity-new-photo" },
      });
    }
    if (
      request.method() === "GET" &&
      path === "/api/v1/jobs/identity-new-photo"
    )
      return route.fulfill({
        json: {
          id: "identity-new-photo",
          kind: "recognition",
          status: "succeeded",
          result: {
            status: "succeeded",
            medications: [
              { ...photoMedication, name: "另一張照片的合成藥", doseAmount: 9 },
            ],
          },
        },
      });
    if (request.method() === "GET" && path === "/api/v1/jobs/identity-photo")
      return route.fulfill({
        json: {
          id: "identity-photo",
          kind: "recognition",
          status: "succeeded",
          result: { status: "succeeded", medications: [photoMedication] },
        },
      });
    if (
      (request.method() === "POST" &&
        (path === "/api/v1/medications" ||
          path === "/api/v1/recognitions/identity-photo/medications/0")) ||
      (request.method() === "PUT" &&
        path === "/api/v1/medications/identity-medication")
    ) {
      saved.push(body);
      const identityReview = review(body);
      const row = {
        ...body,
        id: "identity-medication",
        revision: saved.length,
        createdAt: "2026-10-21T00:00:00Z",
        licenseNo:
          identityReview.status === "confirmed" ? candidate.licenseNo : null,
        identityReview,
      };
      medications = [row];
      return route.fulfill({ status: 201, json: row });
    }
    if (request.method() === "POST" && path === "/api/v1/bundles") {
      aiCalls.push(path);
      learning = [
        {
          id: "identity-bundle",
          medicationIds: body.medicationIds,
          result,
          answers: {},
          createdAt: "2026-10-21T00:00:00Z",
        },
      ];
      return route.fulfill({ status: 202, json: { jobId: "identity-bundle" } });
    }
    if (request.method() === "POST" && path === "/api/v1/chat") {
      aiCalls.push(path);
      chats = [
        {
          id: "identity-chat",
          medicationIds: body.medicationIds,
          question: body.question,
          result,
          createdAt: "2026-10-21T00:00:00Z",
        },
      ];
      return route.fulfill({ status: 202, json: { jobId: "identity-chat" } });
    }
    if (request.method() === "GET") {
      const replies: Record<string, any> = {
        "/api/v1/config": {
          mode: "local",
          ai: false,
          localAccounts: [{ uid: "identity-second", name: "合成第二使用者" }],
        },
        "/api/v1/me": {
          account: {
            id: accountId,
            displayName: "合成核對使用者",
            eligible: true,
            admin: false,
          },
          profile: { displayName: "合成核對使用者" },
        },
        "/api/v1/medications": { items: medications },
        "/api/v1/learning": { items: learning },
        "/api/v1/chat": { items: chats, ...historyExtra },
        "/api/v1/jobs/identity-bundle": {
          id: "identity-bundle",
          status: "succeeded",
        },
        "/api/v1/jobs/identity-chat": {
          id: "identity-chat",
          status: "succeeded",
        },
      };
      return route.fulfill({ json: replies[path] || { items: [] } });
    }
    unexpected.push(request.method() + " " + path);
    return route.abort();
  });
  return {
    saved,
    checks,
    aiCalls,
    unexpected,
    checkHandler: (handler: typeof checkHandler) => {
      checkHandler = handler;
    },
    history: (items: any[], extra: any = {}) => {
      chats = items;
      historyExtra = extra;
    },
  };
}

async function openPhotoCandidate(page: Page) {
  await page.goto("/#add?recognition=identity-photo");
  await page.locator(".capture-candidate").click();
  await expect(page.locator(".product-identity-review")).toContainText(
    "待核對候選",
  );
}

test("incomplete Secorine stays pending through save, then full package license unlocks learning and chat", async ({
  page,
}) => {
  const f = await fixture(page);
  await openPhotoCandidate(page);
  await expect(page.getByLabel("含量／規格", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("劑型", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("包裝上的完整許可證字號")).toHaveValue("");
  await expect(page.locator(".product-identity-review")).toContainText(
    "若藥袋沒印",
  );
  await page.getByLabel(usageLabel).check();
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  const card = page.locator(".med-card");
  await expect(card).toContainText("用法已確認");
  await expect(card).toContainText("產品待核對");
  await expect(
    card.getByRole("button", { name: "仿單說明", exact: true }),
  ).toBeDisabled();
  expect(f.saved[0]).toMatchObject({
    licenseNo: null,
    candidateLicenseNo: candidate.licenseNo,
    strength: "",
    form: "",
    doseAmount: 5,
    doseUnit: "毫升",
    frequencyRaw: "TID PC",
    confirmed: true,
  });
  expect(f.aiCalls).toEqual([]);
  await page.goto("/#chat");
  await expect(page.getByLabel(candidate.nameZh, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "送出", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".chat-selector")).toContainText("補齊產品資料");
  await page.goto("/#learning");
  await expect(
    page.getByRole("button", { name: "比對交互作用", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel(candidate.nameZh, { exact: true })).toHaveCount(
    0,
  );
  await page.goto("/#medications");
  await card.getByRole("button", { name: "補齊產品資料", exact: true }).click();
  await page.getByLabel("包裝上的完整許可證字號").fill("SYNTHETIC-WRONG");
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(page.locator(".product-identity-review")).toContainText(
    "完整品名與規格不足",
  );
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("5");
  await page.getByLabel("包裝上的完整許可證字號").fill(candidate.licenseNo);
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(page.locator(".product-identity-review")).toContainText(
    "產品已核對",
  );
  await page
    .getByRole("button", { name: "儲存已核對藥品與用法", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "仿單說明", exact: true }),
  ).toBeEnabled();
  await card.getByRole("button", { name: "仿單說明", exact: true }).click();
  await expect(page.locator(".medication-detail .evidence")).toBeVisible();
  await page.goto("/#chat");
  await page.getByLabel(candidate.nameZh, { exact: true }).check();
  await page.getByLabel("用藥問題").fill("合成產品怎麼保存？");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(page.locator(".chat-answer")).toBeVisible();
  expect(f.aiCalls).toEqual(["/api/v1/bundles", "/api/v1/chat"]);
  expect(f.unexpected).toEqual([]);
});

test("network retry and late response cannot confirm changed inputs; switching methods clears hidden evidence", async ({
  page,
}) => {
  const f = await fixture(page);
  await openPhotoCandidate(page);
  const license = page.getByLabel("包裝上的完整許可證字號");
  await license.fill(candidate.licenseNo);
  f.checkHandler(async (route) => {
    await route.abort();
  });
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("輸入資料與用法已保留");
  await expect(license).toHaveValue(candidate.licenseNo);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.checkHandler(async (route) => {
    await gate;
    await route.fulfill({ json: { identityReview: confirmed() } });
  });
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "核對中…", exact: true }),
  ).toBeVisible();
  await license.fill("CHANGED-WHILE-CHECKING");
  const response = page.waitForResponse("**/medications/identity-check");
  release();
  await response;
  await expect(page.locator(".product-identity-review .tag.green")).toHaveCount(
    0,
  );
  await expect(page.getByLabel("許可證字號", { exact: true })).toHaveValue(
    "產品待核對，尚未連結仿單",
  );
  f.checkHandler(undefined);
  await page
    .getByRole("radio", { name: "補充完整產品資料", exact: true })
    .check();
  await expect(page.getByLabel("包裝完整產品名稱（含廠牌／口味）")).toHaveValue(
    "",
  );
  await page.getByLabel("包裝完整產品名稱（含廠牌／口味）").fill("息咳寧");
  await page.getByLabel("包裝含量／濃度").fill(candidate.strength);
  await page.getByLabel("包裝劑型").fill(candidate.form);
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(page.locator(".product-identity-review")).toContainText(
    "完整品名與規格不足",
  );
  await page
    .getByLabel("包裝完整產品名稱（含廠牌／口味）")
    .fill(candidate.nameZh);
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(page.locator(".product-identity-review")).toContainText(
    "產品已核對",
  );
  expect(f.checks.at(-1).identityEvidence.printedLicenseNo).toBe("");
  await page.getByLabel("含量／規格", { exact: true }).fill("另一個規格");
  await expect(page.locator(".product-identity-review .tag.green")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "保存待核對資料", exact: true }),
  ).toBeVisible();
  expect(f.aiCalls).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test("retake preserves unsaved usage through a rejected upload and a separate new recognition", async ({
  page,
}) => {
  const f = await fixture(page);
  await openPhotoCandidate(page);
  await page.getByLabel("每次劑量", { exact: true }).fill("7");
  await page
    .getByRole("textbox", { name: "用法備註", exact: true })
    .fill("原處方待補資料，請保留");
  await page.getByLabel("包裝上的完整許可證字號").fill("尚未抄完");
  await page
    .getByRole("button", { name: "返回補拍／上傳", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "上傳照片", exact: true }),
  ).toBeVisible();
  await page.getByLabel("藥袋照片", { exact: true }).setInputFiles({
    name: "wrong.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toContainText("JPEG");
  await page
    .getByRole("button", { name: "返回尚未保存的核對資料", exact: true })
    .click();
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("7");
  await expect(
    page.getByRole("textbox", { name: "用法備註", exact: true }),
  ).toHaveValue("原處方待補資料，請保留");
  await expect(page.getByLabel("包裝上的完整許可證字號")).toHaveValue(
    "尚未抄完",
  );
  await page
    .getByRole("button", { name: "返回補拍／上傳", exact: true })
    .click();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByLabel("藥袋照片", { exact: true }).setInputFiles({
    name: "new-package.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByAltText("本次選擇的藥袋照片，請確認文字清晰"),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "新照片會另作一次辨識" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "另一張照片的合成藥", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "返回尚未保存的核對資料", exact: true })
    .click();
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("7");
  await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
    candidate.nameZh,
  );
  await expect(
    page.getByRole("textbox", { name: "用法備註", exact: true }),
  ).toHaveValue("原處方待補資料，請保留");
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  expect(f.saved[0]).toMatchObject({
    doseAmount: 7,
    instructions: "原處方待補資料，請保留",
    rawText: photoMedication.rawText,
  });
  expect(f.aiCalls).toEqual(["/api/v1/recognitions"]);
  expect(f.unexpected).toEqual([]);
});

test("legacy products and unsafe old chat answers require package review", async ({
  page,
}) => {
  const f = await fixture(page, [
    {
      id: "legacy",
      name: "舊版未核對產品",
      confirmed: true,
      licenseNo: candidate.licenseNo,
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
    },
  ]);
  f.history(
    [
      {
        id: "unsafe",
        question: "舊提問",
        medicationIds: ["legacy"],
        identityReviewRequired: true,
        result: {
          ...result,
          claims: [{ text: "不應顯示的舊產品回答", citations: [] }],
        },
      },
    ],
    { hiddenUnsafeCount: 1, identityReviewRequired: true },
  );
  await page.goto("/#medications");
  await expect(page.locator(".med-card")).toContainText("產品待核對");
  await expect(
    page.getByRole("button", { name: "仿單說明", exact: true }),
  ).toBeDisabled();
  await page.goto("/#chat");
  await expect(
    page.getByText("不應顯示的舊產品回答", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".chat-exchange")).toContainText("已隱藏回答");
  await expect(page.locator(".chat-selector input[type=checkbox]")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "送出", exact: true }),
  ).toBeDisabled();
  expect(f.aiCalls).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test("an old account's delayed identity response cannot populate a new account's review", async ({
  page,
}) => {
  const f = await fixture(page);
  await openPhotoCandidate(page);
  await page.getByLabel("包裝上的完整許可證字號").fill(candidate.licenseNo);
  await page
    .getByRole("textbox", { name: "用法備註", exact: true })
    .fill("第一個帳號的尚未保存資料");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.checkHandler(async (route) => {
    await gate;
    await route.fulfill({ json: { identityReview: confirmed() } });
  });
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "核對中…", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page
    .getByRole("button", { name: "合成第二使用者", exact: true })
    .click();
  await page.evaluate(() => {
    location.hash = "#add?recognition=identity-photo";
  });
  await page.locator(".capture-candidate").click();
  const oldResponse = page.waitForResponse("**/medications/identity-check");
  release();
  await oldResponse;
  await expect(page.getByLabel("包裝上的完整許可證字號")).toHaveValue("");
  await expect(
    page.getByRole("textbox", { name: "用法備註", exact: true }),
  ).toHaveValue("");
  await expect(page.locator(".product-identity-review .tag.green")).toHaveCount(
    0,
  );
  await expect(page.getByLabel("許可證字號", { exact: true })).toHaveValue(
    "產品待核對，尚未連結仿單",
  );
  expect(f.saved).toEqual([]);
  expect(f.aiCalls).toEqual([]);
  expect(f.unexpected).toEqual([]);
});
