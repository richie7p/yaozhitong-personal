import { test, expect, type APIRequestContext } from "@playwright/test";

async function medicationPair(request: APIRequestContext) {
  const login = await request.post("/api/v1/auth/local", {
    data: { uid: "local-owner" },
  });
  expect(login.ok()).toBe(true);
  const { token } = await login.json();
  const headers = { authorization: "Bearer " + token };
  const suffix = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const medications = [];
  for (const [label, doseAmount, frequencyRaw] of [
    ["甲", 1, "QD"],
    ["乙", 2, "BID"],
  ] as const) {
    const response = await request.post("/api/v1/medications", {
      headers,
      data: {
        name: `切換測試${label}-${suffix}`,
        doseAmount,
        doseUnit: "錠",
        frequencyRaw,
        confirmed: true,
      },
    });
    expect(response.ok()).toBe(true);
    medications.push(await response.json());
  }
  return { headers, first: medications[0], second: medications[1] };
}

test("switching medication editors loads the selected medication and saves only it", async ({
  page,
  request,
}) => {
  const { headers, first, second } = await medicationPair(request);
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  const firstCard = page.locator(".med-card").filter({ hasText: first.name });
  const secondCard = page.locator(".med-card").filter({ hasText: second.name });
  await firstCard.getByRole("button", { name: "編輯用法" }).click();
  await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
    first.name,
  );
  await page.getByLabel("每次劑量", { exact: true }).fill("6");

  await secondCard.getByRole("button", { name: "編輯用法" }).click();
  await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
    second.name,
  );
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue("BID");
  await page.getByLabel("每次劑量", { exact: true }).fill("3");
  await page
    .getByRole("button", { name: "確認並儲存藥品", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "編輯用法", exact: true }),
  ).toHaveCount(0);
  await expect(secondCard.locator(".usage-box")).toContainText("3 錠");

  const response = await request.get("/api/v1/medications", { headers });
  expect(response.ok()).toBe(true);
  const { items } = await response.json();
  expect(items.find((m: any) => m.id === first.id)).toMatchObject({
    name: first.name,
    doseAmount: 1,
    frequencyRaw: "QD",
    revision: first.revision,
  });
  expect(items.find((m: any) => m.id === second.id)).toMatchObject({
    name: second.name,
    doseAmount: 3,
    frequencyRaw: "BID",
    revision: second.revision + 1,
  });
});

test("switching reminder forms clears the previous medication's unsaved dates and times", async ({
  page,
  request,
}) => {
  const { headers, first, second } = await medicationPair(request);
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  const firstCard = page.locator(".med-card").filter({ hasText: first.name });
  const secondCard = page.locator(".med-card").filter({ hasText: second.name });
  await firstCard.getByRole("button", { name: "排定提醒" }).click();
  await page.getByLabel("每天提醒時間").fill("08:00, 20:00");
  await page.getByLabel("開始日期", { exact: true }).fill("2030-01-02");
  await page
    .getByLabel("結束日期（可留白）", { exact: true })
    .fill("2030-01-09");

  await secondCard.getByRole("button", { name: "排定提醒" }).click();
  await expect(
    page.getByRole("heading", { name: "排定提醒 · " + second.name }),
  ).toBeVisible();
  await expect(page.getByLabel("每天提醒時間")).toHaveValue("");
  await expect(
    page.getByLabel("結束日期（可留白）", { exact: true }),
  ).toHaveValue("");
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(
      new Date(),
    ),
  );
  await expect(page.getByLabel("開始日期", { exact: true })).toHaveValue(today);
  await page.getByLabel("每天提醒時間").fill("17:30");
  await page.getByRole("button", { name: "確認提醒時間", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "確認提醒時間", exact: true }),
  ).toHaveCount(0);

  const response = await request.get("/api/v1/schedules", { headers });
  expect(response.ok()).toBe(true);
  const { items } = await response.json();
  expect(items.some((s: any) => s.medicationId === first.id)).toBe(false);
  expect(items.find((s: any) => s.medicationId === second.id)).toMatchObject({
    times: ["17:30"],
    startDate: today,
    endDate: null,
    active: true,
  });
});

