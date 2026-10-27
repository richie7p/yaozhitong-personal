import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function fixture(request: APIRequestContext, name: string) {
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const response = await request.post("/api/v1/medications", {
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
  });
  expect(response.status()).toBe(201);
  const medication = await response.json();
  const queued = await (
    await request.post("/api/v1/bundles", {
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      data: { medicationIds: [medication.id] },
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
  return { medication, headers, learningId: queued.jobId };
}
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天的用藥日常/ }),
  ).toBeVisible();
  await page.goto("/#medications");
}

for (const action of ["edit", "remove"] as const) {
  test(`a delayed explanation read cannot revive content after ${action}`, async ({
    page,
    request,
  }) => {
    const name = `合成說明競態-${action}-${crypto.randomUUID()}`;
    const { medication, headers, learningId } = await fixture(request, name);
    await open(page);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (started = r));
    await page.route("**/api/v1/learning", async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    const card = page.locator(
      `.med-card[data-medication-id="${medication.id}"]`,
    );
    await card.getByRole("button", { name: "仿單說明", exact: true }).click();
    await ready;
    if (action === "edit") {
      await card.getByRole("button", { name: "編輯用法", exact: true }).click();
      await page.getByLabel("每次劑量", { exact: true }).fill("6");
      await page
        .getByRole("button", { name: "儲存已核對藥品與用法", exact: true })
        .click();
      await expect(card.locator(".usage-box")).toContainText("6 錠");
    } else {
      page.once("dialog", (d) => d.accept());
      await card
        .getByRole("button", { name: "移除" + name, exact: true })
        .click();
      await expect(card).toHaveCount(0);
    }
    expect(
      (
        await (await request.get("/api/v1/learning", { headers })).json()
      ).items.some((r: any) => r.id === learningId),
    ).toBe(false);
    const finished = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/v1/learning",
    );
    release();
    await finished;
    await expect(page.locator(".medication-detail")).toHaveCount(0);
    await expect(page.locator(".quiz")).toHaveCount(0);
    await expect(
      page.getByText("正在讀取已保存的仿單說明…", { exact: true }),
    ).toHaveCount(0);
  });
}

for (const older of ["success", "failure"] as const) {
  test(`an obsolete ${older} read cannot clear a newer explanation's busy state or add an old error`, async ({
    page,
    request,
  }) => {
    const a = await fixture(request, "合成較舊說明-" + crypto.randomUUID());
    const b = await fixture(request, "合成較新說明-" + crypto.randomUUID());
    await open(page);
    let releaseOld!: () => void, releaseNew!: () => void;
    const oldGate = new Promise<void>((r) => (releaseOld = r)),
      newGate = new Promise<void>((r) => (releaseNew = r));
    let requests = 0;
    await page.route("**/api/v1/learning", async (route) => {
      const index = ++requests,
        response = await route.fetch();
      if (index === 1) {
        await oldGate;
        if (older === "failure")
          return route.fulfill({
            status: 503,
            json: {
              code: "synthetic_old_error",
              message: "已失效的舊讀取錯誤",
            },
          });
      } else await newGate;
      await route.fulfill({ response });
    });
    const first = page.locator(
      `.med-card[data-medication-id="${a.medication.id}"]`,
    );
    const second = page.locator(
      `.med-card[data-medication-id="${b.medication.id}"]`,
    );
    await first.getByRole("button", { name: "仿單說明", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await first.getByRole("button", { name: "編輯用法", exact: true }).click();
    await page.getByRole("button", { name: "關閉編輯", exact: true }).click();
    await second.getByRole("button", { name: "仿單說明", exact: true }).click();
    await expect.poll(() => requests).toBe(2);
    const oldFinished = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/v1/learning",
    );
    releaseOld();
    await oldFinished;
    await expect(
      page.getByText("正在讀取已保存的仿單說明…", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("button", { name: "仿單說明", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".medication-detail")).toHaveCount(0);
    await expect(
      page.getByText("已失效的舊讀取錯誤", { exact: true }),
    ).toHaveCount(0);
    releaseNew();
    await expect(page.locator(".medication-detail h2")).toContainText(
      b.medication.name,
    );
    await expect(
      page.getByText("正在讀取已保存的仿單說明…", { exact: true }),
    ).toHaveCount(0);
  });
}

test("late accepted bundle progress and completion cannot replace a newer saved-explanation read", async ({
  page,
  request,
}) => {
  const a = await fixture(request, "合成舊背景工作-" + crypto.randomUUID());
  const b = await fixture(request, "合成新說明讀取-" + crypto.randomUUID());
  await open(page);
  let releaseAccepted!: () => void, releaseNew!: () => void;
  const acceptedGate = new Promise<void>((r) => (releaseAccepted = r));
  const newGate = new Promise<void>((r) => (releaseNew = r));
  let reads = 0,
    acceptedJobId = "";
  await page.route("**/api/v1/learning", async (route) => {
    if (++reads === 1) return route.fulfill({ json: { items: [] } });
    const response = await route.fetch();
    await newGate;
    return route.fulfill({ response });
  });
  await page.route("**/api/v1/bundles", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    acceptedJobId = (await response.json()).jobId;
    await acceptedGate;
    await route.fulfill({ response });
  });
  const first = page.locator(
    `.med-card[data-medication-id="${a.medication.id}"]`,
  );
  const second = page.locator(
    `.med-card[data-medication-id="${b.medication.id}"]`,
  );
  await first.getByRole("button", { name: "仿單說明", exact: true }).click();
  await expect.poll(() => acceptedJobId).not.toBe("");
  await first.getByRole("button", { name: "編輯用法", exact: true }).click();
  await page.getByRole("button", { name: "關閉編輯", exact: true }).click();
  await second.getByRole("button", { name: "仿單說明", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  const oldPoll = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/jobs/" + acceptedJobId,
  );
  releaseAccepted();
  await oldPoll;
  await expect(
    page.getByText("正在讀取已保存的仿單說明…", { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "仿單說明", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".medication-detail")).toHaveCount(0);
  releaseNew();
  await expect(page.locator(".medication-detail h2")).toContainText(
    b.medication.name,
  );
});
