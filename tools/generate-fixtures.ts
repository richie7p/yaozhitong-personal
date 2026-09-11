import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const dir = ".local/evaluation";
await mkdir(dir + "/images", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1000, height: 700 },
  deviceScaleFactor: 1,
});
const fixtures: any[] = [];
for (let i = 0; i < 50; i++) {
  const name = `測試用藥品 A${String(i + 1).padStart(2, "0")}`;
  const missing = i % 5 === 0;
  const doseAmount = missing ? null : i % 3 === 0 ? 0.5 : 1;
  const frequency = missing
    ? null
    : ["QD PC", "BID AC", "TID PC", "PRN", "HS"][i % 5];
  const variant = ["clear", "blur", "dim", "tilted", "glare"][
    Math.floor(i / 10)
  ];
  const transform =
    variant === "blur"
      ? "filter:blur(1.5px)"
      : variant === "dim"
        ? "filter:brightness(.55)"
        : variant === "tilted"
          ? "transform:rotate(-4deg)"
          : "";
  await page.setContent(
    `<html lang="zh-Hant"><meta charset="utf-8"><style>body{margin:0;background:#d8dedb;font:24px Arial,sans-serif;padding:55px}.bag{background:white;padding:40px;border:2px solid #333;${transform}}h1{font-size:35px}small{color:#777;font-size:20px}.row{margin:22px 0}.glare{position:absolute;inset:0;background:linear-gradient(120deg,transparent 30%,#ffffffb0 48%,transparent 60%)}</style><div class="bag"><small>合成藥袋 · 僅供軟體測試 · 不是處方</small><h1>${name}</h1><div class="row">每次劑量：${doseAmount === null ? "" : doseAmount + " 錠"}</div><div class="row">服用頻次：${frequency || ""}</div><div class="row">途徑：口服　天數：7</div><hr><small>無真實患者資料；藥品名稱為虛構。</small></div>${variant === "glare" ? '<div class="glare"></div>' : ""}</html>`,
  );
  const file = `images/${String(i + 1).padStart(2, "0")}-${variant}.png`;
  await page.screenshot({ path: dir + "/" + file });
  fixtures.push({
    id: "image-" + (i + 1),
    file,
    synthetic: true,
    variant,
    split: i % 5 === 0 ? "test" : "development",
    expectedFields: {
      name,
      doseAmount,
      doseUnit: missing ? null : "錠",
      frequencyRaw: frequency,
      route: "口服",
      durationDays: 7,
    },
  });
}
await browser.close();
await writeFile(dir + "/images.json", JSON.stringify(fixtures, null, 2));
const db = JSON.parse(await readFile(".local/db.json", "utf8"));
const leaflets: any[] = Object.values(db.leaflets || {});
const qa: any[] = [];
for (let i = 0; i < leaflets.length && qa.length < 100; i++) {
  const l = leaflets[i];
  for (let k = 0; k < 4 && qa.length < 100; k++) {
    const c = l.chunks[Math.min(k, l.chunks.length - 1)];
    if (!c) continue;
    qa.push({
      id: "source-qa-" + (qa.length + 1),
      licenseNo: l.licenseNo,
      sourceVersion: l.version,
      sourceUrl: l.sourceUrl,
      split: i % 5 === 0 ? "test" : "development",
      question: `請根據「${l.licenseNo}」仿單，說明第 ${c.page} 頁中「${c.text.trim().slice(0, 24)}」這段原文的內容。`,
      referenceChunkIds: [c.id],
      referenceText: c.text,
      sourceReviewStatus: l.status,
      humanReviewed: false,
      type: "source-retrieval-smoke",
    });
  }
}
await writeFile(
  dir + "/source-qa.jsonl",
  qa.map((r) => JSON.stringify(r)).join("\n"),
);
await writeFile(
  dir + "/README.md",
  `# 開發評估資料\n\n${fixtures.length} 張圖片均為程式產生的合成藥袋，無真實藥品或患者，不能替代 50 張真實去識別化藥袋的泛化評估。\n\n${qa.length} 題問答為依實際官方仿單片段自動產生的檢索測試草稿，尚未人工驗證語意。以許可證分開開發與測試集，避免同一仿單跨組。\n\n此資料集不會進入正式使用者帳號，沒有對外公布准确率。\n`,
);
console.log(
  JSON.stringify({
    syntheticImages: fixtures.length,
    sourceQaDrafts: qa.length,
    directory: dir,
  }),
);
