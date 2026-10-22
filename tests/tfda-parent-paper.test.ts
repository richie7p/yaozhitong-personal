import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTfdaRawPdf, PDF_FIXTURE_NAME_EN } from "./fixtures/tfda-raw-pdf-fixtures";
import { deriveSerialPaperPdf, parentBlobPath } from "../tools/tfda-parent-paper-verification";
import { loadPublicationBatch } from "../tools/publish-tfda-sources";
import { applyTechnicalPublication, assertPublicationBlob, assertPublicationWrite, publicationHash as hash,
  TFDA_PUBLICATION_SCHEMA, TFDA_PUBLICATION_PROJECT, TFDA_PUBLICATION_BUCKET, type PublicationManifest, type PublicationStore,
  type PublicationDoc } from "../tools/tfda-publication-core";
import type { TfdaSourceInput } from "../tools/tfda-source-core";

// Genuine small PDF bytes; all names and medicine prose are synthetic. No network/cloud/AI.
const python = process.env.TFDA_TEST_PYTHON || "python";
const license = "衛部藥製字第999976號", nameZh = "合成父頁驗證錠5毫克", nameEn = PDF_FIXTURE_NAME_EN;
const parentRequested = "https://mcp.fda.gov.tw/exportpdf/" + encodeURIComponent(license);
const parentFinal = "https://mcp.fda.gov.tw/im_detail_1/" + encodeURIComponent(license) + "?export=opendata";
const childUrl = "https://mcp.fda.gov.tw/fileshow/synthetic-current-paper";
let folder: string, raw: Buffer, pdfPath: string, derived: Awaited<ReturnType<typeof deriveSerialPaperPdf>>;
let sequence = 0;
const parentHtml = (current = `<a href="${childUrl}">合成紙本</a>`, history = "", headerLicense = license, headerName = nameZh) => Buffer.from(`<!doctype html><html><body>
  <div class="page_name"><label>許可證號</label><span>${headerLicense}</span></div>
  <div class="page_name"><label>中文品名</label><span>${headerName}</span></div>
  <div class="page_name"><label>英文品名</label><span>${nameEn}</span></div>
  <div class="page_name"><label>藥品類別</label><span>合成處方藥</span></div>
  <div class="popup" data_popup="popup-new2"><div class="pagetitle">紙本仿單樣式(自行上傳)</div>${current}</div>
  <div class="popup" data_popup="popup-history"><div class="pagetitle">歷史仿單</div>${history}</div>
</body></html>`);
async function fixture({ parent = parentHtml(), catalogChange = {}, indexUrls = [parentRequested] }: { parent?: Buffer; catalogChange?: Record<string, unknown>; indexUrls?: string[] } = {}) {
  const id = String(sequence++), when = new Date(Date.now() - 2000).toISOString(), parentPath = join(folder, id + "-parent.html");
  await writeFile(parentPath, parent);
  const catalog = [{ "許可證字號": license, "中文品名": nameZh, "英文品名": nameEn, "劑型": "合成錠劑", "製造商名稱": "合成製造商", "有效日期": "2099/12/31", "註銷狀態": "", "藥品類別": "合成處方藥", ...catalogChange }];
  const index = [{ "許可證字號": license, "中文品名": nameZh, "英文品名": nameEn, "仿單圖檔連結": indexUrls.join(";") }];
  const input: TfdaSourceInput = { licenseNo: license, checkedAt: when, catalogCheckedAt: when, indexCheckedAt: when, officialCategory: "合成處方藥",
    catalogRows: catalog.map((row) => ({ licenseNo: license, nameZh: row["中文品名"], nameEn: row["英文品名"], form: row["劑型"], manufacturer: row["製造商名稱"], effectiveUntil: row["有效日期"], revoked: !!row["註銷狀態"] })),
    indexRows: [{ licenseNo: license, nameZh, nameEn, urls: indexUrls }], fetched: { requestedUrl: childUrl, finalUrl: childUrl, retrievedAt: when,
      sha256: hash(raw), bytes: raw.length, mediaType: "application/pdf", contentSignature: "pdf" }, format: "pdf", numPages: derived.numPages, pages: structuredClone(derived.pages),
    officialAssociation: { indexUrl: parentRequested, detailUrl: parentFinal, licenseNo: license, linkedSourceUrls: [childUrl], retrievedAt: when, detailSha256: hash(parent) } };
  const inputPath = join(folder, id + "-candidate.json"), inputBytes = Buffer.from(JSON.stringify(input)); await writeFile(inputPath, inputBytes);
  const snapshots = [];
  for (const [infoId, rows] of [[36, catalog], [39, index]] as const) {
    const bytes = Buffer.from(JSON.stringify(rows)), path = join(folder, id + `-info${infoId}.json`), evidencePath = join(folder, id + `-evidence${infoId}.json`);
    const endpoint = `https://data.fda.gov.tw/data/opendata/export/${infoId}/json`, evidence = Buffer.from(JSON.stringify({ infoId, jsonSha256: hash(bytes), jsonBytes: bytes.length,
      rows: rows.length, requestedUrl: endpoint, finalUrl: endpoint, redirects: [], retrievedAt: when, httpStatus: 200 }));
    await writeFile(path, bytes); await writeFile(evidencePath, evidence); snapshots.push({ infoId, path, sha256: hash(bytes), evidencePath, evidenceSha256: hash(evidence) });
  }
  const manifest: PublicationManifest = { schema: TFDA_PUBLICATION_SCHEMA, batchId: "synthetic-parent-" + id, project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET,
    indexSnapshots: snapshots, items: [{ fullLicense: license, candidateInputPath: inputPath, candidateInputSha256: hash(inputBytes), rawSourcePath: pdfPath, rawSourceSha256: hash(raw),
      parentSource: { rawSourcePath: parentPath, rawSourceSha256: hash(parent), fetched: { requestedUrl: parentRequested, finalUrl: parentFinal, redirectChain: [parentRequested, parentFinal],
        retrievedAt: when, sha256: hash(parent), bytes: parent.length, mediaType: "text/html", contentSignature: "html" } } }] };
  const path = join(folder, id + "-batch.json");
  const save = async () => { const bytes = Buffer.from(JSON.stringify(input)); await writeFile(inputPath, bytes); manifest.items[0].candidateInputSha256 = hash(bytes); await writeFile(path, JSON.stringify(manifest)); };
  await save(); return { path, input, manifest, save };
}
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "synthetic-tfda-parent-paper-")); raw = buildTfdaRawPdf(); pdfPath = join(folder, "synthetic-child.pdf"); await writeFile(pdfPath, raw);
  derived = await deriveSerialPaperPdf(pdfPath, raw, { python });
}, 30000);
afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

