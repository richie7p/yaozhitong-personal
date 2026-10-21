import { expect, test } from "@playwright/test";
import sharp from "sharp";

// Valid, entirely synthetic image. No camera, real prescription, or paid AI.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
});

test("upload picker accepts a supported file without opening the camera and completes recognition", async ({
  page,
}) => {
  const chooserEvent = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上傳照片", exact: true }).click();
  const chooser = await chooserEvent;
  await expect(
    page.getByLabel("藥袋照片", { exact: true }),
  ).not.toHaveAttribute("capture");
  await chooser.setFiles({
    name: "synthetic-upload.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.locator(".capture-preview figcaption")).toHaveText(
    "synthetic-upload.png",
  );
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/recognitions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  expect((await accepted).status()).toBe(202);
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
});

test("a truncated JPEG receives a readable server rejection and can be replaced with a valid upload", async ({
  page,
}) => {
  const jpeg = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const input = page.getByLabel("藥袋照片", { exact: true });
  await input.setInputFiles({
    name: "synthetic-truncated.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg.subarray(0, jpeg.length - 3),
  });
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/recognitions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await expect(page.getByRole("alert")).toContainText("照片格式或內容無法讀取");
  await expect(
    page.getByRole("button", { name: "開始辨識", exact: true }),
  ).toBeEnabled();
  await input.setInputFiles({
    name: "synthetic-valid.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "開始辨識", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
});
