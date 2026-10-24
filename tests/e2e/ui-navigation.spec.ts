import { expect, test, type Page } from "@playwright/test";

function forbidAutomaticAi(page: Page) {
  const requests: string[] = [];
  return {
    requests,
    async start() {
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (
          request.method() === "POST" &&
          (/\/api\/v1\/(recognitions|bundles|chat|interactions)$/.test(path) ||
            /\/api\/v1\/(?:admin\/)?jobs\/[^/]+\/retry$/.test(path))
        ) {
          requests.push(path);
          await route.abort();
          return;
        }
        await route.continue();
      });
    },
  };
}

test("daily navigation, More and the separate saved demonstration are reachable", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ai = forbidAutomaticAi(page);
  await ai.start();
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  const mobile = info.project.name === "mobile";
  const navigation = page.getByRole("navigation", {
    name: mobile ? "手機主要導覽" : "主要導覽",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  if (mobile) {
    await expect(navigation.locator(":scope > *")).toHaveCount(5);
    await expect(navigation.getByRole("link")).toHaveText([
      "今日",
      "藥品",
      "拍藥袋",
      "小教室",
    ]);
    await expect(
      navigation.locator('a[href="#care"], a[href="#chat"]'),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: "更多功能", exact: true }),
    ).toBeVisible();
  }
  for (const route of mobile
    ? ["home", "medications", "add", "learning"]
    : ["home", "medications", "learning"]) {
    const link = navigation.locator(`a[href="#${route}"]`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/#${route}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    if (mobile && route !== "home")
      await expect(page.locator("#main h1")).toBeFocused();
  }
  for (const route of ["care", "chat"]) {
    if (mobile) {
      const more = navigation.getByRole("button", {
        name: "更多功能",
        exact: true,
      });
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(more).toHaveAttribute("aria-expanded", "true");
    }
    await page
      .getByRole("navigation", { name: "主要導覽", exact: true })
      .locator(`a[href="#${route}"]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`/#${route}$`));
    await expect(
      page.getByRole("heading", {
        name: route === "care" ? "家人照護" : "用藥問答",
        exact: true,
      }),
    ).toBeVisible();
    if (mobile) {
      await expect(page.locator("#main h1")).toBeFocused();
      await expect(
        navigation.getByRole("button", { name: "更多功能", exact: true }),
      ).toHaveAttribute("aria-expanded", "false");
    }
  }
  if (mobile)
    await navigation
      .getByRole("button", { name: "更多功能", exact: true })
      .click();
  await page.locator('.sidebar a[href="#demo"]').click();
  await expect(page).toHaveURL(/\/#demo$/);
  await expect(
    page.getByRole("heading", { name: "研討會展示", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("已保存結果", { exact: true })).toBeVisible();
  if (mobile)
    await navigation
      .getByRole("button", { name: "更多功能", exact: true })
      .click();
  await page.locator('.sidebar a[href="#jobs"]').click();
  await expect(
    page.getByRole("heading", { name: "處理紀錄與恢復", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(ai.requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("learning index, one record and saved demo deep links retain the selected content on reload", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90000);
  const { token } = await (
    await request.post("/api/v1/auth/local", {
      data: { uid: "local-owner" },
    })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const existing = (
    await (await request.get("/api/v1/medications", { headers })).json()
  ).items;
  for (const med of existing)
    await request.delete("/api/v1/medications/" + med.id, { headers });
  await request.put("/api/v1/me", {
    headers,
    data: { displayName: "導覽合成人", age: 32, conditions: ["合成情境A"] },
  });
  const expected: { id: string; name: string }[] = [];
  for (const strength of [5, 10]) {
    const name = `單筆導覽-${info.project.name}-${strength}mg`;
    const med = await (
      await request.post("/api/v1/medications", {
        headers,
        data: {
          name,
          licenseNo: `SYNTHETIC-E2E-${strength}`,
          identityEvidence: {
            method: "license",
            printedLicenseNo: `SYNTHETIC-E2E-${strength}`,
          },
          doseAmount: 1,
          doseUnit: "錠",
          frequencyRaw: "QD",
          confirmed: true,
        },
      })
    ).json();
    // Only the isolated local mock upstream prepares these synthetic records.
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
        { timeout: 20000 },
      )
      .toBe("succeeded");
    expected.push({ id: queued.jobId, name });
  }
  const before = (
    await (await request.get("/api/v1/learning", { headers })).json()
  ).items;
  const jobsBefore = (
    await (await request.get("/api/v1/jobs", { headers })).json()
  ).items.length;
  const ai = forbidAutomaticAi(page);
  await ai.start();
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#learning");
  await expect(page.locator(".learning-index-card")).toHaveCount(2);
  await expect(
    page.locator(".learning-record, .learning-index .quiz"),
  ).toHaveCount(0);
  const first = expected[0],
    second = expected[1];
  await page
    .locator(`.learning-index-card[data-learning-id="${first.id}"]`)
    .getByRole("link", { name: "開始學習", exact: true })
    .click();
  const detail = page.locator(".learning-record");
  await expect(detail).toHaveCount(1);
  await expect(detail).toHaveAttribute("data-learning-id", first.id);
  await expect(detail).toContainText(first.name);
  await expect(page.locator(".learning-index-card")).toHaveCount(0);
  const readingNav = detail.getByRole("navigation", {
    name: "這份說明的閱讀段落",
    exact: true,
  });
  for (const [section, label] of [
    ["reading", "用途與用法"],
    ["warnings", "警語與注意事項"],
    ["quiz", "理解測驗"],
  ]) {
    await readingNav.getByRole("button", { name: new RegExp(label) }).click();
    const target = page.locator(`[id="${section}-${first.id}"]`);
    await expect(
      section === "quiz" ? target.locator("legend") : target,
    ).toBeFocused();
    expect(new URL(page.url()).hash).toContain("#learning?record=" + first.id);
  }
  for (const section of ["reading", "warnings", "quiz"]) {
    const url = `/#learning?record=${encodeURIComponent(first.id)}&section=${section}&from=demo`;
    await page.evaluate((hash) => {
      location.hash = hash;
    }, url.slice(1));
    const target = page.locator(`[id="${section}-${first.id}"]`);
    await expect(
      section === "quiz" ? target.locator("legend") : target,
    ).toBeFocused();
    await expect(page.locator("main h1")).not.toBeFocused();
    await page.reload();
    await expect(page).toHaveURL(
      new RegExp(
        `#learning\\?record=${first.id}&section=${section}&from=demo$`,
      ),
    );
    await expect(detail).toHaveCount(1);
    await expect(detail).toHaveAttribute("data-learning-id", first.id);
    await expect(
      section === "quiz" ? target.locator("legend") : target,
    ).toBeFocused();
  }
  await page
    .getByRole("link", { name: "返回全部藥品", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/#learning\?from=demo$/);
  await page
    .locator(`.learning-index-card[data-learning-id="${second.id}"]`)
    .getByRole("link", { name: "開始學習", exact: true })
    .click();
  await expect(detail).toHaveAttribute("data-learning-id", second.id);
  await expect(detail).toContainText(second.name);
  await page
    .getByRole("link", { name: "返回展示入口", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#demo\\?record=${second.id}(?:&step=reading)?$`),
  );
  await expect(page.getByLabel("選擇展示藥品", { exact: true })).toHaveValue(
    second.id,
  );
  for (const [step, heading] of [
    ["recognition", "藥袋辨識"],
    ["reading", "仿單說明"],
    ["quiz", "理解測驗"],
  ]) {
    await page.goto(
      `/#demo?record=${encodeURIComponent(second.id)}&step=${step}`,
    );
    await page.reload();
    await expect(page.getByLabel("選擇展示藥品", { exact: true })).toHaveValue(
      second.id,
    );
    const stage = page.getByRole("region", { name: heading, exact: true });
    await expect(
      stage.getByRole("heading", { name: heading, exact: true, level: 2 }),
    ).toBeVisible();
    if (step === "recognition")
      await expect(
        stage.getByText(
          "這款藥品沒有對應的已保存辨識紀錄，可繼續查看已保存的說明，或另拍一張藥袋。",
          { exact: true },
        ),
      ).toBeVisible();
    else if (step === "reading") {
      await expect(stage.locator(`[id="reading-${second.id}"]`)).toBeVisible();
      await expect(stage.locator(".quiz")).toHaveCount(0);
    } else
      await expect(stage.locator(`[id="quiz-${second.id}"]`)).toBeVisible();
  }
  await page.getByRole("link", { name: "回到完整說明", exact: true }).click();
  await expect(detail).toHaveAttribute("data-learning-id", second.id);
  await expect(page).toHaveURL(
    new RegExp(`#learning\\?record=${second.id}&section=reading&from=demo$`),
  );
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  const mobile = info.project.name === "mobile";
  await page
    .getByRole("navigation", {
      name: mobile ? "手機主要導覽" : "主要導覽",
      exact: true,
    })
    .locator(`a[href="#${mobile ? "add" : "medications"}"]`)
    .click();
  const destinationTitle = page.getByRole("heading", {
    name: mobile ? "新增藥品" : "我的藥品",
    exact: true,
    level: 1,
  });
  await expect(destinationTitle).toBeFocused();
  await expect
    .poll(async () => (await destinationTitle.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(0);
  await expect(destinationTitle).toBeInViewport();
  await page.goto(
    "/#learning?record=synthetic-missing-record&section=quiz&from=demo",
  );
  await expect(
    page.getByRole("heading", { name: "找不到這份學習內容", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".learning-record, .quiz")).toHaveCount(0);
  await page
    .getByRole("link", { name: "返回全部藥品", exact: true })
    .first()
    .click();
  await expect(page.locator(".learning-index-card")).toHaveCount(2);
  expect(
    (await (await request.get("/api/v1/jobs", { headers })).json()).items
      .length,
  ).toBe(jobsBefore);
  expect(
    (await (await request.get("/api/v1/learning", { headers })).json()).items,
  ).toEqual(before);
  expect(ai.requests).toEqual([]);
  // Refreshing the Demo summary after grading must keep the current question.
  await page.goto(`/#demo?record=${encodeURIComponent(second.id)}&step=quiz`);
  const quiz = page.locator(`[id="quiz-${second.id}"]`);
  await quiz.getByLabel("不可以，只供軟體測試", { exact: true }).check();
  let refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/learning",
  );
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await refreshed;
  await expect(quiz.locator("legend")).toContainText("第 1／2 題");
  await quiz.getByRole("button", { name: "下一題", exact: true }).click();
  await expect(quiz.locator("legend")).toContainText("第 2／2 題");
  await quiz.getByLabel("可以直接判定安全", { exact: true }).check();
  refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/learning",
  );
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await refreshed;
  await expect(quiz.locator("legend")).toContainText("第 2／2 題");
  await expect(quiz.getByText(/再看一下：/)).toBeVisible();
  await expect(
    quiz.getByLabel("可以直接判定安全", { exact: true }),
  ).toBeChecked();
  await page.reload();
  await expect(quiz.locator("legend")).toContainText("第 2／2 題");
  await quiz.getByLabel("不可以，需確認資料", { exact: true }).check();
  refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/learning",
  );
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await refreshed;
  await expect(
    quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
  ).toBeVisible();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).toBeVisible();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).not.toBeFocused();
  await quiz.getByRole("button", { name: "重新複習", exact: true }).click();
  await quiz.getByLabel("可以", { exact: true }).check();
  refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/learning",
  );
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await refreshed;
  await expect(quiz.locator("legend")).toContainText("第 1／2 題");
  await expect(quiz.getByText(/再看一下：/)).toBeVisible();
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).toHaveCount(0);
  await quiz.getByLabel("不可以，只供軟體測試", { exact: true }).check();
  refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/learning",
  );
  await quiz.getByRole("button", { name: "檢查答案", exact: true }).click();
  await refreshed;
  await expect(quiz.locator("legend")).toContainText("第 1／2 題");
  await expect(
    quiz.getByRole("group", { name: "理解測驗完成", exact: true }),
  ).toHaveCount(0);
  const saved = (
    await (await request.get("/api/v1/learning", { headers })).json()
  ).items.find((row: any) => row.id === second.id);
  expect(saved.answers).toEqual({ q0: 0, q1: 0 });
  expect(saved.progress.passed).toBe(true);
  expect(
    (await (await request.get("/api/v1/jobs", { headers })).json()).items
      .length,
  ).toBe(jobsBefore);
  expect(ai.requests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a new mocked demonstration photograph keeps its saved medication and learning through all steps", async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const { token } = await (
    await request.post("/api/v1/auth/local", {
      data: { uid: "local-owner" },
    })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const meds = (
    await (await request.get("/api/v1/medications", { headers })).json()
  ).items;
  for (const med of meds)
    await request.delete("/api/v1/medications/" + med.id, { headers });
  const aiPosts: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      /^\/api\/v1\/(recognitions|bundles|chat|interactions)$/.test(path)
    )
      aiPosts.push(path);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#demo");
  await page.getByRole("link", { name: "從辨識藥袋開始", exact: true }).click();
  await expect(page).toHaveURL(/#add\?from=demo$/);
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-demo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/recognitions",
  );
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  const recognition = (await (await response).json()).jobId;
  await page
    .locator(".search-result")
    .filter({ hasText: "流程測試片 5mg" })
    .click();
  await page.getByLabel("每次劑量", { exact: true }).fill("1");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("QD");
  await page
    .getByLabel("包裝上的完整許可證字號", { exact: true })
    .fill("SYNTHETIC-E2E-5");
  await page.getByRole("button", { name: "核對產品資料", exact: true }).click();
  await expect(
    page.getByText("包裝資料已與官方藥品資料核對。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("我已對照藥袋確認用法（每次用量、頻次與途徑）").check();
  await page
    .getByRole("button", { name: "儲存已核對藥品與用法", exact: true })
    .click();
  await expect(page).toHaveURL(
    /#medications\?from=demo&medication=[^&]+&saved=[^&]+$/,
  );
  const medicationId = new URLSearchParams(
    new URL(page.url()).hash.split("?")[1],
  ).get("medication");
  expect(medicationId).toBeTruthy();
  await expect(page.locator(".demo-context")).toContainText(
    "流程測試片 5mg已儲存",
  );
  await page
    .locator(".med-card")
    .filter({ hasText: "流程測試片 5mg" })
    .getByRole("button", { name: "仿單說明", exact: true })
    .click();
  const continueDemo = page.getByRole("link", {
    name: "帶這份說明繼續展示",
    exact: true,
  });
  await expect(continueDemo).toBeVisible({ timeout: 20000 });
  const href = await continueDemo.getAttribute("href");
  const learningId = new URLSearchParams(href!.split("?")[1]).get("record")!;
  expect(learningId).toBeTruthy();
  await continueDemo.click();
  await expect(page).toHaveURL(
    new RegExp(`#demo\\?record=${learningId}&step=reading$`),
  );
  await expect(page.getByLabel("選擇展示藥品", { exact: true })).toHaveValue(
    learningId,
  );
  await page
    .getByRole("link", { name: "下一步：理解測驗", exact: true })
    .click();
  await expect(page.locator(`[id="quiz-${learningId}"]`)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("選擇展示藥品", { exact: true })).toHaveValue(
    learningId,
  );
  await page
    .getByRole("navigation", { name: "展示步驟", exact: true })
    .getByRole("link", { name: "1. 藥袋辨識", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "開啟辨識紀錄", exact: true }),
  ).toHaveAttribute(
    "href",
    `#add?recognition=${encodeURIComponent(recognition)}&from=demo&record=${encodeURIComponent(learningId)}`,
  );
  const saved = (
    await (await request.get("/api/v1/learning", { headers })).json()
  ).items.find((row: any) => row.id === learningId);
  expect(saved.medicationIds).toEqual([medicationId]);
  expect(aiPosts).toEqual(["/api/v1/recognitions", "/api/v1/bundles"]);
});
