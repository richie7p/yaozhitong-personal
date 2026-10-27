import { expect, test } from "@playwright/test";

// Real local upload/job/save endpoints with the isolated synthetic upstream.
// The test does not mock application APIs or call an external AI provider.
test("upload, manually confirm edited usage, save and reload the stored medication", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.getByLabel("藥袋照片", { exact: true }).setInputFiles({
    name: "synthetic-confirm-save.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  const recognitionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/recognitions",
  );
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  const recognition = await recognitionResponse;
  expect(recognition.status()).toBe(202);
  const { jobId } = await recognition.json();
  await page.getByRole("button", { name: "編輯這筆資料", exact: true }).click();
  const confirmed = page.getByLabel(
    "我已對照藥袋確認用法（每次用量、頻次與途徑）",
  );
  await expect(confirmed).not.toBeChecked();
  const name = `合成上傳確認保存-${testInfo.project.name}-${Date.now()}`;
  await page.getByLabel("藥品名稱", { exact: true }).fill(name);
  await page.getByLabel("每次劑量", { exact: true }).fill("2");
  await page.getByLabel("劑量單位", { exact: true }).fill("錠");
  await page.getByLabel("頻次原文", { exact: true }).fill("BID PC");
  await page.getByLabel("給藥途徑", { exact: true }).fill("口服");
  await confirmed.check();
  await page.screenshot({
    path: testInfo.outputPath("confirmed-before-save.png"),
    fullPage: true,
  });
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/recognitions/${jobId}/medications/0`,
  );
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  const saved = await saveResponse;
  expect(saved.status()).toBe(201);
  const medication = await saved.json();
  expect(medication).toMatchObject({
    name,
    doseAmount: 2,
    doseUnit: "錠",
    frequencyRaw: "BID PC",
    route: "口服",
    confirmed: true,
  });
  await expect(page).toHaveURL(/#medications\?saved=[^&]+$/);
  const readBack = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/medications",
  );
  await page.reload();
  const { items } = await (await readBack).json();
  expect(
    items.filter((item: { id: string }) => item.id === medication.id),
  ).toEqual([
    expect.objectContaining({
      id: medication.id,
      name,
      doseAmount: 2,
      doseUnit: "錠",
      frequencyRaw: "BID PC",
      route: "口服",
      confirmed: true,
    }),
  ]);
  await expect(page.locator(".med-card").filter({ hasText: name })).toHaveCount(
    1,
  );
  await page.screenshot({
    path: testInfo.outputPath("saved-after-reload.png"),
    fullPage: true,
  });
});
