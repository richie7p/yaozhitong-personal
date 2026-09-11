import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Leaflet, Chunk } from "../shared/schema.js";
import { hash } from "./domain.js";
import { fail } from "./config.js";
import path from "node:path";
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
      for (let start = 0; start < text.length; start += 1000) {
        const part = text.slice(start, start + 1000);
        if (part.trim().length < 8) continue;
        chunks.push({
          id: `${id.slice(0, 16)}-${p}-${start}`,
          licenseNo,
          version,
          page: p,
          start,
          text: part,
        });
      }
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
