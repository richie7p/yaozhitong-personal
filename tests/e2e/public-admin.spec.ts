import { expect, test } from "@playwright/test";

test("public users get a guided home and cannot open the management workspace", async ({
  page,
  request,
}) => {
  const adminReads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/admin/")) adminReads.push(r.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /把每天的用藥/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "管理員登入" })).toHaveAttribute(
    "href",
    "#admin",
  );
  const icon = await request.get("/favicon.ico");
  expect(icon.status()).toBe(200);
  expect((await icon.body()).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(page.locator(".next-step-card")).toBeVisible();
  await expect(page.locator(".role-pill")).toHaveText("一般使用者");
  await expect(page.locator('.sidebar a[href="#admin"]')).toHaveCount(0);
  await page.goto("/#admin?view=leaflets");
  await expect(
    page.getByRole("heading", { name: "這是管理員專用工作區" }),
  ).toBeVisible();
  expect(adminReads).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("admin library pages summaries and requests full text only on selection", async ({
  page,
}, info) => {
  const reads: string[] = [];
  await page.route("**/api/v1/admin/leaflets**", async (route) => {
    const u = new URL(route.request().url());
    reads.push(u.pathname + u.search);
    if (u.pathname.endsWith("/stats"))
      return route.fulfill({
        json: { total: 3713, published: 3710, draft: 0, retired: 3 },
      });
    if (u.pathname.endsWith("/leaflets")) {
      const offset = u.searchParams.has("cursor") ? 20 : 0;
      return route.fulfill({
        json: {
          items: Array.from({ length: 20 }, (_, i) => ({
            id: "synthetic-" + (i + offset),
            licenseNo: "合成許可證-" + (i + offset),
            version: "v1",
            status: "published",
          })),
          pageSize: 20,
          hasMore: offset === 0,
          nextCursor: offset === 0 ? "synthetic-cursor" : null,
        },
      });
    }
    return route.fulfill({
      json: {
        id: "synthetic-20",
        licenseNo: "合成許可證-20",
        version: "v1",
        status: "published",
        sourceUrl: "https://example.invalid/synthetic",
        chunks: [{ id: "c1", page: 1, text: "合成仿單內容，僅供測試。" }],
      },
    });
  });
  await page.goto("/#admin");
  await page.getByRole("button", { name: "本機管理員", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "管理總覽", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".admin-stats")).toContainText("3,710");
  expect(reads.every((path) => path.endsWith("/stats"))).toBe(true);
  await page
    .getByRole("navigation", { name: "後台功能" })
    .getByRole("link", { name: "仿單管理", exact: true })
    .click();
  await expect(page.locator(".leaflet-summary")).toHaveCount(20);
  await expect(
    page.getByRole("button", { name: "上一頁", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "下一頁", exact: true }).click();
  await expect(page.getByText("第 2 頁 · 本頁 20 份")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "下一頁", exact: true }),
  ).toBeDisabled();
  expect(reads.filter((x) => /leaflets\/synthetic/.test(x))).toEqual([]);
  await page
    .getByRole("button", { name: "查看仿單 合成許可證-20", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "開啟官方原始仿單" }),
  ).toBeVisible();
  await page.getByText("檢查抽取文字", { exact: true }).click();
  await expect(
    page.getByText("第 1 頁 · 合成仿單內容，僅供測試。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回仿單清單" }).click();
  await expect(page.getByText("第 2 頁 · 本頁 20 份")).toBeVisible();
  await page.getByRole("button", { name: "上一頁", exact: true }).click();
  await expect(page.getByText("第 1 頁 · 本頁 20 份")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("admin-" + info.project.name + ".png"),
    fullPage: true,
  });
});

test("admin read errors are explicit and retry restores the real count and list", async ({
  page,
}) => {
  let failed = true;
  await page.route("**/api/v1/admin/leaflets**", async (route) => {
    if (failed)
      return route.fulfill({
        status: 503,
        json: { code: "unavailable", message: "合成暫時無法讀取" },
      });
    if (new URL(route.request().url()).pathname.endsWith("/stats"))
      return route.fulfill({
        json: { total: 3713, published: 3710, draft: 0, retired: 3 },
      });
    return route.fulfill({
      json: { items: [], hasMore: false, nextCursor: null, pageSize: 20 },
    });
  });
  await page.goto("/#admin?view=leaflets");
  await page.getByRole("button", { name: "本機管理員", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "仿單統計讀取失敗" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "仿單清單讀取失敗" }),
  ).toBeVisible();
  await expect(page.locator(".admin-stats")).toHaveCount(0);
  await expect(page.getByText("目前沒有符合條件的仿單")).toHaveCount(0);
  failed = false;
  await page
    .locator(".read-error")
    .filter({ hasText: "仿單統計讀取失敗" })
    .getByRole("button", { name: "重新讀取" })
    .click();
  await page
    .locator(".read-error")
    .filter({ hasText: "仿單清單讀取失敗" })
    .getByRole("button", { name: "重新讀取" })
    .click();
  await expect(page.locator(".admin-stats")).toContainText("3,710");
  await expect(page.getByText("目前沒有符合條件的仿單")).toBeVisible();
});
