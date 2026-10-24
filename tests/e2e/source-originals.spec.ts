import { expect, test, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  const med = {
    id: "synthetic-original-med",
    name: "合成官方來源藥品",
    licenseNo: "SYNTHETIC-ORIGINAL",
    confirmed: true,
    revision: 1,
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
    identityReview: { status: "confirmed", missingFields: [] },
  };
  const requests: { method: string; path: string }[] = [],
    unexpected: string[] = [];
  await page.addInitScript(() =>
    sessionStorage.setItem("yzt-local-token", "synthetic-source-only"),
  );
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL!).origin) {
      unexpected.push(request.method() + " " + url.origin);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      await route.continue();
      return;
    }
    const path = url.pathname.slice("/api/v1".length);
    requests.push({ method: request.method(), path });
    if (request.method() === "POST" && path === "/bundles") {
      await route.fulfill({
        status: 422,
        json: {
          code: "source_requires_review",
          message: "官方仿單仍待整理，未建立任務或使用額度。",
        },
      });
      return;
    }
    const reads: Record<string, unknown> = {
      "/config": {
        mode: "local",
        ai: false,
        dailyUserLimit: 20,
        dailyGlobalLimit: 1000,
      },
      "/me": {
        account: {
          id: "synthetic-original-owner",
          eligible: true,
          admin: false,
        },
        profile: {},
      },
      "/medications": { items: [med] },
      "/learning": { items: [] },
      ["/medications/" + med.id + "/source"]: {
        medicationId: med.id,
        medicationRevision: med.revision,
        state: "needs_review",
        sources: [
          {
            licenseNo: med.licenseNo,
            version: "synthetic-v1",
            sourceUrl:
              "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2",
          },
        ],
      },
    };
    if (request.method() === "GET" && path in reads) {
      await route.fulfill({ json: reads[path] });
      return;
    }
    unexpected.push(request.method() + " " + path);
    await route.abort();
  });
  return { requests, unexpected };
}
async function verifyOriginal(page: Page) {
  const panel = page.getByRole("region", { name: "官方仿單來源", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("查閱來源不使用 AI 額度");
  await panel.locator("summary").click();
  await expect(
    panel.getByRole("link", { name: "開啟官方仿單原文", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
test("official originals are directly readable without creating an AI or learning task", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#medications");
  await page.getByRole("button", { name: "官方仿單原文", exact: true }).click();
  await verifyOriginal(page);
  expect(state.requests.filter((row) => row.method !== "GET")).toEqual([]);
  expect(state.requests.filter((row) => row.path === "/learning")).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
test("a known source hold shows the free original instead of a missing AI job or quiz", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#medications");
  await page.getByRole("button", { name: "仿單說明", exact: true }).click();
  await verifyOriginal(page);
  await expect(page.getByRole("alert")).toContainText("來源狀態與可用原文");
  expect(
    state.requests
      .filter((row) => row.method === "POST")
      .map((row) => row.path),
  ).toEqual(["/bundles"]);
  expect(
    state.requests.some(
      (row) => row.path.startsWith("/jobs/") || row.path.endsWith("/answers"),
    ),
  ).toBe(false);
  expect(state.unexpected).toEqual([]);
});
test("a source response for a changed medication cannot appear under the old product card", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.route(
    "**/api/v1/medications/synthetic-original-med/source",
    async (route) => {
      await route.fulfill({
        json: {
          medicationId: "synthetic-original-med",
          medicationRevision: 2,
          state: "available",
          sources: [
            {
              licenseNo: "SYNTHETIC-OTHER",
              version: "synthetic-v2",
              sourceUrl:
                "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic-other?c=2",
            },
          ],
        },
      });
    },
  );
  await page.goto("/#medications");
  await page.getByRole("button", { name: "官方仿單原文", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("藥品資料已更新");
  await expect(
    page.getByRole("region", { name: "官方仿單來源", exact: true }),
  ).toHaveCount(0);
  expect(state.requests.filter((row) => row.method !== "GET")).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
