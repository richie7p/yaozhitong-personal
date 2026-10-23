import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function fixture(page: Page, pause: "job" | "refresh") {
  const medications = ["a", "b"].map((suffix) => ({
    id: "synthetic-interaction-" + suffix,
    name: "合成交互作用藥品" + suffix,
    licenseNo: "SYNTHETIC-INTERACTION-" + suffix,
    confirmed: true,
    revision: 1,
    identityReview: { status: "confirmed", missingFields: [] },
    frequencyRaw: "QD",
    doseAmount: 1,
    doseUnit: "錠",
  }));
  const unexpected: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hasJob = false,
    paused = false,
    posts = 0;
  await page.addInitScript(() =>
    sessionStorage.setItem("yzt-local-token", "synthetic-navigation-only"),
  );
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL!).origin) {
      unexpected.push(request.method() + " " + url.origin + url.pathname);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      await route.continue();
      return;
    }
    const path = url.pathname.slice("/api/v1".length);
    if (request.method() === "POST" && path === "/interactions") {
      posts++;
      hasJob = true;
      await route.fulfill({
        status: 202,
        json: { jobId: "synthetic-interaction-job" },
      });
      return;
    }
    if (
      request.method() === "GET" &&
      path === "/jobs/synthetic-interaction-job"
    ) {
      if (pause === "job" && !paused) {
        paused = true;
        await held;
      }
      await route.fulfill({
        json: { id: "synthetic-interaction-job", status: "succeeded" },
      });
      return;
    }
    if (request.method() === "GET" && path === "/learning") {
      if (pause === "refresh" && hasJob && !paused) {
        paused = true;
        await held;
      }
      await route.fulfill({ json: { items: [] } });
      return;
    }
    const reads: Record<string, unknown> = {
      "/config": { mode: "local", ai: false },
      "/me": {
        account: {
          id: "synthetic-interaction-owner",
          eligible: true,
          admin: false,
        },
        profile: {},
      },
      "/medications": { items: medications },
    };
    if (request.method() === "GET" && path in reads) {
      await route.fulfill({ json: reads[path] });
      return;
    }
    unexpected.push(request.method() + " " + path);
    await route.abort();
  });
  return {
    medications,
    unexpected,
    release,
    paused: () => paused,
    posts: () => posts,
  };
}

for (const pause of ["job", "refresh"] as const) {
  test(`interaction ${pause} completing after leaving keeps the user's current page`, async ({
    page,
  }) => {
    const state = await fixture(page, pause);
    await page.goto("/#learning");
    for (const medication of state.medications)
      await page
        .getByRole("checkbox", { name: medication.name, exact: true })
        .check();
    await page
      .getByRole("button", { name: "比對交互作用", exact: true })
      .click();
    await expect.poll(state.paused).toBe(true);
    await page.locator('a[href="#medications"]:visible').first().click();
    await expect(page).toHaveURL(/#medications$/);
    state.release();
    await expect(
      page.getByRole("heading", { name: "我的藥品", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#medications$/);
    expect(state.posts()).toBe(1);
    expect(state.unexpected).toEqual([]);
  });
}
