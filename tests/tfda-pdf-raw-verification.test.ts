import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePdfFromRaw, verifyCandidateFromRaw } from "../tools/tfda-candidate-verification";
import { evaluateTfdaSource, type TfdaSourceInput } from "../tools/tfda-source-core";
import { publicationHash, TFDA_PUBLICATION_SCHEMA, TFDA_PUBLICATION_BUCKET, TFDA_PUBLICATION_PROJECT } from "../tools/tfda-publication-core";
import { loadPublicationBatch } from "../tools/publish-tfda-sources";
import { buildTfdaRawPdf, PDF_FIXTURE_NAME_EN } from "./fixtures/tfda-raw-pdf-fixtures";

// These are real parsable PDF fixtures. Missing Python/pdfplumber/pypdf fails this suite;
// install the dedicated CI requirements, or set TFDA_TEST_PYTHON to an explicit interpreter.
const python = process.env.TFDA_TEST_PYTHON || "python";
const options = { python };
const licenseNo = "衛部藥製字第999983號", nameZh = "合成原始檔驗證錠5毫克";
const sourceUrl = "https://mcp.fda.gov.tw/synthetic/raw-verification-fixture.pdf";
let folder: string;
interface Case { path: string; raw: Buffer; derived: Awaited<ReturnType<typeof derivePdfFromRaw>> }
const fixtures: Record<string, Case> = {};
function inputFor(fixture: Case): TfdaSourceInput {
  const when = new Date(Date.now() - 5000).toISOString();
  return { licenseNo, checkedAt: when, catalogCheckedAt: when, indexCheckedAt: when,
    catalogRows: [{ licenseNo, nameZh, nameEn: PDF_FIXTURE_NAME_EN, form: "合成錠劑", manufacturer: "合成測試製造商", revoked: false, effectiveUntil: "2099/12/31" }],
    indexRows: [{ licenseNo, nameZh, nameEn: PDF_FIXTURE_NAME_EN, urls: [sourceUrl] }],
    fetched: { requestedUrl: sourceUrl, finalUrl: sourceUrl, retrievedAt: when, sha256: publicationHash(fixture.raw), bytes: fixture.raw.length,
      mediaType: "application/pdf", contentSignature: "pdf" }, format: "pdf", numPages: fixture.derived.numPages, pages: structuredClone(fixture.derived.pages) };
}
async function writeBatch(fixture: Case, input: TfdaSourceInput, label: string) {
  const candidatePath = join(folder, `${label}-candidate.json`), candidateBytes = Buffer.from(JSON.stringify(input));
  await writeFile(candidatePath, candidateBytes);
  const info36 = [{ "許可證字號": licenseNo, "中文品名": nameZh, "英文品名": PDF_FIXTURE_NAME_EN,
    "劑型": "合成錠劑", "製造商名稱": "合成測試製造商", "有效日期": "2099/12/31", "註銷狀態": "", "藥品類別": "合成處方藥" }];
  const info39 = [{ "許可證字號": licenseNo, "中文品名": nameZh, "英文品名": PDF_FIXTURE_NAME_EN, "仿單圖檔連結": sourceUrl }];
  const indexSnapshots = [];
  for (const [infoId, rows] of [[36, info36], [39, info39]] as const) {
    const bytes = Buffer.from(JSON.stringify(rows)), path = join(folder, `${label}-info${infoId}.json`), evidencePath = join(folder, `${label}-evidence${infoId}.json`);
    const endpoint = `https://data.fda.gov.tw/data/opendata/export/${infoId}/json`;
    const evidence = Buffer.from(JSON.stringify({ infoId, jsonSha256: publicationHash(bytes), jsonBytes: bytes.length, rows: rows.length,
      requestedUrl: endpoint, finalUrl: endpoint, redirects: [], retrievedAt: input.catalogCheckedAt, httpStatus: 200 }));
    await writeFile(path, bytes); await writeFile(evidencePath, evidence);
    indexSnapshots.push({ infoId, path, sha256: publicationHash(bytes), evidencePath, evidenceSha256: publicationHash(evidence) });
  }
  const manifest = { schema: TFDA_PUBLICATION_SCHEMA, batchId: `synthetic-${label}`, project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET,
    indexSnapshots, items: [{ fullLicense: licenseNo, candidateInputPath: candidatePath, candidateInputSha256: publicationHash(candidateBytes),
      rawSourcePath: fixture.path, rawSourceSha256: publicationHash(fixture.raw) }] };
  const path = join(folder, `${label}-batch.json`); await writeFile(path, JSON.stringify(manifest)); return path;
}
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "tfda-real-pdf-raw-"));
  for (const [label, fixtureOptions] of [["complete", {}], ["blank", { blankSecondPage: true }], ["image", { largeImage: true }],
    ["table", { tableGrid: true }], ["columns", { twoColumns: true }]] as const) {
    const raw = buildTfdaRawPdf(fixtureOptions), path = join(folder, `${label}.pdf`); await writeFile(path, raw);
    fixtures[label] = { path, raw, derived: await derivePdfFromRaw(path, raw, options) };
  }
}, 30000);
afterAll(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

describe("genuine PDF raw replay and fabricated evidence attacks", () => {
  it("replays all three actual engines, preserves two complete pages and passes the unchanged core gate", async () => {
    const fixture = fixtures.complete, input = inputFor(fixture);
    expect(input.numPages).toBe(2); expect(input.pages[0].text).toContain(PDF_FIXTURE_NAME_EN);
    expect(input.pages.every((page) => page.embeddedImages === 0 && page.hasLargeUnverifiedImage === false)).toBe(true);
    expect(input.pages.every((page) => page.hasUnverifiedStructure === false && page.structureEvidence?.version === "tfda-pdf-structure-v1")).toBe(true);
    expect(evaluateTfdaSource(input).status).toBe("technically_eligible");
    const proof = await verifyCandidateFromRaw(fixture.path, fixture.raw, input, options);
    expect(proof).toMatchObject({ method: "pdf_raw_three_engine_reparse_v1", rawSha256: publicationHash(fixture.raw), rawBytes: fixture.raw.length });
    const loaded = await loadPublicationBatch(await writeBatch(fixture, input, "genuine"), Date.now(), options);
    expect(loaded.loaded[0].source.rawVerification?.method).toBe("pdf_raw_three_engine_reparse_v1");
  }, 15000);
  it("rejects invented primary and two matching independent texts even when genuine raw SHA and manifest hashes agree", async () => {
    const fixture = fixtures.complete, input = inputFor(fixture);
    const forged = input.pages[0].text.replace("complete synthetic source", "entirely invented narrative");
    input.pages[0] = { ...input.pages[0], text: forged, independentText: forged, additionalIndependentText: forged };
    expect(evaluateTfdaSource(input).status).toBe("technically_eligible");
    const batch = await writeBatch(fixture, input, "forged-text");
    await expect(loadPublicationBatch(batch, Date.now(), options)).rejects.toThrow("candidate_pdf_pages_do_not_match_raw_source");
  }, 15000);
  it.each(["independentText", "additionalIndependentText"] as const)("rejects fabricated %s rather than trusting matching primary text", async (field) => {
    const fixture = fixtures.complete, input = inputFor(fixture); input.pages[0][field] += " fabricated exception";
    await expect(verifyCandidateFromRaw(fixture.path, fixture.raw, input, options)).rejects.toThrow("candidate_pdf_pages_do_not_match_raw_source");
  }, 15000);
  it("rejects a candidate numPages declaration that differs from the actual physical page inventory", async () => {
    const fixture = fixtures.complete, input = inputFor(fixture); input.numPages = 1;
    await expect(verifyCandidateFromRaw(fixture.path, fixture.raw, input, options)).rejects.toThrow("candidate_pdf_pages_do_not_match_raw_source");
  }, 15000);
  it("keeps a physical blank page and blocks a forged candidate that silently removes it", async () => {
    const fixture = fixtures.blank, input = inputFor(fixture);
    expect(input.numPages).toBe(2); expect(input.pages[1].text).toBe("");
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(false);
    input.numPages = 1; input.pages = input.pages.slice(0, 1);
    expect(evaluateTfdaSource(input).status).toBe("technically_eligible");
    await expect(loadPublicationBatch(await writeBatch(fixture, input, "blank-page-removed"), Date.now(), options))
      .rejects.toThrow("candidate_pdf_pages_do_not_match_raw_source");
  }, 15000);
  it("derives image geometry from the actual PDF and rejects fabricated count and safe-image flags", async () => {
    const fixture = fixtures.image, input = inputFor(fixture);
    expect(input.pages[0].embeddedImages).toBe(1); expect(input.pages[0].hasLargeUnverifiedImage).toBe(true);
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(false);
    input.pages[0].embeddedImages = 0; input.pages[0].hasLargeUnverifiedImage = false;
    expect(evaluateTfdaSource(input).status).toBe("technically_eligible");
    await expect(loadPublicationBatch(await writeBatch(fixture, input, "image-concealed"), Date.now(), options))
      .rejects.toThrow("candidate_pdf_pages_do_not_match_raw_source");
  }, 15000);
  it("fails explicitly when the independent runtime or dependencies are unavailable", async () => {
    const fixture = fixtures.complete;
    await expect(derivePdfFromRaw(fixture.path, fixture.raw, { python: join(folder, "missing-python") }))
      .rejects.toThrow("raw_pdf_verification_engine_unavailable_or_failed");
  }, 15000);
  it.each(["table", "columns"])("derives %s structure from raw vectors/word geometry and rejects a candidate declaring it safe", async (label) => {
    const fixture = fixtures[label], input = inputFor(fixture);
    expect(input.pages[0].hasUnverifiedStructure).toBe(true);
    expect(input.pages[0].structureEvidence?.status).toBe("review_required");
    expect(evaluateTfdaSource(input).reasons).toContain("unverified_structure");
    input.pages[0].hasUnverifiedStructure = false;
    input.pages[0].structureEvidence = { version: "tfda-pdf-structure-v1", status: "single_flow_no_detected_structure", reasons: [] };
    await expect(verifyCandidateFromRaw(fixture.path, fixture.raw, input, options)).rejects.toThrow("candidate_pdf_pages_do_not_match_raw_source");
  }, 15000);
});
