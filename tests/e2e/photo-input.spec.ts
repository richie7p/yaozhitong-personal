import { expect, test } from "@playwright/test";

const syntheticPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
);

test("camera requests rear capture and upload clears it without losing a cancelled selection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  const input = page.getByLabel("藥袋照片", { exact: true });
  const cameraChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "開啟相機拍攝", exact: true }).click();
  const camera = await cameraChooser;
  await expect(input).toHaveAttribute("capture", "environment");
  await camera.setFiles({
    name: "synthetic-camera.png",
    mimeType: "image/png",
    buffer: syntheticPng,
  });
  await expect(page.locator(".capture-preview figcaption")).toHaveText(
    "synthetic-camera.png",
  );
  const pickerChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "更換照片", exact: true }).click();
  await pickerChooser;
  await expect(input).not.toHaveAttribute("capture");
  // A cancelled native picker emits no replacement selection. Keep the last
  // valid preview and allow recognition, even though the input value was reset.
  await expect(page.locator(".capture-preview figcaption")).toHaveText(
    "synthetic-camera.png",
  );
  await expect(page.getByRole("button", { name: "開始辨識" })).toBeEnabled();
  await input.setInputFiles({
    name: "synthetic-camera.png",
    mimeType: "image/png",
    buffer: syntheticPng,
  });
  await expect(page.getByRole("button", { name: "開始辨識" })).toBeEnabled();
});

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
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
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

for (const invalidPhoto of [
  {
    name: "replacement.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("0000ftypheic"),
    message: "請選擇 JPEG 或 PNG",
  },
  {
    name: "replacement-too-large.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.alloc(8_000_001),
    message: "照片超過 8 MB",
  },
]) {
  test(`replacing completed photo A with ${invalidPhoto.name} clears its results before accepting photo B`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await page.goto("/#add");
    let calls = 0;
    await page.route("**/api/v1/recognitions", async (route) => {
      calls++;
      await route.fulfill({
        status: 202,
        json: {
          jobId: `synthetic-photo-replacement-${calls}`,
          status: "queued",
        },
      });
    });
    await page.route(
      "**/api/v1/jobs/synthetic-photo-replacement-*",
      async (route) => {
        const first = route.request().url().endsWith("-1");
        const medication = {
          name: first ? "合成照片 A 的待核對藥品" : "合成照片 B 的待核對藥品",
          rawText: first
            ? "合成照片 A 原文，僅供測試"
            : "合成照片 B 原文，僅供測試",
          candidates: [],
        };
        await route.fulfill({
          json: {
            id: first
              ? "synthetic-photo-replacement-1"
              : "synthetic-photo-replacement-2",
            kind: "recognition",
            status: "succeeded",
            result: {
              medications: first
                ? [{ name: "合成照片 A 已保存藥品" }, medication]
                : [medication],
            },
            savedMedications: first
              ? {
                  "0": {
                    id: "synthetic-saved-photo-a",
                    name: "合成照片 A 已保存藥品",
                  },
                }
              : {},
          },
        });
      },
    );
    const input = page.locator('input[type="file"]');
    const start = page.getByRole("button", { name: "開始辨識" });
    await input.setInputFiles({
      name: "photo-a.png",
      mimeType: "image/png",
      buffer: syntheticPng,
    });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(
      page.getByRole("heading", {
        name: "合成照片 A 的待核對藥品",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "合成照片 A 已保存藥品" }),
    ).toBeVisible();
    await input.setInputFiles(invalidPhoto);
    await expect(page.getByRole("alert")).toContainText(invalidPhoto.message);
    await expect(start).toBeDisabled();
    await expect(page.locator(".capture-preview")).toHaveCount(0);
    await expect(
      page.locator(".capture-result-sheet, .capture-review"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "編輯這筆資料", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("合成照片 A 已保存藥品", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("list", { name: "操作步驟" })
        .locator('[aria-current="step"]'),
    ).toContainText("選擇藥袋");
    expect(calls).toBe(1);

    await input.setInputFiles({
      name: "photo-b.png",
      mimeType: "image/png",
      buffer: syntheticPng,
    });
    await expect(start).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".capture-preview figcaption")).toHaveText(
      "photo-b.png",
    );
    await expect(page.locator(".capture-result-sheet")).toHaveCount(0);
    expect(calls).toBe(1);
    await start.click();
    await expect(
      page.getByRole("heading", {
        name: "合成照片 B 的待核對藥品",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "合成照片 A 的待核對藥品",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(calls).toBe(2);
  });
}

test("a late validation of photo A cannot restore it after a newer invalid selection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await page.goto("/#add");
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    let holdFirstRead = true;
    Blob.prototype.arrayBuffer = function () {
      const result = original.call(this);
      if (!holdFirstRead) return result;
      holdFirstRead = false;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        Object.assign(window, {
          releaseSyntheticPhotoRead: async () => {
            Blob.prototype.arrayBuffer = original;
            await result.then(resolve, reject);
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
          },
        });
      });
    };
  });
  const input = page.locator('input[type="file"]');
  const start = page.getByRole("button", { name: "開始辨識" });
  await input.setInputFiles({
    name: "slow-photo-a.png",
    mimeType: "image/png",
    buffer: syntheticPng,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "正在檢查照片" }),
  ).toBeVisible();
  // Dispatch a newer selection while A's byte read is pending, even though the picker is disabled.
  await page.evaluate(() => {
    const element =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["0000ftypheic"], "newer-photo.heic", { type: "image/heic" }),
    );
    element.files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("alert")).toContainText("請選擇 JPEG 或 PNG");
  await page.evaluate(async () => {
    const release = (
      window as unknown as { releaseSyntheticPhotoRead: () => Promise<void> }
    ).releaseSyntheticPhotoRead;
    await release();
  });
  await expect(start).toBeDisabled();
  await expect(
    page.locator(".capture-preview, .capture-result-sheet"),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("請選擇 JPEG 或 PNG");
});
