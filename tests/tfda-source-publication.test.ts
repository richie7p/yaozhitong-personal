import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { TfdaSourceInput } from "../tools/tfda-source-core";
import { loadPublicationBatch, main } from "../tools/publish-tfda-sources";
import {
  TFDA_PUBLICATION_ACTOR, TFDA_PUBLICATION_BUCKET, TFDA_PUBLICATION_PROJECT,
  TFDA_PUBLICATION_SCHEMA, TFDA_PROTECTED_LICENSES, applyTechnicalPublication,
  ensureTechnicalSourceBlob,
  catalogCacheFilename, verifyCachedCatalog,
  assertPublicationBlob, assertPublicationWrite, inspectTechnicalPublication,
  prepareTechnicalSource, publicationHash, technicalAuditId, validatePublicationManifest,
  type PublicationBefore, type PublicationDoc, type PublicationManifest,
  type PublicationRun, type PublicationStore, type TechnicalBlobState, type TechnicalBlobStore,
} from "../tools/tfda-publication-core";

// Synthetic bytes, names and prose only. These tests never connect to a cloud or model.
const now = Date.parse("2026-10-22T03:00:00Z");
const when = new Date(now - 60000).toISOString();
const license = "衛部藥製字第999982號", nameZh = "合成程式測試錠5毫克", nameEn = "SYNTHETIC FIXTURE TABLETS 5MG";
const url = "https://mcp.fda.gov.tw/synthetic/publication-fixture.pdf";
const raw = Buffer.from("%PDF-1.7\nSYNTHETIC COMPLETE SOURCE BYTES");
const empty: PublicationBefore = { leaflet: null, pointer: null, audit: null };
const run: PublicationRun = { runId: "synthetic-fixed-run", batchId: "synthetic-batch", manifestSha256: "a".repeat(64), snapshotSha256: "b".repeat(64) };
function candidate(licenseNo = license): TfdaSourceInput {
  const text = `${nameZh}\n${nameEn}\n${licenseNo}\n適應症\n` +
    "這段合成文字只供程式測試，包含必要條件及例外，完整順序全部保留，不提供真實藥品資訊或醫療指示。".repeat(4);
  const second = "警語及注意事項\n" +
    "合成條件甲成立且合成條件乙不存在時，請依合成規則處理。此頁只是程式測試資料，包含完整限制及例外文字。".repeat(4);
  return { licenseNo, checkedAt: when, catalogCheckedAt: when, indexCheckedAt: when,
    catalogRows: [{ licenseNo, nameZh, nameEn, form: "合成錠劑", manufacturer: "合成製造商", effectiveUntil: "2030/12/31", revoked: false }],
    indexRows: [{ licenseNo, nameZh, nameEn, urls: [url] }],
    fetched: { requestedUrl: url, finalUrl: url, retrievedAt: when, sha256: publicationHash(raw), bytes: raw.length, mediaType: "application/pdf", contentSignature: "pdf" },
    format: "pdf", numPages: 2,
    pages: [text, second].map((text, i) => ({ page: i + 1, text, independentText: text, embeddedImages: 0, hasLargeUnverifiedImage: false, hasUnverifiedStructure: false })) };
}
function item(licenseNo = license) {
  return { fullLicense: licenseNo, candidateInputPath: "candidate.json", candidateInputSha256: "c".repeat(64), rawSourcePath: "source.pdf", rawSourceSha256: publicationHash(raw) };
}
function source(licenseNo = license) {
  const prepared = prepareTechnicalSource(item(licenseNo), candidate(licenseNo), raw, now);
  // Unit-only synthetic proof; CLI integration below independently reparses real HTML bytes.
  prepared.rawVerification = { schema: "tfda-candidate-raw-verification/v1", method: "pdf_raw_three_engine_reparse_v1",
    rawSha256: prepared.draft.sha256, rawBytes: raw.length, canonicalTextSha256: prepared.assessment.canonicalTextSha256!,
    derivedPagesSha256: publicationHash(JSON.stringify(prepared.input.pages)), derivedHtmlEvidenceSha256: null,
    parserHelperSha256: "e".repeat(64), adapterSha256: "f".repeat(64), canonicalAdapterSha256: "e".repeat(64), rawInspectionSha256: "f".repeat(64) };
  return prepared;
}
class MemoryPublicationStore implements PublicationStore {
  data: Record<string, Record<string, PublicationDoc>> = {};
  writes: [string, string][] = [];
  async transaction<T>(operation: Parameters<PublicationStore["transaction"]>[0]): Promise<T> {
    const state = structuredClone(this.data), writes: [string, string][] = [];
    const result = await operation({
      get: async (collection, id) => structuredClone(state[collection]?.[id] ?? null),
      create: (collection, id, value) => {
        assertPublicationWrite(collection, id);
        if (state[collection]?.[id]) throw Error("create_precondition_failed");
        (state[collection] ||= {})[id] = structuredClone(value);
        writes.push([collection, id]);
      },
    });
    this.data = state;
    this.writes.push(...writes);
    return result as T;
  }
}
const temp: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of temp.splice(0)) await rm(path, { recursive: true, force: true }); });
async function batchFixture() {
  const path = await mkdtemp(join(tmpdir(), "tfda-publication-synthetic-")); temp.push(path);
  const input = candidate();
  const body = "這份合成來源保留真正原始檔的完整文字。必要條件、例外與順序全部保留，此內容只供測試，不是真實藥品資訊或醫療指示。".repeat(4);
  const sourceRaw = Buffer.from(`<!doctype html><html><body>
    <div class="page_name"><label>中文品名</label><span>${nameZh}</span></div>
    <div class="page_name"><label>英文品名</label><span>${nameEn}</span></div>
    <div class="page_name"><label>許可證號</label><span>${license}</span></div>
    <div class="page_name"><label>藥品類別</label><span>合成處方藥</span></div>
    <div class="toggle-all"><div class="toggle"><div class="toggle-title"><div class="title-name">適應症</div></div>
    <div class="toggle-inner"><p>${body}</p><table><tr><th>合成條件</th><th>合成例外</th></tr><tr><td>甲</td><td>乙</td></tr></table></div>
    </div></div></body></html>`);
  const canonical = `${nameZh}\n${nameEn}\n${license}\n合成處方藥\n\n適應症\n${body}\n合成條件\t合成例外\n甲\t乙`;
  input.format = "html"; input.numPages = 1;
  input.fetched = { ...input.fetched, sha256: publicationHash(sourceRaw), bytes: sourceRaw.length, mediaType: "text/html", contentSignature: "html" };
  input.pages = [{ page: 1, text: canonical, embeddedImages: 0, hasLargeUnverifiedImage: false }];
  input.htmlEvidence = { completeMainDocument: true, domConservationPassed: true, canonicalTextSha256: publicationHash(canonical), sectionCount: 1, hasUnverifiedNonTextContent: false };
  const info36 = [{ "許可證字號": license, "中文品名": nameZh, "英文品名": nameEn,
    "劑型": "合成錠劑", "製造商名稱": "合成製造商", "有效日期": "2030/12/31", "註銷狀態": "", "藥品類別": "合成處方藥" }];
  const info39 = [{ "許可證字號": license, "中文品名": nameZh, "英文品名": nameEn, "仿單圖檔連結": url }];
  const encoded = Buffer.from(JSON.stringify(input));
  await writeFile(join(path, "candidate.json"), encoded); await writeFile(join(path, "source.html"), sourceRaw);
  const indexSnapshots: PublicationManifest["indexSnapshots"] = [];
  for (const [infoId, rows] of [[36, info36], [39, info39]] as const) {
    const bytes = Buffer.from(JSON.stringify(rows)), hash = publicationHash(bytes), endpoint = `https://data.fda.gov.tw/data/opendata/export/${infoId}/json`;
    const evidence = Buffer.from(JSON.stringify({ infoId, jsonSha256: hash, jsonBytes: bytes.length, rows: rows.length,
      requestedUrl: endpoint, finalUrl: endpoint, redirects: [], retrievedAt: when, httpStatus: 200 }));
    await writeFile(join(path, `info${infoId}.json`), bytes); await writeFile(join(path, `evidence${infoId}.json`), evidence);
    indexSnapshots.push({ infoId, path: `info${infoId}.json`, sha256: hash, evidencePath: `evidence${infoId}.json`, evidenceSha256: publicationHash(evidence) });
  }
  const manifest: PublicationManifest = { schema: TFDA_PUBLICATION_SCHEMA, batchId: "synthetic-batch",
    project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET, indexSnapshots,
    items: [{ ...item(), rawSourcePath: "source.html", rawSourceSha256: publicationHash(sourceRaw), candidateInputSha256: publicationHash(encoded) }] };
  const manifestPath = join(path, "batch.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { path, manifestPath, manifest, input, sourceRaw };
}

describe("technical publication no-overwrite and crash recovery", () => {
  it("creates only the three allowed documents with complete multipage text and explicit nonclinical evidence", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    expect(await applyTechnicalPublication(db, prepared, empty, run, when)).toBe("published_technical_source");
    expect(db.writes.map(([collection]) => collection).sort()).toEqual(["audit", "leaflets", "published"]);
    const leaflet = db.data.leaflets[prepared.draft.id];
    expect(leaflet.chunks).toEqual(prepared.draft.chunks);
    expect(leaflet.chunks.map((c: any) => c.text)).toEqual(candidate().pages.map((p) => p.text));
    expect(leaflet).toMatchObject({ checkedBy: TFDA_PUBLICATION_ACTOR, sourceVerification: { humanReviewed: false, clinicalReviewed: false, method: "tfda-automated-source-v1" } });
    expect(leaflet.sourceVerification.criteria.clinicalReviewed).toBe(false);
    expect(leaflet.sourceVerification.evidence.pages).toHaveLength(2);
  });
  it("recovers a transaction committed before the local journal was written without a second write", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    await applyTechnicalPublication(db, prepared, empty, run, when);
    const beforeResume = structuredClone(db.data), count = db.writes.length;
    expect(await applyTechnicalPublication(db, prepared, empty, run, new Date(now).toISOString())).toBe("recovered_committed_publication");
    expect(db.data).toEqual(beforeResume); expect(db.writes).toHaveLength(count);
  });
  it("preserves identical existing publication content and all existing metadata", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    const existing = { ...prepared.draft, status: "published", checkedBy: "prior-source-actor", checkedAt: when, extraImmutableMetadata: "preserve" };
    const pointer = { leafletId: prepared.draft.id, version: prepared.draft.version, extraImmutableMetadata: 99 };
    db.data = { leaflets: { [prepared.draft.id]: existing }, published: { [publicationHash(license)]: pointer } };
    const before = { leaflet: existing, pointer, audit: null }, original = structuredClone(db.data);
    expect(inspectTechnicalPublication(prepared, before).decision).toBe("same_source_no_op");
    expect(await applyTechnicalPublication(db, prepared, before, run, when)).toBe("same_source_no_op");
    expect(db.data).toEqual(original); expect(db.writes).toHaveLength(0);
  });
  it("refuses to replace a different existing published pointer", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    db.data.published = { [publicationHash(license)]: { leafletId: "d".repeat(64), version: "other" } };
    const before = structuredClone(db.data);
    await expect(applyTechnicalPublication(db, prepared, empty, run, when)).rejects.toThrow("existing_publication_must_not_be_replaced");
    expect(db.data).toEqual(before); expect(db.writes).toHaveLength(0);
  });
  it("refuses even a matching pre-existing draft rather than silently promoting it", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    db.data.leaflets = { [prepared.draft.id]: structuredClone(prepared.draft) };
    const before = { leaflet: prepared.draft, pointer: null, audit: null };
    expect(inspectTechnicalPublication(prepared, before).decision).toBe("conflict");
    await expect(applyTechnicalPublication(db, prepared, before, run, when)).rejects.toThrow("existing_leaflet_or_audit_requires_separate_resolution");
    expect(db.writes).toHaveLength(0);
  });
  it("detects a matching-content pointer created by another run after inspection", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    await applyTechnicalPublication(db, prepared, empty, { ...run, runId: "other-run" }, when);
    const count = db.writes.length;
    await expect(applyTechnicalPublication(db, prepared, empty, run, when)).rejects.toThrow("publication_changed_since_fixed_snapshot");
    expect(db.writes).toHaveLength(count);
  });
  it("does not accept a partial or tampered recovery marker", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    await applyTechnicalPublication(db, prepared, empty, run, when);
    delete db.data.audit[technicalAuditId(run.runId, prepared.draft.id)];
    const count = db.writes.length;
    await expect(applyTechnicalPublication(db, prepared, empty, run, when)).rejects.toThrow("publication_changed_since_fixed_snapshot");
    expect(db.writes).toHaveLength(count);
  });
  it("refuses recovery when this run's evidence was changed after its transaction committed", async () => {
    const db = new MemoryPublicationStore(), prepared = source();
    await applyTechnicalPublication(db, prepared, empty, run, when);
    db.data.leaflets[prepared.draft.id].sourceVerification.clinicalReviewed = true;
    await expect(applyTechnicalPublication(db, prepared, empty, run, when)).rejects.toThrow("owned_publication_marker_inconsistent");
    expect(db.writes).toHaveLength(3);
  });
  it.each(TFDA_PROTECTED_LICENSES)("never writes protected publication %s", async (fullLicense) => {
    const db = new MemoryPublicationStore(), prepared = source(fullLicense);
    expect(await applyTechnicalPublication(db, prepared, empty, run, when)).toBe("skip_protected_publication");
    expect(db.writes).toHaveLength(0);
  });
});

