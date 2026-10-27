import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCurrentPaperEquivalence, equivalentFetchedFromReceipt, type CurrentPaperEquivalenceBinding } from "../tools/tfda-current-paper-equivalence.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyParentPaperEquivalentSources, verifyParentPaperSource } from "../tools/tfda-parent-paper-verification.js";
import type { TfdaSourceInput } from "../tools/tfda-source-core.js";
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const license = "衛署藥製字第017610號", now = Date.parse("2026-10-22T15:00:00Z"), stamp = "2026-10-22T02:24:00Z";
const urls = ["https://mcp.fda.gov.tw/fileshow/first", "https://mcp.fda.gov.tw/fileshow/second"];
function fixture() {
  const raw = Buffer.from("%PDF-1.7\nidentical complete original bytes"), parentRaw = Buffer.from("<html>complete parent</html>");
  const parentFetched = { requestedUrl: "https://mcp.fda.gov.tw/exportpdf/" + license, finalUrl: "https://mcp.fda.gov.tw/im_detail_1/test", redirectChain: ["https://mcp.fda.gov.tw/exportpdf/" + license, "https://mcp.fda.gov.tw/im_detail_1/test"],
    retrievedAt: stamp, sha256: hash(parentRaw), bytes: parentRaw.length, mediaType: "text/html", contentSignature: "html" as const };
  const report = { schema: "tfda-parent-paper-association/v2", parserVersion: "tfda-parent-paper-strict-v2", schemaVersion: 2,
    associationValid: false, invalidReasons: ["current_paper_url_count_not_one"], scope: "single_current_paper_excluding_explicit_history", allScopedAnchorsAccounted: true,
    currentPopupCount: 1, historicalPopupCount: 1, currentOtherUrls: [], orderedScopedResources: [], currentPaperUrls: [...urls], historicalPaperUrls: ["https://mcp.fda.gov.tw/fileshow/old"],
    excludedHistoricalPaperUrls: ["https://mcp.fda.gov.tw/fileshow/old"], historicalOtherUrls: [], excludedHistoricalElectronicUrls: [], orderedPopups: [{ role: "current" }, { role: "historical" }],
    orderedAnchors: [{ role: "current", resolvedUrl: urls[0] }, { role: "current", resolvedUrl: urls[1] }], ambiguousIdentityFields: {}, rawSha256: hash(parentRaw), rawBytes: parentRaw.length, sourceUrl: parentFetched.finalUrl };
  const sources: CurrentPaperEquivalenceBinding[] = urls.map(url => {
    const roles = [{ fullLicense: license, licenseState: "active", discoveryType: "current_paper", sourceAttribute: "paperLinks", literalUrl: url,
      parentSourceUrl: parentFetched.requestedUrl, parentFinalUrl: parentFetched.finalUrl, parentRawSha256: parentFetched.sha256,
      parentFetchedAt: parentFetched.retrievedAt, parentUrlHash: hash(parentFetched.requestedUrl) }];
    const result = { requestedUrl: url, sourceUrl: url, finalUrl: url, httpStatus: 200, status: "downloaded_archive_raw", sourceType: "pdf", redirects: [],
      fetchedAt: stamp, sourceBlobSha256: hash(raw), bytes: raw.length, contentType: "application/pdf", parents: roles };
    const envelope = { job: { sourceUrl: url, parents: roles, cohorts: ["current_paper"] }, result };
    const metadataBytes = Buffer.from(JSON.stringify(envelope));
    return { source: { fullLicense: license, rawSourcePath: url, rawSourceSha256: hash(raw), rawMetadataPath: url + ".json", rawMetadataSha256: hash(metadataBytes), fetched: equivalentFetchedFromReceipt(result), allArchiveRoles: roles }, rawBytes: Buffer.from(raw), metadataBytes };
  });
  return { licenseNo: license, parentFetched, parentDomReport: report, sources, representativeFetched: sources[0].source.fetched, now };
}
function mutateEnvelope(f: ReturnType<typeof fixture>, index: number, change: (v: any) => void) {
  const entry = f.sources[index], envelope = JSON.parse(Buffer.from(entry.metadataBytes).toString()); change(envelope);
  entry.metadataBytes = Buffer.from(JSON.stringify(envelope)); entry.source.rawMetadataSha256 = hash(entry.metadataBytes);
}
describe("complete current-paper byte-equivalence proof", () => {
  it("retains every ordered alias and native role; equality establishes no cross-license source", () => {
    const f = fixture(), proof = verifyCurrentPaperEquivalence(f);
    expect(proof.orderedCurrentUrls).toEqual(urls); expect(proof.representativeUrl).toBe(urls[0]);
    expect(proof.artifacts).toHaveLength(2); expect(proof.artifacts[1].allArchiveRoles).toEqual(f.sources[1].source.allArchiveRoles);
    expect(proof.parentDomInspectionSha256).toBe(hash(JSON.stringify(f.parentDomReport)));
  });
  it.each([
    ["missing current alias", (f: ReturnType<typeof fixture>) => f.sources.pop()],
    ["extra current alias", (f: ReturnType<typeof fixture>) => f.sources.push(f.sources[0])],
    ["reordered aliases", (f: ReturnType<typeof fixture>) => f.sources.reverse()],
    ["lexical/newest representative", (f: ReturnType<typeof fixture>) => { f.representativeFetched = f.sources[1].source.fetched; }],
    ["different bytes with matching metadata claim", (f: ReturnType<typeof fixture>) => { f.sources[1].rawBytes = Buffer.from("%PDF-1.7\nDIFFERENT"); }],
    ["different actual bytes even with recomputed receipt", (f: ReturnType<typeof fixture>) => {
      const e = f.sources[1]; e.rawBytes = Buffer.from("%PDF-1.7\nDIFFERENT"); e.source.rawSourceSha256 = hash(e.rawBytes); e.source.fetched.sha256 = hash(e.rawBytes); e.source.fetched.bytes = e.rawBytes.length;
      mutateEnvelope(f, 1, v => { v.result.sourceBlobSha256 = hash(e.rawBytes); v.result.bytes = e.rawBytes.length; }); }],
    ["empty PDF", (f: ReturnType<typeof fixture>) => { f.sources[1].rawBytes = Buffer.alloc(0); }],
    ["unhashed metadata change", (f: ReturnType<typeof fixture>) => { f.sources[1].metadataBytes = Buffer.from("{}"); }],
    ["cross license manifest", (f: ReturnType<typeof fixture>) => { f.sources[1].source.fullLicense = "衛署藥製字第017611號"; }],
    ["freshness renewed only in manifest", (f: ReturnType<typeof fixture>) => { f.sources[1].source.fetched.retrievedAt = "2026-10-22T14:59:00Z"; }],
    ["expired original receipt", (f: ReturnType<typeof fixture>) => { f.now += 86_400_000; }],
    ["parent raw mismatch", (f: ReturnType<typeof fixture>) => { f.parentDomReport.rawSha256 = "f".repeat(64); }],
    ["another DOM error", (f: ReturnType<typeof fixture>) => { f.parentDomReport.invalidReasons.push("unknown_anchor"); }],
    ["unsupported branch", (f: ReturnType<typeof fixture>) => { f.parentDomReport.currentOtherUrls.push("https://mcp.fda.gov.tw/other" as never); }],
    ["current historical collision", (f: ReturnType<typeof fixture>) => { f.parentDomReport.historicalPaperUrls = [urls[0]]; f.parentDomReport.excludedHistoricalPaperUrls = [urls[0]]; }],
    ["percent-encoded historical collision", (f: ReturnType<typeof fixture>) => { const old = urls[0].replace("first", "%66irst"); f.parentDomReport.historicalPaperUrls = [old]; f.parentDomReport.excludedHistoricalPaperUrls = [old]; }],
    ["placeholder", (f: ReturnType<typeof fixture>) => { f.parentDomReport.currentPaperUrls[1] = "https://mcp.fda.gov.tw/insert/pdfcase"; }],
    ["percent-encoded placeholder", (f: ReturnType<typeof fixture>) => { f.parentDomReport.currentPaperUrls[1] = "https://mcp.fda.gov.tw/insert/%70dfcase"; }],
    ["malformed percent path", (f: ReturnType<typeof fixture>) => { f.parentDomReport.currentPaperUrls[1] = "https://mcp.fda.gov.tw/fileshow/%QQ"; }],
    ["missing original envelope", (f: ReturnType<typeof fixture>) => { mutateEnvelope(f, 1, v => { delete v.result; }); }],
    ["roles dropped", (f: ReturnType<typeof fixture>) => { f.sources[1].source.allArchiveRoles = []; }],
    ["historical native role", (f: ReturnType<typeof fixture>) => { mutateEnvelope(f, 1, v => { v.job.parents[0].discoveryType = "historical_paper"; v.result.parents[0].discoveryType = "historical_paper"; }); }],
  ])("rejects %s", (_name, change) => { const f = fixture(); (change as (f: ReturnType<typeof fixture>) => void)(f); expect(() => verifyCurrentPaperEquivalence(f)).toThrow(); });
  it("rejects cross-license native roles even when every manifest and metadata SHA is recomputed", () => {
    const f = fixture(); mutateEnvelope(f, 1, v => { v.job.parents[0].fullLicense = "衛署藥製字第017611號"; v.result.parents[0].fullLicense = "衛署藥製字第017611號"; });
    f.sources[1].source.allArchiveRoles = JSON.parse(Buffer.from(f.sources[1].metadataBytes).toString()).job.parents;
    expect(() => verifyCurrentPaperEquivalence(f)).toThrow("equivalent_source_role_cross_license_or_parent_mismatch");
  });
  it("requires the original full contiguous redirect receipt", () => {
    const f = fixture(); mutateEnvelope(f, 1, v => { v.result.finalUrl = "https://mcp.fda.gov.tw/other"; });
    expect(() => verifyCurrentPaperEquivalence(f)).toThrow("equivalent_source_missing_actual_redirect_receipt");
  });
  it("reparses the actual parent and keeps strict-v2 separate from equivalent-current mode", async () => {
    const f = fixture(), dir = await mkdtemp(join(tmpdir(), "synthetic-parent-equivalent-"));
    try {
      const html = Buffer.from(`<html><body>
        <div class="page_name"><label>許可證號</label><span>${license}</span></div>
        <div class="page_name"><label>中文品名</label><span>合成測試液</span></div>
        <div class="page_name"><label>英文品名</label><span>Synthetic Test Solution</span></div>
        <div class="page_name"><label>藥品類別</label><span>合成處方藥</span></div>
        <div class="popup" data_popup="popup-new2"><div class="pagetitle">紙本仿單樣式(自行上傳)</div><a href="${urls[0]}">第一筆</a><a href="${urls[1]}">第二筆</a></div>
        <div class="popup" data_popup="popup-history"><div class="pagetitle">歷史仿單</div></div></body></html>`);
      const parentPath = join(dir, "parent.html"); await writeFile(parentPath, html);
      f.parentFetched.sha256 = hash(html); f.parentFetched.bytes = html.length;
      for (const [i, entry] of f.sources.entries()) {
        mutateEnvelope(f, i, v => { v.job.parents[0].parentRawSha256 = hash(html); v.result.parents[0].parentRawSha256 = hash(html); });
        entry.source.allArchiveRoles = JSON.parse(Buffer.from(entry.metadataBytes).toString()).job.parents;
        entry.source.rawSourcePath = join(dir, `child${i}.pdf`); entry.source.rawMetadataPath = join(dir, `receipt${i}.json`);
        await writeFile(entry.source.rawSourcePath, entry.rawBytes); await writeFile(entry.source.rawMetadataPath, entry.metadataBytes);
      }
      const parent = { rawSourcePath: parentPath, rawSourceSha256: hash(html), fetched: f.parentFetched, currentEquivalentSources: f.sources.map(v => v.source) };
      const catalog = [{ "許可證字號": license, "中文品名": "合成測試液", "英文品名": "Synthetic Test Solution", "劑型": "合成液劑", "製造商名稱": "合成製造商", "有效日期": "2099/12/31", "註銷狀態": "", "藥品類別": "合成處方藥" }];
      const index = [{ ...catalog[0], "仿單圖檔連結": f.parentFetched.requestedUrl }];
      const input: TfdaSourceInput = { licenseNo: license, checkedAt: stamp, catalogCheckedAt: stamp, indexCheckedAt: stamp, officialCategory: "合成處方藥",
        catalogRows: [], indexRows: [], fetched: f.representativeFetched, format: "pdf", numPages: 0, pages: [] };
      const snapshots = [36, 39].map(infoId => ({ infoId: infoId as 36 | 39, sha256: hash(String(infoId)), path: "unused", evidencePath: "unused", evidenceSha256: hash("evidence") }));
      const options = { python: process.env.TFDA_TEST_PYTHON || "python", now };
      const verified = await verifyParentPaperEquivalentSources(parent, input, parentPath, html, catalog, index, snapshots, options);
      expect(verified.association.linkedSourceUrls).toEqual(urls);
      expect(verified.proof.schema).toBe("tfda-current-parent-paper-verification/v3");
      expect(verified.proof.currentPaperEquivalence.artifacts).toHaveLength(2);
      await expect(verifyParentPaperSource(parent, input, parentPath, html, catalog, index, snapshots, options)).rejects.toThrow("parent_current_paper_branch_inventory_ambiguous_or_historical");
      await expect(verifyParentPaperEquivalentSources(parent, input, parentPath, html, [{ ...catalog[0], "中文品名": "其他產品" }], index, snapshots, options)).rejects.toThrow("parent_official_index_title_mismatch");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
