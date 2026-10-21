import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("opening and switching medication editors brings the form into view on a long mobile list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const medications = Array.from({ length: 7 }, (_, index) => ({
    id: `synthetic-editor-focus-${index}`,
    name: `合成長清單藥品 ${index + 1}`,
    doseAmount: index + 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
    route: "口服",
    confirmed: true,
    prn: false,
  }));
  await page.route("**/api/v1/medications", (route) =>
    route.fulfill({ json: { items: medications, duplicates: [] } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#medications");
  await expect(page.locator(".med-card")).toHaveCount(7);
  const editorHeading = page.getByRole("heading", {
    name: "編輯用法",
    exact: true,
  });
  const name = page.getByLabel("藥品名稱", { exact: true });
  const dose = page.getByLabel("每次劑量", { exact: true });
  const openEditor = (index: number) =>
    page
      .locator(`.med-card[data-medication-id="${medications[index].id}"]`)
      .getByRole("button", { name: "編輯用法", exact: true })
      .click();

  await openEditor(0);
  await expect(editorHeading).toBeFocused();
  await expect(editorHeading).toBeInViewport({ ratio: 1 });
  await expect(name).toHaveValue(medications[0].name);
  await dose.fill("6");

  // Returning to the same card should reveal the existing unsaved form again.
  await openEditor(0);
  await expect(editorHeading).toBeFocused();
  await expect(editorHeading).toBeInViewport({ ratio: 1 });
  await expect(dose).toHaveValue("6");

  await openEditor(1);
  await expect(editorHeading).toBeFocused();
  await expect(editorHeading).toBeInViewport({ ratio: 1 });
  await expect(name).toHaveValue(medications[1].name);
  await expect(dose).toHaveValue("2");
});
