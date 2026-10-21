import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const photo = {
  name: "synthetic-lost-job-response.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
    "base64",
  ),
};

async function testAccount(request: APIRequestContext, uid: string) {
  const response = await request.post("/api/v1/auth/local", { data: { uid } });
  expect(response.ok()).toBe(true);
  return { authorization: "Bearer " + (await response.json()).token };
}

async function snapshot(
  request: APIRequestContext,
  owner: Record<string, string>,
  admin: Record<string, string>,
) {
  const [jobsResponse, usageResponse] = await Promise.all([
    request.get("/api/v1/jobs", { headers: owner }),
    request.get("/api/v1/admin/usage", { headers: admin }),
  ]);
  expect(jobsResponse.ok()).toBe(true);
  expect(usageResponse.ok()).toBe(true);
  const jobs = (await jobsResponse.json()).items as { id: string }[];
  const usage = (await usageResponse.json()).items as {
    ownerId?: string;
    count: number;
  }[];
  return {
    ids: new Set(jobs.map((job) => job.id)),
    count: usage
      .filter((row) => row.ownerId === "local-owner")
      .reduce((total, row) => total + row.count, 0),
  };
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天的用藥日常/ }),
  ).toBeVisible();
}

test("lost recognition creation response survives reload without a second job, AI call or quota charge", async ({
  page,
  request,
}) => {
  const owner = await testAccount(request, "local-owner");
  const admin = await testAccount(request, "local-admin");
  const before = await snapshot(request, owner, admin);
  const keys: string[] = [];
  const ids: string[] = [];
  await page.route("**/api/v1/recognitions", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    ids.push((await response.json()).jobId);
    if (keys.length === 1) await route.abort("connectionreset");
    else await route.fulfill({ response });
  });
  await login(page);
  await page.goto("/#add");
  await page.locator('input[type="file"]').setInputFiles(photo);
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "無法連線到服務" }),
  ).toBeVisible();

  await page.reload();
  await page.locator('input[type="file"]').setInputFiles(photo);
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(new Set(ids).size).toBe(1);

  const after = await snapshot(request, owner, admin);
  expect([...after.ids].filter((id) => !before.ids.has(id))).toEqual([ids[0]]);
  expect(after.count).toBe(before.count + 1);
  const completed = await (
    await request.get("/api/v1/jobs/" + ids[0], { headers: owner })
  ).json();
  expect(completed.status).toBe("succeeded");
  expect(completed.attempts).toBe(1);
  expect(completed.aiRequests).toHaveLength(1);

  // A new explicit recognition after confirmed completion is a separate operation.
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

test("interrupted polling resumes the known job after reload and never posts a duplicate question", async ({
  page,
  request,
}, info) => {
  const owner = await testAccount(request, "local-owner");
  const admin = await testAccount(request, "local-admin");
  const name = `斷線問答合成藥品-${info.project.name}-${info.repeatEachIndex}-${Date.now()}`;
  const medication = await request.post("/api/v1/medications", {
    headers: owner,
    data: {
      name,
      licenseNo: "SYNTHETIC-E2E-5",
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    },
  });
  expect(medication.status()).toBe(201);
  const before = await snapshot(request, owner, admin);
  const question = "合成回應中斷測試 " + info.project.name + " " + Date.now();
  let posts = 0;
  let jobId = "";
  let dropPoll = true;
  await page.route("**/api/v1/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    jobId = (await response.json()).jobId;
    await route.fulfill({ response });
  });
  await page.route("**/api/v1/jobs/*", async (route) => {
    if (
      dropPoll &&
      route.request().method() === "GET" &&
      route
        .request()
        .url()
        .endsWith("/" + jobId)
    ) {
      dropPoll = false;
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await login(page);
  await page.goto("/#chat");
  await page.getByLabel(name, { exact: true }).check();
  await page.locator("textarea").fill(question);
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "無法連線到服務" }),
  ).toBeVisible();
  expect(jobId).toBeTruthy();

  await page.reload();
  await page.getByLabel(name, { exact: true }).check();
  await page.locator("textarea").fill(question);
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("");
  await expect(
    page.locator(".question-bubble").filter({ hasText: question }),
  ).toHaveCount(1);
  expect(posts).toBe(1);
  const after = await snapshot(request, owner, admin);
  expect([...after.ids].filter((id) => !before.ids.has(id))).toEqual([jobId]);
  expect(after.count).toBe(before.count + 1);
  const completed = await (
    await request.get("/api/v1/jobs/" + jobId, { headers: owner })
  ).json();
  expect(completed.status).toBe("succeeded");
  expect(completed.attempts).toBe(1);
});
