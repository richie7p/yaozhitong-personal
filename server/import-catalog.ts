import { unzipSync } from "fflate";
import type { Drug } from "../shared/schema.js";
import { hash, now } from "./domain.js";
import { Blobs } from "./blobs.js";
import type { Store } from "./store.js";
export const CATALOG_SOURCE =
  "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=36&logType=5";
export async function refreshCatalog(
  store: Store,
  blobs = new Blobs(),
  provided?: Buffer,
) {
  const response = provided
    ? null
    : await fetch(CATALOG_SOURCE, { signal: AbortSignal.timeout(90000) });
  if (response && !response.ok) throw Error("Official catalog download failed");
  let bytes = provided || Buffer.from(await response!.arrayBuffer());
  if (bytes.length > 100_000_000)
    throw Error("Catalog exceeds import size limit");
  if (bytes[0] === 80 && bytes[1] === 75) {
    const files = unzipSync(bytes);
    const key = Object.keys(files).find((k) => k.endsWith(".json"));
    if (!key) throw Error("Official archive has no JSON");
    bytes = Buffer.from(files[key]);
  }
  const raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(raw) || !raw.length)
    throw Error("Invalid catalog records");
  const mapped: Drug[] = raw
    .map((r) => ({
      licenseNo: String(r["許可證字號"] || r.licenseNo || ""),
      nameZh: String(r["中文品名"] || r.nameZh || ""),
      nameEn: String(r["英文品名"] || r.nameEn || ""),
      strength: String(
        r.strength ||
          String(r["中文品名"] || "")
            .normalize("NFKC")
            .match(
              /[\d.]+(?:\/[\d.]+)*\s*(?:mg|mcg|g|ml|毫克|微克|公克|毫升|%)/i,
            )?.[0] ||
          "",
      ),
      form: String(r["劑型"] || r.form || ""),
      ingredients: Array.isArray(r.ingredients)
        ? r.ingredients
        : String(r["主成分略述"] || "")
            .split(/;;|;|；/)
            .map((x) => x.trim())
            .filter(Boolean),
      revoked:
        r.revoked === true || String(r["註銷狀態"] || "").includes("已註銷"),
    }))
    .filter((r) => r.licenseNo && r.nameZh);
  const rows = [...new Map(mapped.map((r) => [r.licenseNo, r])).values()];
  const encoded = Buffer.from(JSON.stringify(rows));
  const version = hash(encoded).slice(0, 16),
    path = `catalog/${version}.json`;
  await blobs.put(path, encoded, "application/json");
  const metadata = {
    version,
    path,
    count: rows.length,
    source: CATALOG_SOURCE,
    updatedAt: now(),
  };
  await store.set("settings", "catalog", metadata);
  return metadata;
}
