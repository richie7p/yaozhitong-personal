import { unzipSync } from "fflate";
import type { Drug } from "../shared/schema.js";
import { hash, now } from "./domain.js";
import { Blobs } from "./blobs.js";
import type { Store } from "./store.js";
export const CATALOG_SOURCE =
  "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=36&logType=5";

function titleStrength(title: string): string {
  const text = title.normalize("NFKC");
  if (text.includes("複方")) return "";
  const number = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const unit = "(?:mcg|mg|ug|μg|g|ml|毫克|微克|公克|毫升|公絲|克)";
  const denominator = "(?:ml|g|毫升|公克|克)";
  const percentBasis = "(?:\\s*(?:\\([wv]\\s*/\\s*[wv]\\)|[wv]\\s*/\\s*[wv]))?";
  const expression = new RegExp(
    `(?<![a-z0-9.,/])${number}\\s*(?:%${percentBasis}|${unit}(?:\\s*/\\s*(?:${number}\\s*)?${denominator})?)(?![a-z0-9.])`,
    "gi",
  );
  const matches = [...text.matchAll(expression)];
  // A partial concentration or one component of a combination is misleading.
  if (matches.length !== 1) return "";
  const match = matches[0];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index! + match[0].length);
  if (
    /\d\s*(?:[/+、&~～–—-]|加|及|與|至)\s*$/.test(before) ||
    /^\s*\//.test(after)
  )
    return "";
  return match[0];
}

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
    .map((r) => {
      const ingredients = Array.isArray(r.ingredients)
        ? r.ingredients
        : String(r["主成分略述"] || "")
            .split(/;;|;|；/)
            .map((x) => x.trim())
            .filter(Boolean);
      return {
        licenseNo: String(r["許可證字號"] || r.licenseNo || ""),
        nameZh: String(r["中文品名"] || r.nameZh || ""),
        nameEn: String(r["英文品名"] || r.nameEn || ""),
        strength: String(
          r.strength ||
            (ingredients.length > 1
              ? ""
              : titleStrength(String(r["中文品名"] || ""))),
        ),
        form: String(r["劑型"] || r.form || ""),
        ingredients,
        revoked:
          r.revoked === true || String(r["註銷狀態"] || "").includes("已註銷"),
      };
    })
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
