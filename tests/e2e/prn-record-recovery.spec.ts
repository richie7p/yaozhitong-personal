import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

async function prepare(page: Page, request: APIRequestContext) {
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const medications: { id: string; name: string }[] = [];
  for (const suffix of ["甲", "乙"]) {
    const response = await request.post("/api/v1/medications", {
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      data: {
        name: `合成需要時紀錄${suffix}-${randomUUID()}`,
        doseAmount: 1,
        doseUnit: "錠",
        frequencyRaw: "PRN",
        confirmed: true,
        prn: true,
      },
    });
    expect(response.status()).toBe(201);
    medications.push(await response.json());
  }
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常" }),
  ).toBeVisible();
  await page.goto("/#medications");
  const card = (index: number) =>
    page.locator(`[data-medication-id="${medications[index].id}"]`);
  await expect(card(0)).toBeVisible();
  const savedCount = async () => {
    const { items } = await (
      await request.get("/api/v1/dose-logs", { headers })
    ).json();
    return items.filter((row: any) => row.medicationId === medications[0].id)
      .length;
  };
  return { card, savedCount };
}

test("PRN rapid clicks save one dose and leave other medications available", async ({
  page,
  request,
}) => {
  const { card, savedCount } = await prepare(page, request);
  const operations: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/dose-logs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    operations.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await card(0)
    .getByRole("button", { name: "記錄服用", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect.poll(() => operations.length).toBe(1);
  await expect(
    card(0).getByRole("button", { name: "記錄中…", exact: true }),
  ).toBeDisabled();
  await expect(
    card(1).getByRole("button", { name: "記錄服用", exact: true }),
  ).toBeEnabled();
  await expect.poll(savedCount).toBe(1);
  release();
  await expect(
    page.getByText("已記錄這次服用。", { exact: true }),
  ).toBeVisible();
  await card(0).getByRole("button", { name: "記錄服用", exact: true }).click();
  await expect.poll(savedCount).toBe(2);
  expect(operations).toHaveLength(2);
  expect(new Set(operations).size).toBe(2);
});

test("PRN lost successful response retries the same operation before a later dose", async ({
  page,
  request,
}) => {
  const { card, savedCount } = await prepare(page, request);
  const operations: string[] = [];
  await page.route("**/api/v1/dose-logs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    operations.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    // Commit at the real local API, then drop only the browser's response.
    if (operations.length === 1) await route.abort("connectionreset");
    else await route.fulfill({ response });
  });
  await card(0).getByRole("button", { name: "記錄服用", exact: true }).click();
  await expect(page.getByText(/目前無法連線/)).toBeVisible();
  await expect(
    card(0).getByRole("button", { name: "記錄服用", exact: true }),
  ).toBeEnabled();
  await expect.poll(savedCount).toBe(1);
  await card(0).getByRole("button", { name: "記錄服用", exact: true }).click();
  await expect(
    page.getByText("已記錄這次服用。", { exact: true }),
  ).toBeVisible();
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
  expect(await savedCount()).toBe(1);
  await card(0).getByRole("button", { name: "記錄服用", exact: true }).click();
  await expect.poll(savedCount).toBe(2);
  expect(operations).toHaveLength(3);
  expect(operations[2]).not.toBe(operations[0]);
});
