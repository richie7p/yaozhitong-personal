import { test, expect } from "@playwright/test";
test("offline keeps the public shell without caching private APIs", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "本機使用者", exact: true }),
  ).toBeVisible();
  const onlineDisplay = await page
    .locator(".login-page")
    .evaluate((el) => getComputedStyle(el).display);
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const urls = await page.evaluate(async () => {
    const names = await caches.keys();
    return (
      await Promise.all(
        names.map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (r) => new URL(r.url).pathname,
          ),
        ),
      )
    ).flat();
  });
  expect(
    urls.some((url) => url.startsWith("/assets/") && url.endsWith(".js")),
  ).toBe(true);
  expect(
    urls.some((url) => url.startsWith("/api/") || url.startsWith("/uploads/")),
  ).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /看懂每一顆藥/ }),
  ).toBeVisible();
  await expect(page.locator(".login-page")).toHaveCSS("display", onlineDisplay);
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toHaveCount(0);
  await context.setOffline(false);
});
test("manual medication, scheduling, log, isolation and care revocation", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/home-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.goto("/#add");
  await page.getByRole("button", { name: "手動建檔", exact: true }).click();
  const name = "流程測試藥品-" + Date.now();
  await page.getByLabel("藥品名稱", { exact: true }).fill(name);
  await page.getByLabel("每次劑量", { exact: true }).fill("1");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("QD");
  await page.getByLabel("我已對照藥袋確認藥品與用法").check();
  await page
    .getByRole("button", { name: "確認並儲存藥品", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: name, exact: true }),
  ).toBeVisible();
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: name, exact: true }) });
  await card.getByRole("button", { name: "排定提醒" }).click();
  await page.getByLabel("每天提醒時間").fill("23:59");
  await page.getByRole("button", { name: "確認提醒時間" }).click();
  await expect(page.getByRole("button", { name: "確認提醒時間" })).toHaveCount(
    0,
  );
  await page.goto("/#home");
  await expect(
    page.getByRole("heading", { name: name, exact: true }),
  ).toBeVisible();
  const row = page.locator(".dose-row").filter({ hasText: name });
  await row.getByRole("button", { name: "已服用", exact: true }).click();
  await expect(row.getByText("已記錄服用", { exact: true })).toBeVisible();
  await page.goto("/#care");
  await page.getByRole("button", { name: "產生邀請碼" }).click();
  const code = (await page.locator(".invite-code code").textContent())!;
  const second = await browser.newContext();
  const family = await second.newPage();
  await family.goto("http://127.0.0.1:5190/");
  await family.getByRole("button", { name: "本機家人", exact: true }).click();
  await family.goto("http://127.0.0.1:5190/#medications");
  await expect(
    family.getByRole("heading", { name: name, exact: true }),
  ).toHaveCount(0);
  await family.goto("http://127.0.0.1:5190/#care");
  await family.getByLabel("邀請碼", { exact: true }).fill(code);
  await family.getByRole("button", { name: "接受邀請" }).click();
  await family.getByRole("button", { name: "查看紀錄" }).first().click();
  await expect(family.getByText(name, { exact: true }).first()).toBeVisible();
  await page.bringToFront();
  await page.reload();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "取消授權" }).first().click();
  await family.reload();
  await expect(family.getByRole("button", { name: "查看紀錄" })).toHaveCount(0);
  await page.goto("/#medications");
  await expect(
    page.getByRole("heading", { name: name, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await second.close();
});
test("admin access and privacy boundary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#admin");
  await expect(page.getByText("此功能需要管理員權限。")).toBeVisible();
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: "本機管理員", exact: true }).click();
  await page.goto("/#admin");
  await expect(
    page.getByRole("heading", { name: "管理員後台", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "帳號管理", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
});
