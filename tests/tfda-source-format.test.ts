import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSourceFormat, sourceFormatSelected } from "../tools/prepare-tfda-sources";

const run = promisify(execFile), hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tfda-source-format-")), inventory = join(root, "inventory"), corpus = join(root, "corpus"), output = join(root, "output");
  for (const dir of [inventory, join(corpus, "records"), join(corpus, "objects"), join(corpus, "extractions")]) await mkdir(dir, { recursive: true });
  const put = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
  for (const id of [36, 39]) { await put(join(inventory, `info${id}.json`), []); await put(join(inventory, `info${id}.evidence.json`), { retrievedAt: "2026-10-22T00:00:00Z" }); }
  const products: any[] = [];
  async function product(code: string, types: string[]) {
    const fullLicense = `衛署藥製字第${code}號`, sourceUrls = types.map((_, i) => `https://info.fda.gov.tw/synthetic-${code}-${i}`);
    const catalog = { 許可證字號: fullLicense, 中文品名: "合成測試製劑", 英文品名: "Synthetic test", 藥品類別: "合成處方藥", 劑型: "錠劑", 製造商名稱: "合成廠", 有效日期: "2030/01/01", 註銷狀態: "" };
    products.push({ fullLicense, catalogRows: [{ record: catalog }], indexRows: [{ record: { ...catalog, 仿單圖檔連結: sourceUrls.join(";") } }], sourceUrlsExactOrder: sourceUrls });
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "missing") continue;
      const sourceUrl = sourceUrls[i], type = types[i], raw = Buffer.from(type === "html" ? "<html>synthetic</html>" : "%PDF-SYNTHETIC-NOT-PARSED"), sourceBlobSha256 = hash(raw), key = hash(sourceUrl), extractionPath = `extractions/${key}.json`;
      // PDF primaries deliberately have no raw file. HTML-only must defer before any read or parse.
      if (type === "html") await writeFile(join(corpus, "objects", key + ".html"), raw);
      await put(join(corpus, "records", key + ".json"), { sourceUrl, requestedUrl: sourceUrl, finalUrl: sourceUrl, urlHash: key, sourceBlobSha256, sourceType: type, blobPath: `objects/${key}.${type}`, extractionPath, fetchedAt: "2026-10-22T00:00:00Z", bytes: raw.length, mediaType: type === "html" ? "text/html" : "application/pdf" });
      if (type === "html") await put(join(corpus, extractionPath), { sourceBlobSha256, urlHash: key, parserVersion: "tfda-complete-dom-v4", identityFields: { 中文品名: catalog.中文品名, 英文品名: catalog.英文品名, 許可證號: fullLicense, 藥品類別: catalog.藥品類別 }, normalizedSectionText: "合成適應症及警語，僅供程式測試。", fullDomConserved: true, hasUnverifiedNonTextContent: false, simpleTablesConserved: true, complexTableCount: 0, unaccountedMainBlockCount: 0, allMainBlocksAccounted: true, tableSerializationVersion: "tfda-simple-table-literal-v1", sections: [{ title: "合成節" }], nonTextImages: [] });
    }
    return { fullLicense, sourceUrls };
  }
  async function prepare(format?: string) {
    await writeFile(join(inventory, "active-candidates.ndjson"), products.map(value => JSON.stringify(value)).join("\n") + "\n");
    const args = ["--import", "tsx", resolve("tools/prepare-tfda-sources.ts"), "--inventory", inventory, "--corpus", corpus, "--output", output];
    if (format !== undefined) args.push("--source-format", format);
    await run(process.execPath, args, { cwd: process.cwd(), timeout: 30000, maxBuffer: 1000000, windowsHide: true });
    return JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
  }
  async function prepared(license: string) { const record = JSON.parse(await readFile(join(output, "assessments", hash(license) + ".json"), "utf8")); return { record, input: JSON.parse(await readFile(record.candidateInputPath, "utf8")) }; }
  return { root, output, product, prepare, prepared };
}

describe("preparation source format selection", () => {
  it("defaults to all with the original HTML preparation behavior", async () => {
    expect(parseSourceFormat(undefined)).toBe("all");
    for (const type of ["html", "pdf", "unknown"]) expect(sourceFormatSelected(parseSourceFormat(undefined), type)).toBe(true);
    const f = await fixture();
    try { await f.product("001234", ["html"]); const summary = await f.prepare(); expect(summary.sourceFormat).toBe("all"); expect(summary.assessed).toBe(1); expect(summary.selectedSourceCounts).toEqual({ html: 1 }); expect(summary.deferredSourceCounts).toEqual({}); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("HTML selection defers the original PDF primary before touching its missing raw or starting any PDF parse", async () => {
    const f = await fixture();
    try { await f.product("001235", ["pdf", "html"]); const summary = await f.prepare("html"); expect(summary.assessed).toBe(0); expect(summary.sourceFormat).toBe("html"); expect(summary.deferredSourceCounts).toEqual({ pdf: 1 }); expect(summary.counts.deferred_by_source_format).toBe(1); expect(summary.selectedSourceCounts).toEqual({}); expect(summary.manifests).toEqual([]); expect(await readdir(f.output)).not.toContain("pdfjs"); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("keeps every mixed-format artifact and missing full branch after selecting the original HTML primary", async () => {
    const f = await fixture();
    try {
      const complete = await f.product("001236", ["html", "pdf"]), incomplete = await f.product("001237", ["html", "pdf", "missing"]);
      const summary = await f.prepare("html"); expect(summary.assessed).toBe(2); expect(summary.selectedSourceCounts).toEqual({ html: 2 });
      for (const product of [complete, incomplete]) { const { record, input } = await f.prepared(product.fullLicense); expect(input.fetched.requestedUrl).toBe(product.sourceUrls[0]); expect(input.sameSourceArtifacts).toHaveLength(1); expect(input.sameSourceArtifacts[0].requestedUrl).toBe(product.sourceUrls[1]); expect(input.sameSourceArtifacts[0].contentSignature).toBe("pdf"); expect(input.indexRows[0].urls).toEqual(product.sourceUrls); expect(record.branchesReady).toBe(product === complete); }
      expect(await readdir(f.output)).not.toContain("pdfjs");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects unsupported format values before reading source paths", async () => {
    for (const value of ["HTML", "", "json", "html,pdf"]) expect(() => parseSourceFormat(value)).toThrow("invalid_source_format");
    await expect(run(process.execPath, ["--import", "tsx", resolve("tools/prepare-tfda-sources.ts"), "--inventory", "nonexistent", "--corpus", "nonexistent", "--output", "nonexistent", "--source-format", "json"], { timeout: 10000, windowsHide: true })).rejects.toMatchObject({ stderr: expect.stringContaining("invalid_source_format") });
  });
});
