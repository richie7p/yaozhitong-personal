import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { needsHtmlOutlineInspection, parseHtmlMode, parseSourceFormat, sourceFormatSelected } from "../tools/prepare-tfda-sources";
import { HTML_RECTANGULAR_OUTLINE_SERIALIZATION } from "../tools/tfda-candidate-verification";

const run = promisify(execFile), hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const now = new Date().toISOString();
  const root = await mkdtemp(join(tmpdir(), "tfda-source-format-")), inventory = join(root, "inventory"), corpus = join(root, "corpus"), output = join(root, "output");
  for (const dir of [inventory, join(corpus, "records"), join(corpus, "objects"), join(corpus, "extractions")]) await mkdir(dir, { recursive: true });
  const put = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
  for (const id of [36, 39]) { await put(join(inventory, `info${id}.json`), []); await put(join(inventory, `info${id}.evidence.json`), { retrievedAt: now }); }
  const products: any[] = [];
  async function product(code: string, types: string[], htmlBody?: string) {
    const fullLicense = `衛署藥製字第${code}號`, sourceUrls = types.map((_, i) => htmlBody !== undefined ? `https://mcp.fda.gov.tw/exportpdf/${fullLicense}` : `https://info.fda.gov.tw/synthetic-${code}-${i}`);
    const catalog = { 許可證字號: fullLicense, 中文品名: "合成測試製劑", 英文品名: "Synthetic test", 藥品類別: "合成處方藥", 劑型: "錠劑", 製造商名稱: "合成廠", 有效日期: "2030/01/01", 註銷狀態: "" };
    products.push({ fullLicense, catalogRows: [{ record: catalog }], indexRows: [{ record: { ...catalog, 仿單圖檔連結: sourceUrls.join(";") } }], sourceUrlsExactOrder: sourceUrls });
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "missing") continue;
      const actualHtml = htmlBody === undefined ? "<html>synthetic</html>" : `<html><body>${Object.entries({ 中文品名: catalog.中文品名, 英文品名: catalog.英文品名, 許可證號: fullLicense, 藥品類別: catalog.藥品類別 }).map(([label, value]) => `<div class="page_name"><label>${label}</label><span>${value}</span></div>`).join("")}<div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">5 警語及注意事項</span></div><div class="toggle-inner">${htmlBody}</div></div></div></body></html>`;
      const sourceUrl = sourceUrls[i], type = types[i], raw = Buffer.from(type === "html" ? actualHtml : "%PDF-SYNTHETIC-NOT-PARSED"), sourceBlobSha256 = hash(raw), key = hash(sourceUrl), extractionPath = `extractions/${key}.json`;
      // PDF primaries deliberately have no raw file. HTML-only must defer before any read or parse.
      if (type === "html") await writeFile(join(corpus, "objects", key + ".html"), raw);
      await put(join(corpus, "records", key + ".json"), { sourceUrl, requestedUrl: sourceUrl, finalUrl: sourceUrl, urlHash: key, sourceBlobSha256, sourceType: type, blobPath: `objects/${key}.${type}`, extractionPath, fetchedAt: now, bytes: raw.length, mediaType: type === "html" ? "text/html" : "application/pdf" });
      if (type === "html") await put(join(corpus, extractionPath), { sourceBlobSha256, urlHash: key, parserVersion: "tfda-complete-dom-v4", identityFields: { 中文品名: catalog.中文品名, 英文品名: catalog.英文品名, 許可證號: fullLicense, 藥品類別: catalog.藥品類別 }, normalizedSectionText: "合成適應症及警語，僅供程式測試。", fullDomConserved: true, hasUnverifiedNonTextContent: false, simpleTablesConserved: true, complexTableCount: 0, unaccountedMainBlockCount: 0, allMainBlocksAccounted: true, tableSerializationVersion: "tfda-simple-table-literal-v1", sections: [{ title: "合成節" }], nonTextImages: [] });
      if (type === "html" && htmlBody !== undefined) {
        const result = await run(process.env.TFDA_TEST_PYTHON || "python", ["-X", "utf8", resolve("tools/fetch-tfda-sources.py"), "--inspect-html-internal", join(corpus, "objects", key + ".html"), sourceUrl], { windowsHide: true, encoding: "utf8", maxBuffer: 1000000 });
        await put(join(corpus, extractionPath), { ...JSON.parse(result.stdout), sourceBlobSha256, urlHash: key });
      }
    }
    return { fullLicense, sourceUrls };
  }
  async function prepare(format?: string) {
    await writeFile(join(inventory, "active-candidates.ndjson"), products.map(value => JSON.stringify(value)).join("\n") + "\n");
    const args = ["--import", "tsx", resolve("tools/prepare-tfda-sources.ts"), "--inventory", inventory, "--corpus", corpus, "--output", output, "--python", process.env.TFDA_TEST_PYTHON || "python"];
    if (format !== undefined) args.push("--source-format", format);
    await run(process.execPath, args, { cwd: process.cwd(), timeout: 30000, maxBuffer: 1000000, windowsHide: true });
    return JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
  }
  async function prepared(license: string) { const record = JSON.parse(await readFile(join(output, "assessments", hash(license) + ".json"), "utf8")); return { record, input: JSON.parse(await readFile(record.candidateInputPath, "utf8")) }; }
  return { root, corpus, output, product, prepare, prepared };
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
  it("selects complete simple and explicit rectangular outline proofs within the same default batch while keeping images held", async () => {
    const f = await fixture(), text = "本段為合成測試之適應症及警語，非真實用藥建議，所有來源文字應完整保存。".repeat(5);
    try {
      const simple = await f.product("001238", ["html"], `<p>${text}</p>`);
      const outline = await f.product("001239", ["html"], `<table><tr><td>5.1</td><td>${text}</td></tr><tr><td></td><td><table><tr><td>合成條件</td><td>合成內容</td></tr><tr><td>條件甲</td><td>不得略過</td></tr></table></td></tr></table>`);
      const image = await f.product("001240", ["html"], `<table><tr><td>5.1</td><td>${text}<img src="warning.png"></td></tr></table>`);
      const summary = await f.prepare("html");
      expect(summary.htmlMode).toBe("auto");
      expect(summary.selectedHtmlModes).toEqual({ legacy: 1, "numbered-outline-rectangular-v1": 2 });
      expect(summary.eligible, JSON.stringify(summary)).toBe(2);
      const simpleResult = await f.prepared(simple.fullLicense), outlineResult = await f.prepared(outline.fullLicense), imageResult = await f.prepared(image.fullLicense);
      expect(simpleResult.record.assessment.eligibleTechnical).toBe(true);
      expect(simpleResult.input.htmlEvidence).not.toHaveProperty("tableSerializationVersion");
      expect(outlineResult.record.assessment.eligibleTechnical).toBe(true);
      expect(outlineResult.input.htmlEvidence.tableSerializationVersion).toBe(HTML_RECTANGULAR_OUTLINE_SERIALIZATION);
      expect(outlineResult.input.pages[0].text).toContain("條件甲\t不得略過");
      expect(imageResult.record.assessment.eligibleTechnical).toBe(false);
      expect(imageResult.record.assessment.reasons).toContain("large_unverified_image");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("keeps every existing simple-document condition mandatory before auto selects the simple proof", () => {
    const complete = { parserVersion: "tfda-complete-dom-v4", tableSerializationVersion: "tfda-simple-table-literal-v1", fullDomConserved: true, hasUnverifiedNonTextContent: false, simpleTablesConserved: true, complexTableCount: 0, unaccountedMainBlockCount: 0, allMainBlocksAccounted: true };
    expect(parseHtmlMode(undefined)).toBe("auto"); expect(parseHtmlMode("legacy")).toBe("legacy");
    expect(needsHtmlOutlineInspection(complete)).toBe(false);
    expect(needsHtmlOutlineInspection(null)).toBe(true);
    for (const key of Object.keys(complete)) { const incomplete: any = { ...complete }; delete incomplete[key]; expect(needsHtmlOutlineInspection(incomplete)).toBe(true); }
    for (const value of ["", "AUTO", "unchecked"]) expect(() => parseHtmlMode(value)).toThrow("invalid_html_mode");
  });
  it("leaves missing or incorrectly bound cached evidence awaiting re-extraction without crashing or creating a publication", async () => {
    const f = await fixture();
    try {
      const missing = await f.product("001241", ["html"]), changed = await f.product("001242", ["html"]);
      await rm(join(f.corpus, "extractions", hash(missing.sourceUrls[0]) + ".json"));
      const path = join(f.corpus, "extractions", hash(changed.sourceUrls[0]) + ".json");
      const extraction = JSON.parse(await readFile(path, "utf8")); extraction.sourceBlobSha256 = "f".repeat(64);
      await writeFile(path, JSON.stringify(extraction));
      const summary = await f.prepare("html");
      expect(summary.assessed).toBe(0); expect(summary.counts.awaiting_current_extraction).toBe(2);
      expect(summary.manifests).toEqual([]); expect(summary.selectedHtmlModes).toEqual({});
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
