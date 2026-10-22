import { expect, test } from "@playwright/test";
test("private support works from public entry through administrator reply and recovery", async ({
  page,
  context,
}, info) => {
  const who = info.project.name === "mobile" ? "本機家人" : "本機使用者";
  const text = `Synthetic support ${info.project.name} ${Date.now()}: button unavailable <img src=x onerror=alert(1)>`;
  await page.goto("/#support");
  await expect(
    page.getByRole("heading", { name: "問題回報", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "前往登入／註冊" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "前往登入／註冊" }).click();
  await page.getByRole("button", { name: who, exact: true }).click();
  await page.goto("/#support");
  await page.getByRole("textbox", { name: "問題描述", exact: true }).fill(text);
  await page.getByRole("button", { name: "送出私密回報", exact: true }).click();
  await expect(
    page.getByText("回報已送出，管理員回覆會顯示在下方。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.locator("article img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/#home");
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: "本機管理員", exact: true }).click();
  await page.goto("/#admin");
  await page.getByRole("button", { name: "問題回報", exact: true }).click();
  const article = page
    .locator("article")
    .filter({ has: page.getByText(text, { exact: true }) });
  await article
    .getByLabel("管理員回覆")
    .fill("Synthetic fix is ready for retesting.");
  await article.getByLabel("處理狀態").selectOption("resolved");
  await article.getByRole("button", { name: "送出回覆", exact: true }).click();
  await expect(
    article.getByText("Synthetic fix is ready for retesting.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: who, exact: true }).click();
  await page.goto("/#support");
  await expect(
    page
      .getByText("Synthetic fix is ready for retesting.", { exact: true })
      .last(),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "問題描述", exact: true })
    .fill("Synthetic offline retry draft preserved.");
  let posts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/support")) posts++;
  });
  await context.setOffline(true);
  await page.getByRole("button", { name: "送出私密回報", exact: true }).click();
  await expect(
    page.getByText("目前離線，請連線後再操作。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "問題描述", exact: true }),
  ).toHaveValue("Synthetic offline retry draft preserved.");
  expect(posts).toBe(0);
  await context.setOffline(false);
});
