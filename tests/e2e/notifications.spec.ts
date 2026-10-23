import { expect, test, type Page } from "@playwright/test";

const sent = {
  id: "synthetic-sent",
  message: "合成通知：已完成推播處理。",
  status: "sent",
  createdAt: "2026-10-20T16:00:00.000Z",
  dueAt: "2026-10-20T16:00:00.000Z",
  sentAt: "2026-10-20T16:00:05.000Z",
};
const pending = {
  id: "synthetic-pending",
  message: "合成通知：等待傳送。",
  status: "pending",
  createdAt: "2026-10-20T16:02:00.000Z",
  dueAt: "2026-10-20T16:02:00.000Z",
};
const cancelled = {
  id: "synthetic-cancelled",
  message: "合成通知：已取消的家人提醒。",
  status: "cancelled",
  recipientId: "synthetic-family",
  createdAt: "2026-10-20T16:03:00.000Z",
  dueAt: "2026-10-20T16:03:00.000Z",
};

async function login(page: Page, name = "本機使用者") {
  await page.goto("/");
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天的用藥日常/ }),
  ).toBeVisible();
}

test.describe("notification history route fixtures", () => {
  // These synthetic notifications exist only in the route fixtures.
  test.use({ serviceWorkers: "block" });

  test("the delayed sign-in title focus preserves a keyboard user's notification link", async ({
    page,
  }) => {
    await page.route("**/api/v1/notifications", (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "本機使用者", exact: true }).focus();
    // Hold app frames until the keyboard user reaches the bell, so the race is
    // exercised on every run instead of depending on browser rendering speed.
    await page.evaluate(() => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      const cancelFrame = window.cancelAnimationFrame.bind(window);
      const pending = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      window.requestAnimationFrame = (callback) => {
        const id = --nextFrame;
        pending.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        if (pending.has(id)) pending.delete(id);
        else cancelFrame(id);
      };
      const controlledWindow = window as typeof window & {
        resumeNavigationFrames?: () => void;
        pendingNavigationFrames?: () => number;
      };
      controlledWindow.pendingNavigationFrames = () => pending.size;
      controlledWindow.resumeNavigationFrames = () => {
        window.requestAnimationFrame = requestFrame;
        window.cancelAnimationFrame = cancelFrame;
        const callbacks = [...pending.values()];
        pending.clear();
        for (const callback of callbacks) callback(performance.now());
        delete controlledWindow.resumeNavigationFrames;
        delete controlledWindow.pendingNavigationFrames;
      };
    });
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: /今天的用藥日常/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as typeof window & { pendingNavigationFrames: () => number }
          ).pendingNavigationFrames(),
        ),
      )
      .toBeGreaterThan(0);
    const bell = page.locator(".topbar").getByRole("link", {
      name: "通知紀錄",
      exact: true,
    });
    await bell.focus();
    await page.evaluate(() => {
      (
        window as typeof window & { resumeNavigationFrames: () => void }
      ).resumeNavigationFrames();
    });
    await expect(bell).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#notifications$/);
    await expect(page.locator("#main h1")).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "目前沒有通知紀錄", exact: true }),
    ).toBeVisible();
  });

  test("bell and More show sorted Taipei records, with explicit refresh and no polling or writes", async ({
    page,
  }, info) => {
    let requests = 0;
    let items = [sent, cancelled, pending];
    const writes: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith("/api/v1/") &&
        request.method() !== "GET" &&
        path !== "/api/v1/auth/local"
      )
        writes.push(`${request.method()} ${path}`);
    });
    await page.route("**/api/v1/notifications", (route) => {
      requests++;
      return route.fulfill({ json: { items } });
    });
    await login(page);
    const bell = page.locator(".topbar").getByRole("link", {
      name: "通知紀錄",
      exact: true,
    });
    await bell.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#notifications$/);
    await expect(bell).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#main h1")).toBeFocused();
    const list = page.getByRole("list", { name: "提醒紀錄", exact: true });
    const rows = list.getByRole("article");
    await expect(rows).toHaveCount(3);
    await expect(rows.locator(".notification-message")).toHaveText([
      cancelled.message,
      pending.message,
      sent.message,
    ]);
    await expect(rows.locator(".tag")).toHaveText([
      "已取消",
      "待傳送",
      "推送已處理",
    ]);
    await expect(rows.first().getByRole("heading")).toHaveText("家人用藥提醒");
    await expect(rows.last().getByRole("heading")).toHaveText("我的用藥提醒");
    await expect(rows.last().locator("time")).toHaveText([
      "2026/10/21 00:00",
      "2026/10/21 00:00",
      "2026/10/21 00:00",
    ]);
    await expect(
      page.getByText(/無法確認手機是否顯示或是否已閱讀/),
    ).toBeVisible();
    await expect(page.getByText(/目前帳號：/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "前往通知設定", exact: true }),
    ).toHaveAttribute("href", "#profile");
    expect(requests).toBe(1);
    await page.clock.install();
    await page.clock.fastForward(120_000);
    expect(requests).toBe(1);
    items = [sent, cancelled, { ...pending, status: "sent" }];
    await page.getByRole("button", { name: "重新整理", exact: true }).click();
    await expect(rows.nth(1).locator(".tag")).toHaveText("推送已處理");
    expect(requests).toBe(2);
    await page.screenshot({
      path: `test-results/notifications-${info.project.name}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.goto("/#home");
    await expect(
      page.getByRole("heading", { name: /今天的用藥日常/ }),
    ).toBeVisible();
    const more = page.getByRole("button", { name: "更多功能", exact: true });
    if (info.project.name === "mobile") {
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(more).toHaveAttribute("aria-expanded", "true");
    }
    await page.locator('.sidebar a[href="#notifications"]').click();
    await expect(
      page.getByRole("heading", { name: "通知紀錄", exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(3);
    expect(requests).toBe(3);
    if (info.project.name === "mobile") {
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(
        page.getByRole("navigation", { name: "手機主要導覽" }),
      ).toBeVisible();
    }
    expect(writes).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("failed loads can be retried, with loading, empty results and clear stale-data feedback", async ({
    page,
  }) => {
    let requests = 0;
    let release: () => void = () => {};
    const heldResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/notifications", async (route) => {
      requests++;
      if (requests === 1 || requests === 4) {
        await route.fulfill({
          status: 503,
          json: {
            code: "synthetic_unavailable",
            message: "合成斷線，請重試。",
          },
        });
      } else {
        if (requests === 2) await heldResponse;
        await route.fulfill({ json: { items: requests === 2 ? [] : [sent] } });
      }
    });
    await login(page);
    await page
      .locator(".topbar")
      .getByRole("link", { name: "通知紀錄", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("合成斷線，請重試。");
    await expect(
      page.getByRole("heading", { name: "目前沒有通知紀錄" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "重新載入", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("正在讀取通知紀錄…");
    await expect(
      page.getByRole("button", { name: "正在載入…", exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByRole("heading", { name: "目前沒有通知紀錄", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "查看我的藥品", exact: true }),
    ).toHaveAttribute("href", "#medications");
    await page.getByRole("button", { name: "重新整理", exact: true }).click();
    await expect(page.getByText(sent.message, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新整理", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "下方保留上次載入的紀錄",
    );
    await expect(page.getByText(sent.message, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "重新載入", exact: true }),
    ).toBeEnabled();
    expect(requests).toBe(4);
  });

  test("a silent notification read stops waiting and a manual retry recovers without writes", async ({
    page,
  }) => {
    let reads = 0;
    let releaseFirst: () => void = () => {};
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith("/api/v1/") &&
        request.method() !== "GET" &&
        path !== "/api/v1/auth/local"
      )
        writes.push(`${request.method()} ${path}`);
    });
    await page.route("**/api/v1/notifications", async (route) => {
      reads++;
      if (reads === 1) {
        await firstRead;
        // The application aborts the original transport at its deadline. A
        // transport's late response must not replace the successful retry.
        await route.fulfill({ json: { items: [cancelled] } }).catch(() => {});
      } else {
        await route.fulfill({ json: { items: [sent] } });
      }
    });
    await login(page);
    await page.clock.install();
    await page
      .locator(".topbar")
      .getByRole("link", { name: "通知紀錄", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("正在讀取通知紀錄…");
    await expect(
      page.getByRole("button", { name: "正在載入…", exact: true }),
    ).toBeDisabled();
    expect(reads).toBe(1);
    await page.clock.fastForward(45_001);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("連線等待過久");
    const retry = page.getByRole("button", { name: "重新載入", exact: true });
    await expect(retry).toBeEnabled();
    expect(reads).toBe(1);
    await retry.click();
    await expect(page.getByText(sent.message, { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    releaseFirst();
    await page.clock.fastForward(1_000);
    await expect(
      page.getByText(cancelled.message, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(sent.message, { exact: true })).toBeVisible();
    expect(reads).toBe(2);
    expect(writes).toEqual([]);
  });

  test("changing account clears previous notification content before loading the next account", async ({
    page,
    request,
  }) => {
    let release: () => void = () => {};
    const familyResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ownerRequests = 0;
    let familyRequests = 0;
    await page.route("**/api/v1/notifications", async (route) => {
      const authorization = route.request().headers().authorization;
      // Ask the isolated local server which account the real browser token owns.
      // Tokens include an expiry time, so separate sign-ins need not match.
      const identity = await request.get("/api/v1/me", {
        headers: { authorization },
      });
      expect(identity.ok()).toBe(true);
      const { account } = await identity.json();
      if (account.id === "local-owner") {
        ownerRequests++;
        await route.fulfill({ json: { items: [sent] } });
      } else if (account.id === "local-family") {
        familyRequests++;
        await familyResponse;
        await route.fulfill({
          json: {
            items: [{ ...pending, message: "家人帳號的獨立通知紀錄。" }],
          },
        });
      } else {
        await route.fulfill({ status: 401, json: { message: "帳號不符。" } });
      }
    });
    await login(page);
    await page
      .locator(".topbar")
      .getByRole("link", { name: "通知紀錄", exact: true })
      .click();
    await expect(page.getByText(sent.message, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "登出", exact: true }).click();
    await page.getByRole("button", { name: "本機家人", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /今天的用藥日常/ }),
    ).toBeVisible();
    await page
      .locator(".topbar")
      .getByRole("link", { name: "通知紀錄", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("正在讀取通知紀錄…");
    await expect(page.getByText(sent.message, { exact: true })).toHaveCount(0);
    release();
    await expect(
      page.getByText("家人帳號的獨立通知紀錄。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(sent.message, { exact: true })).toHaveCount(0);
    expect(ownerRequests).toBe(1);
    expect(familyRequests).toBe(1);
  });
});
