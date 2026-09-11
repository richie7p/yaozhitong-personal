import { Nvidia, grounded } from "../server/ai.js";
import { config } from "../server/config.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const n = new Nvidia(),
  start = Date.now();
// Only a visually checked storage-condition fragment is used by this developer
// smoke test. It does not publish or approve the full draft leaflet.
const db = JSON.parse(await readFile(".local/db.json", "utf8"));
const leaflet: any = Object.values(db.leaflets).find(
  (l: any) => l.licenseNo === "內衛成製字第000075號",
);
if (!leaflet) throw Error("Collect the official leaflet fixtures first.");
const page = leaflet.chunks.find((c: any) => c.page === 2);
const startOffset = page.text.indexOf("【 儲藏條件 】"),
  endOffset = page.text.indexOf("【 包");
if (startOffset < 0 || endOffset <= startOffset)
  throw Error(
    "Source changed; inspect the source fragment before updating this smoke test.",
  );
const chunks = [
  {
    ...page,
    id: page.id + "-storage-fragment",
    start: startOffset,
    text: page.text.slice(startOffset, endOffset).trim(),
  },
];
let report: any;
try {
  const result = await grounded(
    n,
    "請只整理此仿單的儲藏條件，並出一題理解測驗。",
    chunks,
    { medications: [{ licenseNo: leaflet.licenseNo, name: "蘇打錠" }] },
    "bundle",
  );
  const passed =
    result.status === "supported" &&
    result.claims.length > 0 &&
    result.quiz.length > 0;
  report = {
    passed,
    model: config.textModel,
    sourceUrl: leaflet.sourceUrl,
    sourceSha256: leaflet.sha256,
    sourceReview: "storage fragment only; full leaflet remains draft",
    latencyMs: Date.now() - start,
    tokens: n.tokens,
    result,
    limitation:
      "僅驗證單段儲藏條件的生成與審核串接，不代表完整仿單整理或醫療正確率。",
  };
  if (!passed) process.exitCode = 1;
} catch (e: any) {
  report = {
    passed: false,
    model: config.textModel,
    code: e.code || "error",
    message: e.message,
    latencyMs: Date.now() - start,
  };
  process.exitCode = 1;
}
await mkdir(".local/reports", { recursive: true });
await writeFile(
  ".local/reports/nvidia-generation.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
