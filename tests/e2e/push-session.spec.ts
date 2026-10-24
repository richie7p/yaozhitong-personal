import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { pushSessionHarness } from "../support/push-session-harness";

let harness: Awaited<ReturnType<typeof pushSessionHarness>>;
test.beforeAll(async () => {
  harness = await pushSessionHarness();
});
test.afterAll(async () => {
  await harness.close();
});
test.beforeEach(() => harness.reset());

async function open(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(harness.url);
  await page.waitForFunction(
    () => (window as any).authProbe?.me?.account.id === "synthetic-A",
  );
  return page;
}
async function loginB(page: Page) {
  await page.evaluate(() =>
    (window as any).authProbe.login(
      "login",
      "synthetic@example.test",
      "synthetic-password",
    ),
  );
  await page.waitForFunction(
    () => (window as any).authProbe?.me?.account.id === "synthetic-B",
  );
}
async function notify(page: Page) {
  await page.evaluate(() => {
    (window as any).notificationResult = "pending";
    void (window as any).authProbe.notify().then(
      () => {
        (window as any).notificationResult = "success";
      },
      (error: Error) => {
        (window as any).notificationResult = error.message;
      },
    );
  });
}
async function logout(page: Page) {
  await page.evaluate(() => {
    (window as any).logoutDone = false;
    void (window as any).authProbe.logout().then(() => {
      (window as any).logoutDone = true;
    });
  });
  await page.waitForFunction(() => (window as any).authProbe.me === null);
}

test("an old tab logout cannot revoke the shared FCM token already owned by another tab", async ({
  context,
}) => {
  await context.grantPermissions(["notifications"], { origin: harness.url });
  const a = await open(context),
    b = await open(context);
  await loginB(b);
  await notify(b);
  await expect.poll(() => harness.state().owner).toBe("synthetic-B");
  await logout(a);
  await a.waitForFunction(() => (window as any).logoutDone);
  expect(harness.state()).toMatchObject({
    owner: "synthetic-B",
    active: true,
    deletes: 0,
    deleteStatuses: [404],
  });
  expect(await b.evaluate(() => (window as any).authProbe.me.account.id)).toBe(
    "synthetic-B",
  );
});

test("the shared lock outlives a logout UI deadline until provider deletion actually finishes", async ({
  context,
}) => {
  await context.grantPermissions(["notifications"], { origin: harness.url });
  const a = await open(context),
    b = await open(context);
  await a.clock.install();
  harness.holdDelete();
  await logout(a);
  await expect.poll(() => harness.state().deletes).toBe(1);
  await a.clock.fastForward(10001);
  await a.waitForFunction(() => (window as any).logoutDone);
  await loginB(b);
  await notify(b);
  expect(harness.state().gets).toBe(0);
  harness.releaseDelete();
  await b.waitForFunction(
    () => (window as any).notificationResult === "success",
  );
  expect(harness.state()).toMatchObject({
    owner: "synthetic-B",
    active: true,
    gets: 1,
    deletes: 1,
  });
});

test("a late provider token after setup timeout never posts and keeps the other tab serialized", async ({
  context,
}) => {
  await context.grantPermissions(["notifications"], { origin: harness.url });
  const a = await open(context),
    b = await open(context);
  await a.clock.install();
  harness.holdGet();
  await notify(a);
  await expect.poll(() => harness.state().gets).toBe(1);
  await a.clock.fastForward(30001);
  await expect
    .poll(() => a.evaluate(() => (window as any).notificationResult))
    .toContain("逾時");
  await loginB(b);
  await notify(b);
  expect(harness.state().gets).toBe(1);
  harness.releaseGet();
  await b.waitForFunction(
    () => (window as any).notificationResult === "success",
  );
  expect(harness.state()).toMatchObject({
    owner: "synthetic-B",
    active: true,
    gets: 2,
    posts: ["synthetic-B"],
  });
});

test("without shared Web Locks push explains the limitation while login and logout still work", async ({
  context,
}) => {
  await context.grantPermissions(["notifications"], { origin: harness.url });
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "locks", { value: undefined }),
  );
  const page = await open(context);
  await notify(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).notificationResult))
    .toContain("無法安全協調");
  expect(harness.state()).toMatchObject({ gets: 0, deletes: 0, posts: [] });
  await logout(page);
  await page.waitForFunction(() => (window as any).logoutDone);
  expect(harness.state()).toMatchObject({
    owner: null,
    deletes: 0,
    deleteStatuses: [200],
  });
  await loginB(page);
});

test("logout removes a committed registration even when its POST response was still pending", async ({
  context,
}) => {
  await context.grantPermissions(["notifications"], { origin: harness.url });
  const page = await open(context);
  // A new registration has no completed device ID at the start.
  await page.goto(harness.url + "/?fresh");
  await page.waitForFunction(
    () => (window as any).authProbe?.me?.account.id === "synthetic-A",
  );
  harness.holdPost();
  await notify(page);
  await expect.poll(() => harness.state().posts).toEqual(["synthetic-A"]);
  await logout(page);
  expect(harness.state().deleteStatuses).toEqual([]);
  harness.releasePost();
  await page.waitForFunction(() => (window as any).logoutDone);
  expect(harness.state()).toMatchObject({
    owner: null,
    active: false,
    deletes: 1,
    deleteStatuses: [200],
  });
});

test("a timed-out shared lock request cannot run late after the old operation releases", async ({
  context,
}) => {
  const a = await open(context),
    b = await open(context);
  harness.holdDelete();
  await logout(a);
  await expect.poll(() => harness.state().deletes).toBe(1);
  await loginB(b);
  await b.clock.install();
  await notify(b);
  await b.clock.fastForward(10001);
  await expect
    .poll(() => b.evaluate(() => (window as any).notificationResult))
    .toContain("其他分頁");
  harness.releaseDelete();
  await a.waitForFunction(() => (window as any).logoutDone);
  expect(harness.state().gets).toBe(0);
  await notify(b);
  await b.waitForFunction(
    () => (window as any).notificationResult === "success",
  );
  expect(harness.state()).toMatchObject({
    owner: "synthetic-B",
    active: true,
    gets: 1,
    posts: ["synthetic-B"],
  });
});

test("a failed unlink explains a working re-enable then logout recovery sequence", async ({
  context,
}) => {
  const page = await open(context);
  harness.failDelete(true);
  await logout(page);
  await page.waitForFunction(() => (window as any).logoutDone);
  await expect
    .poll(() => page.evaluate(() => (window as any).authProbe.authError))
    .toContain("啟用推播再登出");
  expect(harness.state()).toMatchObject({
    owner: "synthetic-A",
    active: true,
    deletes: 0,
  });
  harness.failDelete(false);
  await loginB(page);
  await notify(page);
  await page.waitForFunction(
    () => (window as any).notificationResult === "success",
  );
  await logout(page);
  await page.waitForFunction(() => (window as any).logoutDone);
  expect(harness.state()).toMatchObject({
    owner: null,
    active: false,
    deletes: 1,
  });
});
