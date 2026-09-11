import { readFile, writeFile, mkdir } from "node:fs/promises";
import { unzipSync } from "fflate";
import { makeStore } from "../server/store.js";
import { Domain } from "../server/domain.js";
import { extractLeaflet } from "../server/leaflets.js";
const count = Number(process.argv[2] || 30);
const source =
  "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=39&logType=5";
await mkdir(".local/reports", { recursive: true });
let index: any[];
try {
  index = JSON.parse(await readFile(".local/leaflet-index.json", "utf8"));
} catch {
  const r = await fetch(source, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw Error("TFDA index unavailable");
  const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
  index = JSON.parse(
    Buffer.from(Object.values(files)[0])
      .toString("utf8")
      .replace(/^\uFEFF/, ""),
  );
  await writeFile(".local/leaflet-index.json", JSON.stringify(index));
}
const d = new Domain(await makeStore());
const catalog = await d.catalog.all();
const byLicense = new Map(
  catalog
    .filter((r) => !r.revoked && /錠|膠囊/.test(r.form))
    .map((r) => [r.licenseNo, r]),
);
const candidates = index.filter(
  (r) =>
    byLicense.has(r["許可證字號"]) && r["仿單圖檔連結"]?.startsWith("https://"),
);
const report: any[] = [];
let success = 0;
for (const r of candidates) {
  if (success >= count || report.length >= count * 6) break;
  const licenseNo = r["許可證字號"];
  const urls = r["仿單圖檔連結"].match(/https:\/\/[^\s;]+/g) || [];
  const sourceUrl = urls[0];
  if (!sourceUrl) continue;
  try {
    const url = new URL(sourceUrl);
    if (!url.hostname.endsWith(".fda.gov.tw")) continue;
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error("download_http_" + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    const l = await extractLeaflet(bytes, licenseNo, sourceUrl);
    const text = l.chunks.map((x) => x.text).join("");
    if (
      text.length < 300 ||
      !/[\u4e00-\u9fff]/.test(text) ||
      text.includes("\ufffd")
    )
      throw Error("text_quality_requires_manual_extraction");
    await d.blobs.put(l.storagePath, bytes, "application/pdf");
    const existing = await d.store.get("leaflets", l.id);
    if (!existing) await d.store.set("leaflets", l.id, l);
    success++;
    report.push({
      licenseNo,
      name: r["中文品名"],
      sourceUrl,
      id: l.id,
      version: l.version,
      characters: text.length,
      chunks: l.chunks.length,
      pages: Math.max(...l.chunks.map((c) => c.page)),
      status: existing?.status || "draft",
      checks: {
        officialIndexMatch: true,
        pdfMagic: true,
        hashRecorded: true,
        hasChineseText: true,
        noReplacementCharacters: true,
      },
      review: "pending_source_text_review",
    });
    console.log(
      `${success}/${count} ${licenseNo} ${r["中文品名"]} (${text.length} chars)`,
    );
  } catch (e: any) {
    report.push({
      licenseNo,
      name: r["中文品名"],
      sourceUrl,
      status: "failed",
      reason: e.code || e.message,
    });
  }
}
await writeFile(
  ".local/reports/leaflet-collection.json",
  JSON.stringify(
    { source, collected: success, requested: count, items: report },
    null,
    2,
  ),
);
console.log(JSON.stringify({ collected: success, draftsRequireReview: true }));
if (success < count) process.exitCode = 1;