describe("source blob generation preconditions and upload crash recovery", () => {
  const absent: TechnicalBlobState = { exists: false, generation: null, sha256: null };
  function blobs(initial: TechnicalBlobState = absent) {
    let state = structuredClone(initial);
    const creates: unknown[][] = [];
    const store: TechnicalBlobStore = {
      state: async () => structuredClone(state),
      createIfAbsent: async (...args) => {
        creates.push(args);
        state = { exists: true, generation: "1001", sha256: publicationHash(args[1]), owner: args[3] };
      },
    };
    return { store, creates, get: () => structuredClone(state), set: (value: TechnicalBlobState) => { state = value; } };
  }
  it("creates a new blob with generation zero and verifies its returned hash", async () => {
    const fake = blobs(), prepared = source();
    const result = await ensureTechnicalSourceBlob(fake.store, prepared, raw, absent, run);
    expect(result.sha256).toBe(prepared.draft.sha256); expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0][0]).toBe(prepared.draft.storagePath);
    expect(fake.creates[0][4]).toEqual({ ifGenerationMatch: 0 });
  });
  it("resumes after a verified upload but before the Firestore transaction without uploading again", async () => {
    const fake = blobs(), prepared = source();
    await ensureTechnicalSourceBlob(fake.store, prepared, raw, absent, run);
    await ensureTechnicalSourceBlob(fake.store, prepared, raw, absent, run);
    expect(fake.creates).toHaveLength(1);
  });
  it("refuses a blob created by another run after the fixed snapshot", async () => {
    const fake = blobs(), prepared = source();
    await ensureTechnicalSourceBlob(fake.store, prepared, raw, absent, { ...run, runId: "another-run" });
    await expect(ensureTechnicalSourceBlob(fake.store, prepared, raw, absent, run)).rejects.toThrow("unexpected_blob_created_since_snapshot");
    expect(fake.creates).toHaveLength(1);
  });
  it("preserves an existing matching blob at its frozen generation", async () => {
    const baseline = { exists: true, generation: "802", sha256: publicationHash(raw) }, fake = blobs(baseline);
    await ensureTechnicalSourceBlob(fake.store, source(), raw, baseline, run);
    expect(fake.creates).toHaveLength(0); expect(fake.get()).toEqual(baseline);
  });
  it("rejects a changed generation even when its bytes match", async () => {
    const baseline = { exists: true, generation: "802", sha256: publicationHash(raw) };
    const fake = blobs({ ...baseline, generation: "803" });
    await expect(ensureTechnicalSourceBlob(fake.store, source(), raw, baseline, run)).rejects.toThrow("source_blob_changed_since_fixed_snapshot");
    expect(fake.creates).toHaveLength(0);
  });
  it("rejects an upload whose downloaded hash differs from the pinned raw body", async () => {
    const fake = blobs();
    fake.store.createIfAbsent = async (_path, _bytes, _media, owner) => {
      fake.set({ exists: true, generation: "1001", sha256: "d".repeat(64), owner });
    };
    await expect(ensureTechnicalSourceBlob(fake.store, source(), raw, absent, run)).rejects.toThrow("uploaded_source_blob_hash_or_generation_verification_failed");
  });
  it("handles a generation-zero race only if the winner has this exact run's ownership marker", async () => {
    const fake = blobs(); fake.store.createIfAbsent = async () => {
      fake.set({ exists: true, generation: "1002", sha256: publicationHash(raw), owner: {} });
    };
    await expect(ensureTechnicalSourceBlob(fake.store, source(), raw, absent, run)).rejects.toThrow("uploaded_source_blob_hash_or_generation_verification_failed");
  });
});

