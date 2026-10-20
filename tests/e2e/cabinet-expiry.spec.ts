import { expect, test } from "@playwright/test";

test("cabinet expiry uses Taipei dates before 08:00 and updates while open across midnight", async ({
  page,
  request,
}, info) => {
  const aiRequests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (/\/api\/v1\/(recognitions|bundles|chat|interactions)$/.test(path) ||
        /\/api\/v1\/(?:admin\/)?jobs\/[^/]+\/retry$/.test(path))
    ) {
      aiRequests.push(path);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const headers = { authorization: "Bearer " + token };
  const prefix = `合成效期-${info.project.name}-${Date.now()}`;
  const cases = [
    { key: "yesterday", expiresAt: "2026-10-19", disposed: false },
    { key: "today", expiresAt: "2026-10-20", disposed: false },
    { key: "tomorrow", expiresAt: "2026-10-21", disposed: false },
    { key: "no-expiry", expiresAt: null, disposed: false },
    { key: "disposed", expiresAt: "2026-10-19", disposed: true },
  ];
  const saved: { id: string; data: Record<string, unknown> }[] = [];
  try {
    for (const item of cases) {
      const data = {
        name: prefix + "-" + item.key,
        quantity: 1,
        unit: "合成單位",
        expiresAt: item.expiresAt,
        disposed: item.disposed,
      };
      const response = await request.post("/api/v1/cabinet", { headers, data });
      expect(response.ok()).toBe(true);
      saved.push({ id: (await response.json()).id, data });
    }
    await page.clock.install({ time: new Date("2026-10-19T16:00:00Z") });
    await page.goto("/#cabinet");
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "家庭藥箱", exact: true }),
    ).toBeVisible();
    const tag = (key: string) =>
      page
        .locator(".list-row")
        .filter({ has: page.getByText(prefix + "-" + key, { exact: true }) })
        .locator(".tag");
    // Wait for the actual rows before advancing time. The heading is visible
    // while the request is still loading; jumping an hour would expire it.
    await expect(tag("yesterday")).toHaveText("已過期");
    // Freeze at 01:00 so a slower test runner cannot move the midnight assertions.
    await page.clock.pauseAt(new Date("2026-10-19T17:00:00Z"));
    await expect(tag("yesterday")).toHaveText("已過期");
    await expect(tag("yesterday")).toHaveClass(/\bamber\b/);
    await expect(tag("today")).toHaveText("保存中");
    await expect(tag("tomorrow")).toHaveText("保存中");
    await expect(tag("no-expiry")).toHaveText("保存中");
    await expect(tag("disposed")).toHaveText("已處理");
    await expect(tag("disposed")).not.toHaveClass(/\bamber\b/);

    // 01:00 -> 08:00 Taipei: crossing UTC midnight must not alter these labels.
    await page.clock.fastForward(7 * 60 * 60 * 1_000);
    await expect(tag("yesterday")).toHaveText("已過期");
    await expect(tag("today")).toHaveText("保存中");

    // Keep the same page open from 23:59:59 through the next Taipei midnight.
    await page.clock.fastForward(16 * 60 * 60 * 1_000 - 1_000);
    await expect(tag("today")).toHaveText("保存中");
    await page.clock.runFor(1_000);
    await expect(tag("today")).toHaveText("已過期");
    await expect(tag("today")).toHaveClass(/\bamber\b/);
    await expect(tag("tomorrow")).toHaveText("保存中");
    await expect(tag("no-expiry")).toHaveText("保存中");
    await expect(tag("disposed")).toHaveText("已處理");
    expect(aiRequests).toEqual([]);
  } finally {
    for (const item of saved)
      await request.put("/api/v1/cabinet/" + item.id, {
        headers,
        data: { ...item.data, disposed: true },
      });
  }
});
