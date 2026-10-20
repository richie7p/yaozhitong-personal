import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Leaflet, Chunk } from "../shared/schema.js";
import { hash } from "./domain.js";
import { fail } from "./config.js";
import path from "node:path";
import {
  SOURCE_CHUNKING_VERSION,
  SOURCE_PAGE_CHAR_LIMIT,
} from "../shared/source.js";

export function canonicalPageChunk(
  leafletId: string,
  licenseNo: string,
  version: string,
  page: number,
  text: string,
): Chunk | null {
  if (!Number.isSafeInteger(page) || page < 1)
    return fail("invalid_source_page", "仿單頁碼無法確認。", 400);
  if (text.length > SOURCE_PAGE_CHAR_LIMIT)
    return fail(
      "leaflet_page_too_large",
      "單頁仿單超出完整來源上限，請先核對版面；系統不會截斷警語。",
      400,
    );
  if (!text.trim()) return null;
  return {
    id: `${leafletId.slice(0, 16)}-${page}-0-${SOURCE_CHUNKING_VERSION}-${hash(text).slice(0, 16)}`,
    licenseNo,
    version,
    page,
    start: 0,
    text,
  };
}
export async function extractLeaflet(
  bytes: Buffer,
  licenseNo: string,
  sourceUrl: string,
): Promise<Leaflet> {
  const url = new URL(sourceUrl);
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "fda.gov.tw" || url.hostname.endsWith(".fda.gov.tw"))
  )
    return fail("invalid_source", "請使用食藥署 HTTPS 官方仿單網址。");
  if (bytes.length > 15_000_000 || bytes.subarray(0, 5).toString() !== "%PDF-")
    return fail("invalid_pdf", "請上傳 15 MB 以內的 PDF 仿單。");
  const sha256 = hash(bytes),
    version = sha256.slice(0, 16),
    id = hash(licenseNo + "|" + sha256);
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    cMapUrl:
      path.resolve("node_modules/pdfjs-dist/cmaps").replace(/\\/g, "/") + "/",
    cMapPacked: true,
    standardFontDataUrl:
      path
        .resolve("node_modules/pdfjs-dist/standard_fonts")
        .replace(/\\/g, "/") + "/",
    verbosity: 0,
  });
  const pdf = await task.promise;
  const chunks: Chunk[] = [];
  try {
    if (pdf.numPages > 200)
      return fail("leaflet_too_large", "仿單超過 200 頁，請分段整理。");
    for (let p = 1; p <= Math.min(pdf.numPages, 200); p++) {
      const page = await pdf.getPage(p);
      const items = await page.getTextContent();
      const text = items.items
        .map((x) =>
          "str" in x ? x.str + ("hasEOL" in x && x.hasEOL ? "\n" : " ") : "",
        )
        .join("")
        .trim();
      const chunk = canonicalPageChunk(id, licenseNo, version, p, text);
      if (chunk) chunks.push(chunk);
    }
  } finally {
    await task.destroy();
  }
  if (Buffer.byteLength(JSON.stringify(chunks)) > 800000)
    return fail("leaflet_too_large", "仿單文字超出單份匯入上限，請分段整理。");
  return {
    id,
    licenseNo,
    version,
    sourceUrl,
    sha256,
    storagePath: `leaflets/${id}.pdf`,
    chunks,
    status: "draft",
    checkedBy: null,
    checkedAt: null,
  };
}