describe("bounded source and index binding", () => {
  it("re-evaluates actual time and cannot freeze stale evidence with candidate checkedAt", () => {
    expect(() => prepareTechnicalSource(item(), candidate(), raw, now + 86400000)).toThrow("source_not_technically_eligible_or_runtime_incompatible");
  });
  it("rejects swapped raw bytes even if a caller supplies eligible-looking text", () => {
    expect(() => prepareTechnicalSource(item(), candidate(), Buffer.from("%PDF-1.7\nDIFFERENT"), now)).toThrow("candidate_raw_source_binding_mismatch");
  });
  it("rejects an incomplete page and a runtime budget overflow instead of clipping", () => {
    const input = candidate(); input.pages.pop();
    expect(() => prepareTechnicalSource(item(), input, raw, now)).toThrow("source_not_technically_eligible_or_runtime_incompatible");
    const oversized = candidate(), prefix = oversized.pages[0].text;
    const text = prefix + "完整合成條件甲乙丙丁。".repeat(2200);
    oversized.numPages = 2;
    oversized.pages = [1, 2].map((page) => ({ page, text: text.slice(0, 12000), independentText: text.slice(0, 12000), hasLargeUnverifiedImage: false, hasUnverifiedStructure: false }));
    expect(() => prepareTechnicalSource(item(), oversized, raw, now)).toThrow("source_not_technically_eligible_or_runtime_incompatible");
  });
  it("loads and re-evaluates an exact source/index-bound synthetic batch offline", async () => {
    const fixture = await batchFixture();
    const result = await loadPublicationBatch(fixture.manifestPath, now);
    expect(result.loaded).toHaveLength(1); expect(result.loaded[0].source.assessment.status).toBe("technically_eligible");
    expect(result.loaded[0].source.rawVerification?.method).toBe("html_raw_dom_reparse_v4");
    expect(result.loaded[0].source.draft.chunks[0].text).toContain("合成條件\t合成例外\n甲\t乙");
  });
  it("rejects fabricated candidate text even with genuine raw SHA and an updated manifest hash", async () => {
    const fixture = await batchFixture();
    fixture.input.pages[0].text = fixture.input.pages[0].text.replace("真正原始檔的完整文字", "編造來源與不同敘述內容");
    fixture.input.htmlEvidence!.canonicalTextSha256 = publicationHash(fixture.input.pages[0].text);
    const bytes = Buffer.from(JSON.stringify(fixture.input));
    await writeFile(join(fixture.path, "candidate.json"), bytes);
    fixture.manifest.items[0].candidateInputSha256 = publicationHash(bytes);
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("candidate_html_pages_do_not_match_raw_source");
  });
  it("fails closed when the raw verifier runtime is unavailable", async () => {
    const fixture = await batchFixture();
    await expect(loadPublicationBatch(fixture.manifestPath, now, { python: join(fixture.path, "missing-python-executable") }))
      .rejects.toThrow("raw_html_verification_helper_unavailable_or_failed");
  });
  it("derives image flags from actual HTML rather than trusting the candidate's false declarations", async () => {
    const fixture = await batchFixture();
    const changed = Buffer.from(fixture.sourceRaw.toString().replace("<table>", '<img src="source-only-warning.png" alt=""><table>'));
    fixture.input.fetched.sha256 = publicationHash(changed); fixture.input.fetched.bytes = changed.length;
    const candidateBytes = Buffer.from(JSON.stringify(fixture.input));
    await writeFile(join(fixture.path, "source.html"), changed); await writeFile(join(fixture.path, "candidate.json"), candidateBytes);
    fixture.manifest.items[0].rawSourceSha256 = publicationHash(changed);
    fixture.manifest.items[0].candidateInputSha256 = publicationHash(candidateBytes);
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("candidate_html_pages_do_not_match_raw_source");
  });
  it("rejects fake PDF bytes even when their hash and eligible-looking candidate text agree", async () => {
    const fixture = await batchFixture(), pdfInput = candidate();
    const encoded = Buffer.from(JSON.stringify(pdfInput));
    await writeFile(join(fixture.path, "candidate.json"), encoded); await writeFile(join(fixture.path, "source.pdf"), raw);
    fixture.manifest.items[0] = { ...item(), candidateInputSha256: publicationHash(encoded) };
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("raw_pdf_verification_engine_unavailable_or_failed");
  });
  it("rejects candidate file edits after the explicit manifest was fixed", async () => {
    const fixture = await batchFixture(); await writeFile(join(fixture.path, "candidate.json"), "{}");
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("candidate_input_hash_mismatch");
  });
  it("rejects a self-consistent candidate that changes current product identity outside the raw index", async () => {
    const fixture = await batchFixture(); fixture.input.catalogRows[0].nameZh = "另一個合成品名";
    const bytes = Buffer.from(JSON.stringify(fixture.input)); await writeFile(join(fixture.path, "candidate.json"), bytes);
    fixture.manifest.items[0].candidateInputSha256 = publicationHash(bytes);
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("candidate_current_official_index_binding_mismatch");
  });
  it.each(["原料藥", "製劑原料", "自用製劑原料"])("rejects official raw category %s even when source text and candidate claim a patient category", async (category) => {
    const fixture = await batchFixture();
    fixture.input.officialCategory = "合成處方藥";
    const candidateBytes = Buffer.from(JSON.stringify(fixture.input));
    await writeFile(join(fixture.path, "candidate.json"), candidateBytes);
    fixture.manifest.items[0].candidateInputSha256 = publicationHash(candidateBytes);
    const rows = JSON.parse(await readFile(join(fixture.path, "info36.json"), "utf8"));
    rows[0]["藥品類別"] = category;
    const rawIndex = Buffer.from(JSON.stringify(rows));
    const evidence = JSON.parse(await readFile(join(fixture.path, "evidence36.json"), "utf8"));
    evidence.jsonSha256 = publicationHash(rawIndex); evidence.jsonBytes = rawIndex.length;
    const evidenceBytes = Buffer.from(JSON.stringify(evidence));
    await writeFile(join(fixture.path, "info36.json"), rawIndex);
    await writeFile(join(fixture.path, "evidence36.json"), evidenceBytes);
    fixture.manifest.indexSnapshots[0].sha256 = publicationHash(rawIndex);
    fixture.manifest.indexSnapshots[0].evidenceSha256 = publicationHash(evidenceBytes);
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("official_raw_material_source_not_patient_leaflet");
  });
  it("rejects index/evidence tampering rather than trusting embedded candidate claims", async () => {
    const fixture = await batchFixture(); await writeFile(join(fixture.path, "info39.json"), "[]");
    await expect(loadPublicationBatch(fixture.manifestPath, now)).rejects.toThrow("official_index_or_evidence_hash_mismatch");
  });
  it("requires both official indexes, explicit target and <=50 unique complete licenses", async () => {
    const { manifest } = await batchFixture();
    expect(() => validatePublicationManifest({ ...manifest, project: "another-project" })).toThrow("explicit_fixed_publication_target_required");
    expect(() => validatePublicationManifest({ ...manifest, indexSnapshots: [manifest.indexSnapshots[0]] })).toThrow("both_current_official_indexes_required");
    expect(() => validatePublicationManifest({ ...manifest, items: Array(51).fill(manifest.items[0]) })).toThrow("publication_batch_must_have_1_to_50_items");
    expect(() => validatePublicationManifest({ ...manifest, items: [manifest.items[0], manifest.items[0]] })).toThrow("duplicate_complete_license_in_batch");
  });
  it("has an offline default even when a cloud environment is unusable", async () => {
    const fixture = await batchFixture(), realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--manifest", fixture.manifestPath]);
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({ cloudCalls: 0, cloudWrites: 0, aiCalls: 0, clinicalReviewed: false });
    expect(realNow).toBeTypeOf("function");
  });
  it("contains no application runtime, .env loader or model imports", async () => {
    const code = await readFile(new URL("../tools/publish-tfda-sources.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/from\s+["'][^"']*(?:server\/|domain|dotenv|openai)[^"']*["']/u);
    expect(code).not.toMatch(/dotenv\.(?:config|load)|--env-file|import\(["'][^"']*(?:server\/|openai|domain)/u);
  });
});

describe("publication mutation allowlists", () => {
  it.each(["users", "settings", "quotas", "jobs", "healthCollections", "medications", "recognitionUsage"])("refuses %s writes", (collection) => {
    expect(() => assertPublicationWrite(collection, "a".repeat(64))).toThrow("technical_publication_write_allowlist_violation");
  });
  it.each(["leaflets/../settings/catalog", "users/a.pdf", "leaflets/not-a-hash.pdf", "leaflets/" + "a".repeat(64) + ".json"])("refuses blob path %s", (path) => {
    expect(() => assertPublicationBlob(path)).toThrow("technical_publication_blob_allowlist_violation");
  });
  it("permits only exact source blob names and hashed publication document ids", () => {
    expect(() => assertPublicationBlob("leaflets/" + "a".repeat(64) + ".pdf")).not.toThrow();
    expect(() => assertPublicationWrite("published", "a/b")).toThrow("technical_publication_write_allowlist_violation");
  });
});

describe("live-metadata authenticated catalog cache", () => {
  const bytes = Buffer.from(JSON.stringify([{ licenseNo: license, nameZh }]));
  const live = { version: publicationHash(bytes).slice(0, 16), generation: "10827",
    md5Hash: createHash("md5").update(bytes).digest("base64"), size: String(bytes.length), count: 1 };
  it("accepts raw cache bytes only when live MD5, size, SHA version and count all agree", () => {
    expect(verifyCachedCatalog(bytes, live)).toEqual({ rows: [{ licenseNo: license, nameZh }], sha256: publicationHash(bytes) });
    expect(catalogCacheFilename(live)).toMatch(new RegExp(`^${live.version}-${live.generation}-[a-f0-9]{32}\\.json$`));
  });
  it("rejects changed cache bytes despite an authentic-looking file name", () => {
    const changed = Buffer.from(bytes); changed[changed.length - 3] ^= 1;
    expect(changed.length).toBe(bytes.length); expect(verifyCachedCatalog(changed, live)).toBeNull();
  });
  it("does not reuse a stale generation's cache entry after live generation changes", () => {
    const oldKey = catalogCacheFilename(live)!, nextKey = catalogCacheFilename({ ...live, generation: "10828" })!;
    const files = new Map([[oldKey, bytes]]);
    expect(nextKey).not.toBe(oldKey); expect(files.get(nextKey)).toBeUndefined();
  });
  it("rejects a cache whose MD5 differs from live metadata", () => {
    const differentMd5 = createHash("md5").update("other synthetic body").digest("base64");
    expect(verifyCachedCatalog(bytes, { ...live, md5Hash: differentMd5 })).toBeNull();
    expect(catalogCacheFilename({ ...live, md5Hash: differentMd5 })).not.toBe(catalogCacheFilename(live));
  });
  it.each([
    { version: "f".repeat(16) }, { count: 2 }, { size: String(bytes.length + 1) },
    { md5Hash: null }, { md5Hash: "not-a-valid-live-md5" }, { generation: "../other" },
  ])("rejects inconsistent or unverifiable live metadata %j", (change) => {
    expect(verifyCachedCatalog(bytes, { ...live, ...change })).toBeNull();
  });
  it("does not parse invalid JSON merely because byte hashes match live metadata", () => {
    const invalid = Buffer.from("synthetic invalid JSON");
    expect(verifyCachedCatalog(invalid, { ...live, version: publicationHash(invalid).slice(0, 16),
      md5Hash: createHash("md5").update(invalid).digest("base64"), size: invalid.length })).toBeNull();
  });
});
