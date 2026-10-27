import { expect, test } from "@playwright/test";

const candidate = {
  licenseNo: "SYNTHETIC-PHOTO-REVIEW",
  nameZh: "合成核對片",
  nameEn: "Synthetic review tablet",
  strength: "80mg",
  form: "錠劑",
  revoked: false,
  hasLeaflet: true,
};

for (const photo of [
  { label: "unreadable", strength: null, form: null },
  { label: "blank", strength: "", form: "" },
  { label: "transcribed", strength: "80mg/tab", form: "Tab" },
]) {
  test(`a photo candidate preserves ${photo.label} photo fields through review and save`, async ({
    page,
  }) => {
    const medication = {
      name: "合成核對片",
      strength: photo.strength,
      form: photo.form,
      doseAmount: 0.5,
      doseUnit: "粒",
      doseText: "",
      frequencyRaw: "BID PC",
      route: "口服",
      durationDays: 3,
      rawText: "合成流程測試；每次0.5粒；BID PC；口服；3天",
      candidates: [candidate],
    };
    let saved: Record<string, unknown> | undefined;
    const aiRequests: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/jobs/synthetic-photo-review") {
        await route.fulfill({
          json: {
            id: "synthetic-photo-review",
            kind: "recognition",
            status: "succeeded",
            result: { status: "succeeded", medications: [medication] },
          },
        });
      } else if (
        path === "/api/v1/recognitions/synthetic-photo-review/medications/0" &&
        request.method() === "POST"
      ) {
        saved = request.postDataJSON();
        await route.fulfill({
          status: 201,
          json: { ...saved, id: "synthetic-photo-medication" },
        });
      } else if (
        request.method() === "POST" &&
        /^\/api\/v1\/(recognitions|bundles|chat|interactions)$/.test(path)
      ) {
        aiRequests.push(path);
        await route.abort();
      } else await route.continue();
    });
    await page.goto("/");
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await page.goto("/#add?recognition=synthetic-photo-review");
    const result = page.locator(".capture-candidate");
    await expect(result).toContainText("80mg");
    await expect(result).toContainText("錠劑");
    await result.click();

    await expect
      .soft(page.getByLabel("含量／規格", { exact: true }))
      .toHaveValue(photo.strength || "");
    await expect
      .soft(page.getByLabel("劑型", { exact: true }))
      .toHaveValue(photo.form || "");
    await expect(page.getByLabel("許可證字號", { exact: true })).toHaveValue(
      "產品待核對，尚未連結仿單",
    );
    await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue(
      "0.5",
    );
    await expect(page.getByLabel("劑量單位", { exact: true })).toHaveValue(
      "粒",
    );
    await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue(
      "BID PC",
    );
    await expect(page.getByLabel("給藥途徑", { exact: true })).toHaveValue(
      "口服",
    );
    await expect(
      page.getByLabel("我已對照藥袋確認用法（每次用量、頻次與途徑）"),
    ).not.toBeChecked();
    await page
      .getByRole("button", { name: "保存待核對資料", exact: true })
      .click();
    await expect(page).toHaveURL(
      /#medications\?saved=synthetic-photo-medication$/,
    );
    expect(saved).toMatchObject({
      name: candidate.nameZh,
      licenseNo: null,
      candidateLicenseNo: candidate.licenseNo,
      identityEvidence: null,
      strength: photo.strength || "",
      form: photo.form || "",
      doseAmount: 0.5,
      doseUnit: "粒",
      frequencyRaw: "BID PC",
      route: "口服",
      rawText: medication.rawText,
      confirmed: false,
    });
    expect(aiRequests).toEqual([]);
  });
}

test("manual catalog search still prefills the selected official specification", async ({
  page,
}) => {
  await page.route("**/api/v1/drugs/search?*", (route) =>
    route.fulfill({ json: { items: [candidate] } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.getByRole("button", { name: "搜尋藥名", exact: true }).click();
  await page.getByLabel("搜尋藥名", { exact: true }).fill(candidate.nameZh);
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.locator(".search-result").click();
  await expect(page.getByLabel("含量／規格", { exact: true })).toHaveValue(
    "80mg",
  );
  await expect(page.getByLabel("劑型", { exact: true })).toHaveValue("錠劑");
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("我已對照藥袋確認用法（每次用量、頻次與途徑）"),
  ).not.toBeChecked();
});
