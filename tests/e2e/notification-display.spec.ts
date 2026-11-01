import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("worker display acceptance still requires the user to confirm seeing it", async ({
  page,
}, testInfo) => {
  // Synthetic worker response for UI behavior. The worker itself is covered in
  // service-worker.test.ts; this is not evidence of an actual OS notification.
  await page.addInitScript(() => {
    Object.defineProperty(window, "Notification", {
      value: { permission: "granted" },
    });
    const worker = {
      state: "activated",
      postMessage: (request: { requestId: string }, ports: MessagePort[]) => {
        ports[0].postMessage({
          requestId: request.requestId,
          attempt: {
            source: "test",
            state: "accepted",
            attemptedAt: new Date().toISOString(),
            notificationPresent: true,
          },
        });
      },
    };
    const registration = {
      active: worker,
      pushManager: { getSubscription: async () => null },
    };
    const workers = new EventTarget();
    Object.assign(workers, {
      getRegistration: async () => registration,
      register: async () => registration,
    });
    Object.defineProperty(navigator, "serviceWorker", { value: workers });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天的用藥日常/ }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "開啟選單", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "開啟選單", exact: true }).click();
  await page.getByRole("link", { name: "帳號與設定", exact: true }).click();
  const settings = page.getByRole("region", { name: "這台裝置的通知" });
  await expect(settings.getByText("已允許", { exact: true })).toBeVisible();
  await expect(settings.getByText("已就緒", { exact: true })).toBeVisible();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await settings
    .getByRole("button", { name: "測試通知顯示", exact: true })
    .click();
  await expect(
    settings.getByText("瀏覽器已接受通知顯示要求，請查看螢幕或通知中心。"),
  ).toBeVisible();
  await expect(
    settings.getByText("瀏覽器的通知清單中已有這則通知。"),
  ).toBeVisible();
  await expect(settings.getByText("你已確認看到測試通知。")).toHaveCount(0);
  await settings.getByRole("button", { name: "沒有看到", exact: true }).click();
  await expect(settings.getByText(/尚未確認送達/)).toBeVisible();
  await page.screenshot({
    path: `test-results/notification-display-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(writes).toEqual([]);
});

test("display testing does not silently request permission or enable a subscription", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天的用藥日常/ }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "開啟選單", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "開啟選單", exact: true }).click();
  await page.getByRole("link", { name: "帳號與設定", exact: true }).click();
  const initialPermission = await page.evaluate(() => Notification.permission);
  const settings = page.getByRole("region", { name: "這台裝置的通知" });
  await settings
    .getByRole("button", { name: "測試通知顯示", exact: true })
    .click();
  await expect(
    settings.getByText("請先啟用網頁推播，並允許這個網站顯示通知。"),
  ).toBeVisible();
  expect(await page.evaluate(() => Notification.permission)).toBe(
    initialPermission,
  );
});
