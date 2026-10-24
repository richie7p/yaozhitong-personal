import { expect, test } from "@playwright/test";

test("personal education, one-question feedback, saved progress and keyboard operation", async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const meds = (
    await (await request.get("/api/v1/medications", { headers })).json()
  ).items;
  for (const med of meds)
    await request.delete("/api/v1/medications/" + med.id, { headers });
  await request.put("/api/v1/me", {
    headers,
    data: { displayName: "合成成人", age: 32, conditions: ["合成情境A"] },
  });
  const med = await (
    await request.post("/api/v1/medications", {
      headers,
      data: {
        name: "流程測試片 5mg",
        licenseNo: "SYNTHETIC-E2E-5",
        identityEvidence: {
          method: "license",
          printedLicenseNo: "SYNTHETIC-E2E-5",
        },
        doseAmount: 2,
        doseUnit: "錠",
        frequencyRaw: "QD",
        confirmed: true,
      },
    })
  ).json();
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  await page
    .locator(".med-card")
    .getByRole("button", { name: "仿單說明" })
    .click();
  const evidence = page.locator(".evidence");
  await expect(
    evidence.getByRole("heading", { name: "藥品用途", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(evidence.locator(".confirmed-usage")).toContainText(
    "每次 2 錠 · QD",
  );
  await expect(evidence.locator(".personal-precautions")).toContainText(
    "健康狀況：合成情境A",
  );
  await expect(
    evidence.getByText("完整提醒：這份資料不可作為用藥依據。", { exact: true }),
  ).toBeVisible();
  let quiz = evidence.locator(".quiz");
  await expect(quiz.locator("fieldset")).toHaveCount(1);
  await expect(
    quiz.getByRole("button", { name: "下一題", exact: true }),
  ).toBeDisabled();
  await quiz.getByLabel("可以", { exact: true }).check();
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await expect(quiz.getByText(/再看一下：/)).toBeVisible();
  const feedbackSource = quiz.locator(".quiz-feedback blockquote");
  await expect(feedbackSource).toHaveCount(1);
  await expect(feedbackSource).toBeVisible();
  await expect(feedbackSource).toContainText(
    "注意事項：本文件完全為合成資料，僅供軟體流程測試，不可作為用藥依據。合成情境A的讀者應閱讀說明；未記載不能判斷安全。",
  );
  await expect(quiz.locator(".quiz-progress")).toContainText("已作答 1／2 題");
  const jobsBeforeReopening = (
    await (await request.get("/api/v1/jobs", { headers })).json()
  ).items.length;
  await page.goto("/#home");
  await page.goto("/#medications");
  await page
    .locator(".med-card")
    .getByRole("button", { name: "仿單說明" })
    .click();
  await expect(
    page.locator(".quiz").getByLabel("可以", { exact: true }),
  ).toBeChecked();
  expect(
    (await (await request.get("/api/v1/jobs", { headers })).json()).items
      .length,
  ).toBe(jobsBeforeReopening);
  // A wrong answer must not block reminders.
  expect(
    (
      await request.post("/api/v1/schedules", {
        headers,
        data: {
          medicationId: med.id,
          times: ["23:59"],
          startDate: new Date().toLocaleDateString("en-CA", {
            timeZone: "Asia/Taipei",
          }),
        },
      })
    ).ok(),
  ).toBe(true);
  const learning = (
    await (await request.get("/api/v1/learning", { headers })).json()
  ).items.find((row: any) => row.medicationIds.includes(med.id));
  const recordUrl = `/#learning?record=${encodeURIComponent(learning.id)}&section=quiz`;
  await page.goto(recordUrl);
  const record = page.locator(
    `.learning-record[data-learning-id="${learning.id}"]`,
  );
  quiz = record.locator(".quiz");
  await expect(record).toHaveCount(1);
  await expect(quiz.getByLabel("可以", { exact: true })).toBeChecked();
  // In-page hash navigation remounts Evidence without refetching the directory.
  // It must reuse the saved answer as well as the updated progress badge.
  await page
    .locator(".learning-toolbar")
    .getByRole("link", {
      name: "返回全部藥品",
      exact: true,
    })
    .click();
  const directoryRow = page.locator(
    `.learning-index-card[data-learning-id="${learning.id}"]`,
  );
  await expect(directoryRow).toContainText("已作答 1／2 題");
  await directoryRow
    .getByRole("link", { name: "繼續學習", exact: true })
    .click();
  await expect(quiz.getByLabel("可以", { exact: true })).toBeChecked();
  await expect(quiz.locator(".quiz-progress")).toContainText("已作答 1／2 題");
  await page.reload();
  await expect(quiz.getByLabel("可以", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto(recordUrl);
  await expect(quiz.getByLabel("可以", { exact: true })).toBeChecked();
  await quiz.getByLabel("不可以，只供軟體測試", { exact: true }).focus();
  await page.keyboard.press("Space");
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(quiz.getByText(/答對了。/)).toBeVisible();
  await quiz.getByRole("button", { name: "下一題", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(quiz.locator("legend")).toContainText("第 2／2 題");
  await expect(quiz.locator("fieldset")).toHaveCount(1);
  await quiz.getByLabel("可以直接判定安全", { exact: true }).check();
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await expect(quiz.getByText(/再看一下：/)).toBeVisible();
  await expect(quiz.getByText("已作答 2／2 題 · 已答對 1 題")).toBeVisible();
  const saved = (
    await (await request.get("/api/v1/learning", { headers })).json()
  ).items[0];
  expect(saved.answers).toEqual({ q0: 0, q1: 1 });
  expect(saved.progress.status).toBe("in_progress");
  await page
    .locator(".learning-toolbar")
    .getByRole("link", {
      name: "返回全部藥品",
      exact: true,
    })
    .click();
  await expect(directoryRow).toContainText("已作答 2／2 題 · 已答對 1 題");
  await directoryRow
    .getByRole("link", { name: "繼續學習", exact: true })
    .click();
  await expect(
    quiz.getByLabel("可以直接判定安全", { exact: true }),
  ).toBeChecked();
  await expect(quiz.locator(".quiz-progress")).toContainText(
    "已作答 2／2 題 · 已答對 1 題",
  );
  await quiz.getByLabel("不可以，需確認資料", { exact: true }).check();
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await expect(
    quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
  ).toBeVisible();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).toBeFocused();
  await page
    .locator(".learning-toolbar")
    .getByRole("link", {
      name: "返回全部藥品",
      exact: true,
    })
    .click();
  await expect(directoryRow).toContainText("已作答 2／2 題 · 已答對 2 題");
  await expect(
    directoryRow.getByText("測驗已完成", { exact: true }),
  ).toBeVisible();
  const coverage = directoryRow.getByRole("complementary", {
    name: "白話說明與測驗範圍",
  });
  await expect(coverage).toContainText("本次白話整理：0／1 個來源欄位完成");
  await expect(coverage).toContainText("尚未完整整理：注意事項");
  await directoryRow
    .getByRole("link", { name: "重新複習", exact: true })
    .click();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
  ).toBeVisible();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).not.toBeFocused();
  await page.screenshot({
    path: "test-results/learning-" + info.project.name + ".png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // Native details must expose evidence using the keyboard.
  const source = record.getByText("對照仿單原文", { exact: true }).first();
  await source.focus();
  await page.keyboard.press("Enter");
  await expect(record.locator("blockquote").first()).toBeVisible();
  // The UI stops an old quiz when the real backend reports stale content.
  await quiz.getByRole("button", { name: "重新複習", exact: true }).click();
  await quiz.getByLabel("可以", { exact: true }).check();
  await request.put("/api/v1/me", {
    headers,
    data: { displayName: "更新後合成成人", age: 33 },
  });
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await expect(
    quiz.getByRole("link", { name: "回到我的藥品，重新產生說明" }),
  ).toBeVisible();
  await expect(quiz.locator("fieldset")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".learning-record")).toHaveCount(0);
});

test("unconfirmed product keeps confirmed usage and offers a usable next step without creating AI work", async ({
  page,
  request,
}) => {
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const aiRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      /^\/api\/v1\/(recognitions|bundles|chat|interactions)$/.test(path)
    )
      aiRequests.push(path);
  });
  const name = "尚無來源-" + Date.now();
  await request.post("/api/v1/medications", {
    headers,
    data: {
      name,
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  const card = page.locator(".med-card").filter({ hasText: name });
  await expect(card.getByRole("button", { name: "仿單說明" })).toBeDisabled();
  await expect(card.locator(".usage-box strong")).toHaveText("1 錠");
  await expect(card).toContainText("產品待核對");
  await expect(page.locator(".quiz")).toHaveCount(0);
  await card.getByRole("button", { name: "補齊產品資料", exact: true }).click();
  await expect(
    page.getByLabel("包裝上的完整許可證字號", { exact: true }),
  ).toBeVisible();
  expect(aiRequests).toEqual([]);
});

test("literal source mentions explain the limited match while the saved quiz remains usable", async ({
  page,
  request,
}, info) => {
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const meds = (
    await (await request.get("/api/v1/medications", { headers })).json()
  ).items;
  for (const med of meds)
    await request.delete("/api/v1/medications/" + med.id, { headers });
  await request.put("/api/v1/me", {
    headers,
    data: { displayName: "字詞提示合成人", age: 32, conditions: ["合成情境A"] },
  });
  const name = "字詞提示測試片-" + info.project.name;
  const med = await (
    await request.post("/api/v1/medications", {
      headers,
      data: {
        name,
        licenseNo: "SYNTHETIC-E2E-5",
        identityEvidence: {
          method: "license",
          printedLicenseNo: "SYNTHETIC-E2E-5",
        },
        doseAmount: 1,
        doseUnit: "錠",
        frequencyRaw: "QD",
        confirmed: true,
      },
    })
  ).json();
  const queued = await (
    await request.post("/api/v1/bundles", {
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      data: { medicationIds: [med.id] },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get("/api/v1/jobs/" + queued.jobId, { headers })
          ).json()
        ).status,
    )
    .toBe("succeeded");
  const saved = await (
    await request.get("/api/v1/jobs/" + queued.jobId, { headers })
  ).json();
  expect(
    saved.result.claims.some((c: any) =>
      c.sourceMentions?.some(
        (ref: any) => ref.field === "conditions" && ref.value === "合成情境A",
      ),
    ),
  ).toBe(true);

  // The unit suite checks the false relevance verdict. This display fixture
  // removes independently approved relevance labels, retaining only the real
  // backend's literal metadata; grading still reaches the persisted backend row.
  await page.route("**/api/v1/learning", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const row of data.items)
      if (row.id === queued.jobId)
        for (const claim of row.result.claims) delete claim.profileRefs;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto(
    `/#learning?record=${encodeURIComponent(queued.jobId)}&section=warnings`,
  );
  const record = page.locator(
    `.learning-record[data-learning-id="${queued.jobId}"]`,
  );
  await expect(record).toHaveCount(1);
  await expect(
    record.locator(".personal-precautions .source-mention"),
  ).toHaveText("仿單原文提到你填寫的「合成情境A」；請對照原文中的適用條件。");
  await expect(
    record.getByText("參考你填寫的資料：", { exact: true }),
  ).toHaveCount(0);
  await expect(record.locator(".personal-precautions")).not.toContainText(
    "適合此藥",
  );
  const quiz = record.locator(".quiz");
  await quiz.getByLabel("不可以，只供軟體測試", { exact: true }).check();
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await expect(quiz.getByText(/答對了。/)).toBeVisible();
  await page.screenshot({
    path: "test-results/source-mention-" + info.project.name + ".png",
    fullPage: true,
  });
});
