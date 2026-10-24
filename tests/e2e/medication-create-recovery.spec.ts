import { expect, test } from "@playwright/test";

for (const entry of ["manual", "search", "manual-retake"] as const) {
  test(`${entry} creation recovers a lost response once and a later new form can deliberately create another row`, async ({
    page,
    request,
  }) => {
    const { token } = await (
      await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
    ).json();
    const headers = { authorization: "Bearer " + token };
    const name = `合成建檔復原-${entry}-${crypto.randomUUID()}`;
    const keys: string[] = [],
      ids: string[] = [];
    await page.route("**/api/v1/medications", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      ids.push((await response.json()).id);
      if (keys.length === 1) await route.abort("connectionreset");
      else await route.fulfill({ response });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /今天的用藥日常/ }),
    ).toBeVisible();
    const openForm = async () => {
      await page.goto("/#add");
      if (entry === "search") {
        await page
          .getByRole("button", { name: "搜尋藥名", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "搜尋藥名", exact: true })
          .fill("流程測試片");
        await page.getByRole("button", { name: "搜尋", exact: true }).click();
        await page
          .locator(".search-result")
          .filter({ has: page.getByText("流程測試片 5mg", { exact: true }) })
          .click();
      } else
        await page
          .getByRole("button", { name: "手動建檔", exact: true })
          .click();
      await page.getByLabel("藥品名稱", { exact: true }).fill(name);
    };
    await openForm();
    await page
      .getByRole("button", { name: "保存待核對資料", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "目前無法連線" }),
    ).toBeVisible();
    if (entry === "manual-retake") {
      await page
        .getByRole("button", { name: "返回補拍／上傳", exact: true })
        .click();
      await page
        .getByRole("button", { name: "返回尚未保存的核對資料", exact: true })
        .click();
    }
    await expect(page.getByLabel("藥品名稱", { exact: true })).toHaveValue(
      name,
    );
    await page
      .getByRole("button", { name: "保存待核對資料", exact: true })
      .click();
    await expect(page).toHaveURL(/#medications\?saved=/);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(ids[1]).toBe(ids[0]);
    let medications = (
      await (await request.get("/api/v1/medications", { headers })).json()
    ).items;
    expect(medications.filter((m: any) => m.name === name)).toHaveLength(1);
    await openForm();
    await page
      .getByRole("button", { name: "保存待核對資料", exact: true })
      .click();
    await expect(page).toHaveURL(/#medications\?saved=/);
    expect(keys[2]).not.toBe(keys[0]);
    expect(ids[2]).not.toBe(ids[0]);
    medications = (
      await (await request.get("/api/v1/medications", { headers })).json()
    ).items;
    expect(medications.filter((m: any) => m.name === name)).toHaveLength(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
