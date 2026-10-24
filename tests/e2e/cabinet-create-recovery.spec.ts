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
  const name = "合成藥箱恢復-" + randomUUID();
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常" }),
  ).toBeVisible();
  await page.goto("/#cabinet");
  const fill = async () => {
    await page
      .getByRole("button", { name: "新增藥箱項目", exact: true })
      .click();
    await page.getByLabel("名稱", { exact: true }).fill(name);
    await page.getByLabel("剩餘數量", { exact: true }).fill("12");
    await page.getByLabel("單位", { exact: true }).fill("錠");
  };
  const count = async () => {
    const { items } = await (
      await request.get("/api/v1/cabinet", { headers })
    ).json();
    return items.filter((row: any) => row.name === name).length;
  };
  await fill();
  return { fill, count };
}

test("cabinet rapid submit creates once and a deliberate next form can create another item", async ({
  page,
  request,
}) => {
  const { fill, count } = await prepare(page, request);
  const keys: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/cabinet", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "儲存", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.form!.requestSubmit();
      button.form!.requestSubmit();
    });
  await expect.poll(() => keys.length).toBe(1);
  await expect(
    page.getByRole("button", { name: "儲存中…", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("名稱", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "新增藥箱項目", exact: true }),
  ).toBeDisabled();
  await expect.poll(count).toBe(1);
  release();
  await expect(
    page.getByRole("button", { name: "取消", exact: true }),
  ).toHaveCount(0);
  await fill();
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect.poll(count).toBe(2);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).not.toBe(keys[0]);
});

test("cabinet lost successful response preserves the form and retries one stored item", async ({
  page,
  request,
}) => {
  const { count } = await prepare(page, request);
  const keys: string[] = [];
  await page.route("**/api/v1/cabinet", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    if (keys.length === 1) await route.abort("connectionreset");
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page.getByText(/目前無法連線/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "儲存", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("剩餘數量", { exact: true })).toHaveValue("12");
  await expect.poll(count).toBe(1);
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消", exact: true }),
  ).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(await count()).toBe(1);
});
