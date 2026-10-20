import { expect, test } from "@playwright/test";

test.describe("new recognition drafts", () => {
  // This job exists only in the route fixture. Service worker routing must not
  // bypass that fixture and accidentally request a nonexistent backend job.
  test.use({ serviceWorkers: "block" });

  test("new PRN recognition defaults stay editable and unconfirmed through both review entries", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    let mockedRecognitionRequests = 0;
    await page.route("**/api/v1/jobs/synthetic-prn-draft", (route) => {
      mockedRecognitionRequests++;
      return route.fulfill({
        json: {
          id: "synthetic-prn-draft",
          kind: "recognition",
          status: "succeeded",
          result: {
            medications: ["PRN", "TID"].map((frequencyRaw) => ({
              name: `合成頻次-${frequencyRaw}`,
              frequencyRaw,
              doseAmount: 1,
              doseUnit: "錠",
              rawText:
                frequencyRaw === "PRN"
                  ? "每次一錠，PRN，需要時才服用"
                  : "每次一錠，TID",
              candidates: [
                {
                  nameZh: `合成候選-${frequencyRaw}`,
                  licenseNo: `synthetic-${frequencyRaw}`,
                  strength: "10 mg",
                  form: "錠劑",
                  hasLeaflet: false,
                },
              ],
            })),
          },
        },
      });
    });
    await page.goto("/#add?recognition=synthetic-prn-draft");
    await expect.poll(() => mockedRecognitionRequests).toBe(1);
    const asNeeded = page.getByLabel("需要時才使用（不排定時提醒）", {
      exact: true,
    });
    const confirmed = page.getByLabel("我已對照藥袋確認藥品與用法", {
      exact: true,
    });
    for (const frequency of ["PRN", "TID"]) {
      for (const entry of ["edit", "candidate"]) {
        const result = page.locator(".capture-result-sheet").filter({
          has: page.getByRole("heading", {
            name: `合成頻次-${frequency}`,
            exact: true,
          }),
        });
        await result
          .getByRole("button", {
            name:
              entry === "edit"
                ? "編輯這筆資料"
                : new RegExp(`合成候選-${frequency}`),
          })
          .click();
        await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue(
          frequency,
        );
        if (frequency === "PRN") await expect(asNeeded).toBeChecked();
        else await expect(asNeeded).not.toBeChecked();
        await expect(confirmed).not.toBeChecked();
        await expect(
          page.getByRole("button", { name: "儲存草稿", exact: true }),
        ).toBeVisible();
        // The prefill is a draft choice, not an enforced or confirmed instruction.
        await asNeeded.setChecked(frequency !== "PRN");
        if (frequency === "PRN") await expect(asNeeded).not.toBeChecked();
        else await expect(asNeeded).toBeChecked();
        await expect(confirmed).not.toBeChecked();
        await page
          .getByRole("button", { name: "返回辨識結果", exact: true })
          .click();
      }
    }
  });
});

test("editing an existing medication retains the user's PRN setting despite its frequency text", async ({
  page,
  request,
}) => {
  const { token } = await (
    await request.post("/api/v1/auth/local", { data: { uid: "local-owner" } })
  ).json();
  const name = `合成已核對頻次-${Date.now()}`;
  const response = await request.post("/api/v1/medications", {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "PRN",
      prn: false,
      confirmed: true,
    },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  const card = page.locator(".med-card").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
  await card.getByRole("button", { name: "編輯用法", exact: true }).click();
  await expect(
    page.getByLabel("需要時才使用（不排定時提醒）", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("我已對照藥袋確認藥品與用法", { exact: true }),
  ).toBeChecked();
});
