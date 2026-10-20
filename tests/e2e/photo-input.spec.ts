import { expect, test } from "@playwright/test";

test("invalid camera files never enqueue AI and selecting a valid image restores recognition", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  let calls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/recognitions"))
      calls++;
  });
  const input = page.locator('input[type="file"]');
  const start = page.getByRole("button", { name: "開始辨識" });
  for (const photo of [
    {
      name: "camera.heic",
      mimeType: "image/heic",
      buffer: Buffer.from("0000ftypheic"),
      message: "請選擇 JPEG 或 PNG",
    },
    {
      name: "large.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.alloc(8_000_001),
      message: "照片超過 8 MB",
    },
    {
      name: "empty.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(0),
      message: "這張照片是空的",
    },
    {
      name: "renamed.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
      message: "請選擇 JPEG 或 PNG",
    },
  ]) {
    await input.setInputFiles(photo);
    await expect(page.getByRole("alert")).toContainText(photo.message);
    await expect(start).toBeDisabled();
    expect(calls).toBe(0);
  }
  // A camera/file picker may omit MIME metadata; trust the supported bytes.
  await input.setInputFiles({
    name: "camera-without-mime.png",
    mimeType: "",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(start).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await start.click();
  await expect(
    page.getByRole("button", { name: "編輯這筆資料", exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
});
