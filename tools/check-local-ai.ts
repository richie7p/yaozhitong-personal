/** Bounded real NVIDIA calls through an isolated copy of the built local app. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { config } from "../server/config.js";
if (!config.nvidiaKey)
  throw Error("Set NVIDIA_API_KEY for this opt-in real-model check");
const review = JSON.parse(
  await readFile("data/leaflets/local-reviewed.json", "utf8"),
);
const source = JSON.parse(await readFile(".local/db.json", "utf8"));
const directory = `.local/real-ai-${Date.now()}`,
  base = "http://127.0.0.1:5195";
await mkdir(directory + "/blobs/catalog", { recursive: true });
const catalog = JSON.parse(
  await readFile(".local/blobs/" + source.settings.catalog.path, "utf8"),
);
const drugs = catalog.filter((d: any) =>
  review.items.some((r: any) => r.licenseNo === d.licenseNo),
);
await writeFile(directory + "/blobs/catalog/test.json", JSON.stringify(drugs));
const leaflets = Object.fromEntries(
  Object.entries(source.leaflets)
    .filter(([, l]: any) =>
      review.items.some(
        (r: any) => r.licenseNo === l.licenseNo && r.version === l.version,
      ),
    )
    .map(([id, l]: any) => [
      id,
      { ...l, status: "draft", checkedBy: null, checkedAt: null },
    ]),
);
expect(Object.keys(leaflets).length).toBe(2);
await writeFile(
  directory + "/db.json",
  JSON.stringify({
    leaflets,
    settings: {
      catalog: { version: "real-model-test", path: "catalog/test.json" },
    },
  }),
);
let child: ChildProcess | undefined, browser;
const report: any = {
  createdAt: new Date().toISOString(),
  directory,
  syntheticPatient: true,
  textModel: config.textModel,
  visionModel: config.visionModel,
  sourceReview: review.scope,
  steps: [],
};
try {
  child = spawn(process.execPath, ["dist/server/index.mjs"], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      APP_MODE: "local",
      NODE_ENV: "",
      PORT: "5195",
      LOCAL_DATA_PATH: directory,
    },
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(base + "/health")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(base);
  await page.getByRole("button", { name: "本機管理員", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.goto(base + "/#admin");
  await page.getByRole("button", { name: "仿單管理", exact: true }).click();
  for (const item of review.items) {
    const row = page.locator("section.card").filter({
      has: page.getByRole("heading", { name: item.licenseNo, exact: true }),
    });
    await row.getByLabel("我已核對許可證、原 PDF、頁碼與抽取文字").check();
    await row.getByRole("button", { name: "發布此版本" }).click();
    await expect(row.getByText("已發布", { exact: true })).toBeVisible();
  }
  report.steps.push({ step: "admin-source-publish", passed: true });
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  const photoPage = await browser.newPage({
    viewport: { width: 950, height: 650 },
  });
  await photoPage.setContent(
    '<html lang="zh-Hant"><meta charset="utf-8"><style>body{font:30px Arial;background:#fff;padding:45px}p{margin:30px 0}</style><small>合成藥袋／測試用途／非真實處方</small><h1>酵素膠囊</h1><p>每次：1 粒　頻次：TID</p><p>途徑：口服　天數：7</p><p>沒有真實患者資料</p></html>',
  );
  const image = await photoPage.screenshot();
  await photoPage.close();
  await page.goto(base + "/#add");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-enzyme.png",
    mimeType: "image/png",
    buffer: image,
  });
  await page.getByRole("button", { name: "開始辨識" }).click();
  await page
    .locator(".search-result")
    .filter({ hasText: "內衛成製字第000544號" })
    .click({ timeout: 180000 });
  await expect(page.getByLabel("每次劑量", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("頻次原文", { exact: true })).toHaveValue("TID");
  await page.getByLabel("我已對照藥袋確認藥品與用法").check();
  await page.getByRole("button", { name: "確認並儲存藥品" }).click();
  await expect(
    page.getByRole("heading", { name: "酵素膠囊", exact: true }),
  ).toBeVisible();
  report.steps.push({
    step: "real-vision-candidates-confirmation",
    passed: true,
  });
  await page.getByRole("button", { name: "仿單說明", exact: true }).click();
  await expect(
    page.locator(".evidence").getByText("已附仿單依據", { exact: true }),
  ).toBeVisible({ timeout: 300000 });
  await expect(page.locator(".quiz fieldset").first()).toBeVisible();
  await page.screenshot({
    path: directory + "/real-bundle.png",
    fullPage: true,
  });
  report.steps.push({ step: "real-source-bundle-and-quiz", passed: true });
  const auth = await (
    await fetch(base + "/api/v1/auth/local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: "local-owner" }),
    })
  ).json();
  const headers = {
    authorization: "Bearer " + auth.token,
    "content-type": "application/json",
  };
  const call = async (path: string, method = "GET", data?: unknown) => {
    const r = await fetch(base + "/api/v1" + path, {
      method,
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!r.ok)
      throw Error("Local API check failed: " + path + " HTTP " + r.status);
    return r.json();
  };
  const ownerMeds = (await call("/medications")).items;
  const other = drugs.find((d: any) => d.licenseNo !== "內衛成製字第000544號");
  const otherMed = await call("/medications", "POST", {
    name: other.nameZh,
    licenseNo: other.licenseNo,
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "PRN",
    prn: true,
    confirmed: true,
  });
  await page.goto(base + "/#chat");
  await page.getByLabel("酵素膠囊", { exact: true }).check();
  await page.locator("textarea").fill("請只說明仿單記載的儲存條件。");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await expect(
    page
      .locator(".chat-exchange .evidence")
      .getByText("已附仿單依據", { exact: true }),
  ).toBeVisible({ timeout: 300000 });
  report.steps.push({ step: "real-source-chat", passed: true });
  await page.goto(base + "/#learning");
  await page.getByLabel("酵素膠囊", { exact: true }).check();
  await page.getByLabel(other.nameZh, { exact: true }).check();
  await page.getByRole("button", { name: "比對交互作用" }).click();
  await expect(
    page.getByRole("heading", { name: "交互作用核對", exact: true }),
  ).toBeVisible({ timeout: 300000 });
  const jobs = (await call("/jobs")).items;
  expect(jobs.every((j: any) => j.status === "succeeded")).toBe(true);
  const interaction = jobs.find((j: any) => j.kind === "interaction");
  // These reviewed leaflets contain no explicit interaction between this pair.
  // A generic alcohol warning must never make this check "supported".
  expect(["not_found", "insufficient_data"]).toContain(
    interaction.result.status,
  );
  expect(interaction.result.claims).toHaveLength(0);
  report.steps.push({
    step: "real-source-interaction",
    passed: true,
    status: interaction.result.status,
  });
  report.jobs = jobs.map((j: any) => ({
    kind: j.kind,
    status: j.status,
    tokens: j.tokens,
    latencyMs: j.latencyMs,
    resultStatus: j.result?.status,
    claims: j.result?.claims?.length,
    quiz: j.result?.quiz?.length,
    rejectedCount: j.result?.rejectedCount,
  }));
  report.status = "passed";
} catch (e: any) {
  report.status = "failed";
  report.error = e.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const done = once(child, "exit");
    child.kill();
    await done;
  }
}
await mkdir(".local/reports", { recursive: true });
await writeFile(
  ".local/reports/local-real-ai.json",
  JSON.stringify(report, null, 2),
);
await writeFile(directory + "/report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