describe("independently reparsed indexed parent paper boundary", () => {
  it("keeps default association rejection and allows only explicit strict mode with actual parent/child replay", async () => {
    const item = await fixture();
    await expect(loadPublicationBatch(item.path, Date.now(), { python })).rejects.toThrow("unverified_parent_association_not_supported");
    const loaded = await loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" }), source = loaded.loaded[0].source;
    expect(source.assessment.eligibleTechnical && source.assessment.runtimeCompatible).toBe(true);
    expect(source.parentVerification).toMatchObject({ schema: "tfda-current-parent-paper-verification/v2", scope: "single_current_paper_excluding_explicit_history",
      licenseNo: license, currentPaperUrls: [childUrl], historicalPaperUrls: [], excludedHistoricalPaperUrls: [], excludedHistoricalElectronicUrls: [], childRawSha256: hash(raw) });
    expect(source.parentVerification?.branchInventory.anchors).toHaveLength(1);
    expect(JSON.stringify(source.parentVerification)).not.toContain(folder);
    expect(() => assertPublicationBlob(parentBlobPath(source.parentVerification!.parentRawSha256))).not.toThrow();
  }, 20000);
  it("records explicitly scoped electronic history but never uses it as the current source", async () => {
    const electronic = parentFinal.split("?")[0] + "?item=123";
    const item = await fixture({ parent: parentHtml(undefined, `<a href="${electronic}">檢視</a>`) });
    const loaded = await loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" });
    expect(loaded.loaded[0].source.parentVerification?.excludedHistoricalElectronicUrls).toEqual([electronic]);
    expect(loaded.loaded[0].source.parentVerification?.branchInventory.anchors.some((anchor) => anchor.classification === "excluded_history_electronic")).toBe(true);
  }, 20000);
  it("conserves disjoint explicit historical paper and electronic branches without selecting or reading historical files", async () => {
    const oldPaper = "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic-old-paper", electronic = parentFinal.split("?")[0] + "?item=123";
    const item = await fixture({ parent: parentHtml(undefined, `<a href="${oldPaper}">歷史紙本</a><a href="${electronic}">歷史電子</a>`) });
    const batch = await loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" });
    const source = batch.loaded[0].source, proof = source.parentVerification!;
    expect(proof.historicalPaperUrls).toEqual([oldPaper]); expect(proof.excludedHistoricalPaperUrls).toEqual([oldPaper]);
    expect(proof.excludedHistoricalElectronicUrls).toEqual([electronic]); expect(proof.currentPaperUrls).toEqual([childUrl]);
    expect(source.input.officialAssociation!.linkedSourceUrls).toEqual([childUrl]);
    expect(proof.branchInventory.anchors.map((anchor) => anchor.classification)).toEqual(["current_paper_attachment", "excluded_history_paper", "excluded_history_electronic"]);
    const writes: string[] = [], store: PublicationStore = { transaction: async (operation) => operation({ get: async () => null,
      create: (collection) => { writes.push(collection); } }) };
    proof.excludedHistoricalPaperUrls = [];
    await expect(applyTechnicalPublication(store, source, { leaflet: null, pointer: null, audit: null }, {
      runId: "synthetic-forged-exclusion", batchId: batch.manifest.batchId, manifestSha256: batch.manifestSha256, snapshotSha256: "c".repeat(64) }))
      .rejects.toThrow("publication_requires_independently_verified_parent_association");
    expect(writes).toEqual([]);
  }, 20000);
  it.each([
    ["current link placed only in history", parentHtml("", `<a href="${childUrl}">錯誤角色</a>`)],
    ["multiple current branches", parentHtml(`<a href="${childUrl}">甲</a><a href="https://mcp.fda.gov.tw/fileshow/other">乙</a>`)],
    ["same URL in both roles", parentHtml(undefined, `<a href="${childUrl}">舊紙本</a>`)],
    ["unparsed current resource", parentHtml(`<a href="${childUrl}">甲</a><iframe src="https://mcp.fda.gov.tw/other"></iframe>`)],
    ["HTTP downgrade", parentHtml(`<a href="http://mcp.fda.gov.tw/fileshow/synthetic-current-paper">甲</a>`)],
    ["historical HTTP downgrade", parentHtml(undefined, `<a href="http://mcp.fda.gov.tw/fileshow/old">舊紙本</a>`)],
    ["historical offsite paper", parentHtml(undefined, `<a href="https://example.invalid/old.pdf">舊紙本</a>`)],
    ["encoded current URL collision in history", parentHtml(undefined, `<a href="https://mcp.fda.gov.tw/fileshow/%73ynthetic-current-paper">舊紙本</a>`)],
    ["unknown historical route", parentHtml(undefined, `<a href="https://mcp.fda.gov.tw/unknown-history">未知</a>`)],
  ])("rejects %s with complete raw branch evidence", async (_label, parent) => {
    const item = await fixture({ parent: parent as Buffer });
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("parent_current_paper_branch_inventory_ambiguous_or_historical");
  });
  it("rejects the retired strict-v1 caller mode even with a valid raw parent", async () => {
    const item = await fixture();
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v1" as any })).rejects.toThrow("unverified_parent_association_not_supported");
  });
  it.each([
    ["license", parentHtml(undefined, "", "衛部藥製字第999977號")],
    ["old brand or strength", parentHtml(undefined, "", license, "合成舊品牌錠50毫克")],
  ])("rejects a raw parent %s mismatch despite a matching candidate claim", async (_label, parent) => {
    const item = await fixture({ parent: parent as Buffer });
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("parent_current_complete_identity_or_category_mismatch");
  });
  it("rejects forged parent bytes/hash and forged candidate association independently", async () => {
    const item = await fixture(); item.input.officialAssociation!.detailSha256 = "f".repeat(64); await item.save();
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("candidate_parent_claim_differs_from_raw_parent");
    item.manifest.items[0].parentSource!.rawSourceSha256 = "f".repeat(64); await item.save();
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("parent_raw_bytes_hash_or_html_signature_mismatch");
  });
  it.each([{ "註銷狀態": "已註銷" }, { "有效日期": "2001/12/31" }])("checks actual current official revoked/expiry metadata %j", async (catalogChange) => {
    const item = await fixture({ catalogChange });
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("parent_current_license_revoked_expired_or_missing");
  });
  it("does not choose the first of multiple actual Info39 parent URLs", async () => {
    const item = await fixture({ indexUrls: [parentRequested, "https://mcp.fda.gov.tw/synthetic/second-parent"] });
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("parent_must_be_unique_actual_Info39_url");
  });
  it("blocks an oversized complete branch proof before publication without truncating parent raw", async () => {
    const parent = parentHtml(`<a href="${childUrl}">${"SYNTHETIC ".repeat(11000)}</a>`), item = await fixture({ parent });
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" }))
      .rejects.toThrow("parent_branch_proof_exceeds_100000_bytes_no_truncation");
    expect(await readFile(item.manifest.items[0].parentSource!.rawSourcePath)).toEqual(parent);
  });
  it("rejects fabricated child text even with matching independent candidate declarations and a real parent", async () => {
    const item = await fixture();
    const page = item.input.pages[0], text = page.text.replace("complete synthetic source", "invented different narrative");
    Object.assign(page, { text, independentText: text, additionalIndependentText: text }); await item.save();
    await expect(loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" })).rejects.toThrow("candidate_parent_paper_pdf_pages_do_not_match_raw");
  }, 20000);
  it("persists the full independently derived parent proof without local paths, preserving whole child pages", async () => {
    const item = await fixture(), batch = await loadPublicationBatch(item.path, Date.now(), { python, parentPaperMode: "strict-v2" });
    const data: Record<string, PublicationDoc> = {}, writes: string[] = [];
    const store: PublicationStore = { transaction: async (operation) => operation({ get: async (collection, id) => data[collection + "/" + id] || null,
      create: (collection, id, value) => { assertPublicationWrite(collection, id); expect(data[collection + "/" + id]).toBeUndefined(); data[collection + "/" + id] = value; writes.push(collection); } }) };
    const source = batch.loaded[0].source;
    expect(await applyTechnicalPublication(store, source, { leaflet: null, pointer: null, audit: null }, { runId: "synthetic-parent-run", batchId: batch.manifest.batchId,
      manifestSha256: batch.manifestSha256, snapshotSha256: "c".repeat(64) })).toBe("published_technical_source");
    const leaflet = data["leaflets/" + source.draft.id];
    expect(leaflet.sourceVerification.officialParentVerification).toEqual(source.parentVerification);
    expect(leaflet.chunks.map((chunk: any) => chunk.text)).toEqual(source.input.pages.map((page) => page.text));
    expect(writes.sort()).toEqual(["audit", "leaflets", "published"]); expect(JSON.stringify(leaflet)).not.toContain(folder);
  }, 20000);
});
