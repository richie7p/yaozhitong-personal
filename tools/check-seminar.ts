/** Read-only local demonstration checks. Never starts a server or calls an AI. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { aiConnection, config } from "../server/config.js";
import { GROUNDING_VERSION } from "../server/ai.js";
import { CATALOG_SOURCE } from "../server/import-catalog.js";
import type { Drug, Leaflet } from "../shared/schema.js";

interface LocalDb {
  settings?: {
    catalog?: { path: string; version: string; count: number; source: string };
  };
  published?: Record<string, { leafletId: string; version: string }>;
  leaflets?: Record<string, Leaflet>;
  learning?: Record<
    string,
    {
      groundingVersion?: string;
      result?: { status?: string; claims?: unknown[]; quiz?: unknown[] };
    }
  >;
}
interface ReviewedSource {
  licenseNo: string;
  sha256: string;
  version: string;
}
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
let blockers = 0;
const ok = (message: string) => console.log("通過：" + message);
const warn = (message: string) => console.log("警示：" + message);
const block = (message: string) => {
  blockers++;
  console.log("阻擋：" + message);
};
function blobFile(key: unknown) {
  if (
    typeof key !== "string" ||
    !/^[a-zA-Z0-9_./-]+$/.test(key) ||
    key.includes("..")
  )
    throw Error("Invalid blob path");
  return join(config.localPath, "blobs", key);
}
function officialUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "fda.gov.tw" || url.hostname.endsWith(".fda.gov.tw"))
    );
  } catch {
    return false;
  }
}

async function main() {
  console.log("藥智通研討會本機檢查（唯讀，不呼叫外部 AI）");
  if (config.mode !== "local") {
    block("APP_MODE 必須為 local；本工具只檢查本機展示。");
    return;
  }
  ok("APP_MODE 為 local");
  for (const file of ["dist/web/index.html", "dist/server/index.mjs"]) {
    if (
      await stat(file)
        .then((s) => s.isFile())
        .catch(() => false)
    )
      ok(file + " 已建置");
    else block(file + " 缺失，請先執行 npm run build。");
  }
  if (aiConnection().key)
    ok(
      `已設定 ${aiConnection().label} 金鑰；連線、額度及真實內容未在本次檢查驗證`,
    );
  else
    warn(
      `未設定 ${aiConnection().label} 金鑰，AI 不可展示；手動建檔、提醒及紀錄功能可用。`,
    );

  let db: LocalDb;
  try {
    db = JSON.parse(await readFile(join(config.localPath, "db.json"), "utf8"));
    if (!db || typeof db !== "object" || Array.isArray(db))
      throw Error("Invalid database");
  } catch {
    block(
      "找不到或無法讀取本機資料庫；請執行 npm run prepare:local:demo 後重查。",
    );
    return;
  }
  let catalog: Drug[] = [];
  try {
    const metadata = db.settings?.catalog;
    if (!metadata || metadata.source !== CATALOG_SOURCE)
      throw Error("Missing official catalog");
    const bytes = await readFile(blobFile(metadata.path));
    catalog = JSON.parse(bytes.toString("utf8"));
    if (
      !Array.isArray(catalog) ||
      !catalog.length ||
      catalog.length !== metadata.count ||
      digest(bytes).slice(0, 16) !== metadata.version
    )
      throw Error("Invalid official catalog");
    ok(
      `官方藥品主檔 ${catalog.length.toLocaleString("en-US")} 筆，數量與版本一致`,
    );
  } catch {
    block(
      "官方藥品主檔缺失或數量／版本不符；請執行 npm run prepare:local:demo 並檢查主檔匯入狀態。",
    );
  }

  let reviewed: ReviewedSource[];
  try {
    const review = JSON.parse(
      await readFile("data/leaflets/local-reviewed.json", "utf8"),
    );
    if (!Array.isArray(review.items) || review.items.length !== 2)
      throw Error("Invalid source list");
    reviewed = review.items;
  } catch {
    block("兩份固定來源的 local-reviewed.json 缺失或格式不符。");
    return;
  }
  for (const item of reviewed) {
    try {
      const pointer = db.published?.[digest(item.licenseNo)];
      const leaflet = pointer && db.leaflets?.[pointer.leafletId];
      if (
        !leaflet ||
        leaflet.id !== pointer.leafletId ||
        leaflet.status !== "published" ||
        leaflet.licenseNo !== item.licenseNo ||
        leaflet.version !== item.version ||
        leaflet.sha256 !== item.sha256 ||
        pointer.version !== item.version ||
        !officialUrl(leaflet.sourceUrl) ||
        !catalog.some((d) => d.licenseNo === item.licenseNo) ||
        !Array.isArray(leaflet.chunks) ||
        !leaflet.chunks.length ||
        leaflet.chunks.some(
          (c) =>
            c.licenseNo !== item.licenseNo ||
            c.version !== item.version ||
            !c.text?.trim(),
        )
      )
        throw Error("Source mismatch");
      const pdf = await readFile(blobFile(leaflet.storagePath));
      if (
        pdf.subarray(0, 5).toString() !== "%PDF-" ||
        digest(pdf) !== item.sha256
      )
        throw Error("Stored PDF mismatch");
      ok(`${item.licenseNo}：發布指標、版本、官方 PDF 及 SHA-256 一致`);
    } catch {
      block(
        `${item.licenseNo}：來源、發布指標、版本或 PDF 缺失／不符；請執行 npm run prepare:local:demo 後重查。`,
      );
    }
  }
  const learning = Object.values(db.learning || {});
  const stale = learning.filter(
    (row) => row?.groundingVersion !== GROUNDING_VERSION,
  ).length;
  if (stale)
    warn(
      `${stale} 筆舊衛教／學習內容需重新產生，勿當作目前版本的展示內容；本工具不修改或顯示內容。`,
    );
  else ok(`衛教／學習版本檢查：${learning.length} 筆，沒有舊版本`);
  if (process.argv.includes("--require-ready")) {
    const ready = learning.filter(
      (row) =>
        row.groundingVersion === GROUNDING_VERSION &&
        row.result?.status === "supported" &&
        row.result.claims?.length &&
        row.result.quiz?.length,
    );
    if (stale || ready.length < reviewed.length)
      block(
        "研討會展示需備妥兩份目前版本的說明與可作答測驗，請先完成新版本流程驗收。",
      );
    else ok(`${ready.length} 份展示說明與測驗已保存，可在 AI 暫時無法回應時繼續展示。`);
  }
}

try {
  await main();
} catch {
  block("檢查未完成：本機資料格式異常，請檢查準備狀態後重跑；未輸出私人資料。");
}
console.log(
  blockers
    ? `結果：${blockers} 項阻擋，請修正後再展示。`
    : "結果：本機必要檔案與來源就緒；請依警示安排 AI 展示。",
);
process.exitCode = blockers ? 1 : 0;