test("chat reports failed reads instead of presenting an empty medication list", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天的用藥日常/ }),
  ).toBeVisible();
  for (const [path, message] of [
    ["medications", "藥品讀取測試失敗"],
    ["chat", "問答讀取測試失敗"],
  ]) {
    await page.route("**/api/v1/" + path, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "unavailable", message }),
      }),
    );
  }
  await page.goto("/#chat");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "無法讀取藥品：藥品讀取測試失敗" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "無法讀取問答紀錄：問答讀取測試失敗" }),
  ).toBeVisible();
  await expect(
    page.getByText("先新增並確認藥品，才能開始問答。", { exact: true }),
  ).toHaveCount(0);
});

test("failed medication removal keeps the card and presents the error", async ({
  page,
  request,
}) => {
  const { first } = await medicationPair(request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  const card = page.locator(".med-card").filter({ hasText: first.name });
  await expect(card).toBeVisible();
  await page.route("**/api/v1/medications/" + first.id, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "unavailable",
        message: "移除測試失敗，請重試。",
      }),
    }),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await card
    .getByRole("button", { name: "移除" + first.name, exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "移除測試失敗，請重試。" }),
  ).toBeVisible();
  await expect(card).toBeVisible();
  expect(errors).toEqual([]);
});

test("skip link focuses the current page without losing unsaved medication input", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.getByRole("button", { name: "手動建檔", exact: true }).click();
  await page.getByLabel("藥品名稱", { exact: true }).fill("尚未儲存的藥品資料");
  await page.getByRole("link", { name: "跳到主要內容", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/#add$/);
  await expect(page.locator("main")).toBeFocused();
  await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
    "尚未儲存的藥品資料",
  );
});

test("multiple recognized medications can be saved one by one without repeating recognition", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/v1/auth/local", {
    data: { uid: "local-owner" },
  });
  const { token } = await login.json();
  const headers = { authorization: "Bearer " + token };
  const suffix = Date.now().toString();
  const names = ["多筆辨識甲-" + suffix, "多筆辨識乙-" + suffix];
  const jobId = "synthetic-multiple-" + suffix;
  // This test isolates the multi-row editor. The recovery test exercises the real recognition-save endpoint.
  await page.route(
    "**/api/v1/recognitions/" + jobId + "/medications/*",
    async (route) => {
      const response = await request.post("/api/v1/medications", {
        headers,
        data: route.request().postDataJSON(),
      });
      await route.fulfill({ response });
    },
  );
  let recognitionRequests = 0;
  await page.route("**/api/v1/recognitions", (route) => {
    recognitionRequests++;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId }),
    });
  });
  await page.route("**/api/v1/jobs/" + jobId, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: jobId,
        status: "succeeded",
        result: {
          status: "succeeded",
          medications: names.map((name, index) => ({
            name,
            doseAmount: index + 1,
            doseUnit: "錠",
            frequencyRaw: "QD",
            rawText: "僅供多筆資料保存流程測試",
          })),
        },
      }),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-multiple.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "開始辨識" }).click();
  await expect(
    page.getByRole("heading", { name: names[0], exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: names[1], exact: true }),
  ).toBeVisible();
  for (let index = 0; index < names.length; index++) {
    const recognized = page.locator(".card.small").filter({
      has: page.getByRole("heading", { name: names[index], exact: true }),
    });
    await recognized
      .getByRole("button", { name: "編輯這筆資料", exact: true })
      .click();
    await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
      names[index],
    );
    await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue(
      String(index + 1),
    );
    await page.getByLabel("我已對照藥袋確認藥品與用法").check();
    await page
      .getByRole("button", { name: "確認並儲存藥品", exact: true })
      .click();
    if (index === 0) {
      await expect(page).toHaveURL(/\/#add$/);
      await expect(
        page.getByRole("status").filter({ hasText: "還有 1 筆待核對" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "查看我的藥品", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: names[0], exact: true }),
      ).toHaveCount(0);
      await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: names[1], exact: true }),
      ).toBeVisible();
    }
  }
  await expect(page).toHaveURL(/\/#medications$/);
  for (const name of names) {
    await expect(
      page.locator(".med-card").filter({ hasText: name }),
    ).toBeVisible();
  }
  const response = await request.get("/api/v1/medications", { headers });
  const { items } = await response.json();
  expect(items.filter((m: any) => names.includes(m.name))).toHaveLength(2);
  for (const [index, name] of names.entries()) {
    expect(items.find((m: any) => m.name === name)).toMatchObject({
      doseAmount: index + 1,
      confirmed: true,
    });
  }
  expect(recognitionRequests).toBe(1);
});
