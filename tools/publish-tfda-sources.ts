/** Explicit <=50-source publisher. Default is offline. Never loads .env, AI or Domain. */
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { TfdaSourceInput } from "./tfda-source-core.js";
import { hasSingleOfficialManufacturingProduct } from "./tfda-manufacturing-roles.js";
import { verifyCandidateFromRaw } from "./tfda-candidate-verification.js";
import { deriveSerialPaperPdf, verifyParentPaperSource, verifyParentPaperEquivalentSources } from "./tfda-parent-paper-verification.js";
import {
  TFDA_PROTECTED_LICENSES, TFDA_PUBLICATION_ACTOR, TFDA_PUBLICATION_BUCKET,
  TFDA_PUBLICATION_PROJECT, applyTechnicalPublication, ensureTechnicalSourceBlob, assertFreshTimestamp,
  assertPublicationBlob, assertPublicationWrite, assertOfficialPatientCategory, assertTechnicalPublicationSize, canonicalDocument, catalogCacheFilename, verifyCachedCatalog,
  inspectTechnicalPublication, prepareTechnicalSource, publicationHash,
  publicationRequire as must, safePublicationFailure, sameDocument, technicalAuditId,
  validatePublicationManifest, type PreparedTechnicalSource,
  type PublicationBefore, type PublicationDoc, type PublicationManifest,
  type PublicationRun, type PublicationStore, type TechnicalBlobState, type TechnicalBlobStore,
} from "./tfda-publication-core.js";

async function boundedRead(path: string, limit: number) {
  must((await stat(path)).size <= limit, "input_file_exceeds_size_limit");
  const bytes = await readFile(path);
  must(bytes.length <= limit, "input_file_exceeds_size_limit");
  return bytes;
}
const json = (bytes: Buffer) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const official = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      (url.hostname === "fda.gov.tw" || url.hostname.endsWith(".fda.gov.tw"));
  } catch { return false; }
};
function catalogRows(raw: PublicationDoc[], license: string) {
  return raw.filter((r) => r["許可證字號"] === license).map((r) => ({
    licenseNo: String(r["許可證字號"] || ""), nameZh: String(r["中文品名"] || ""),
    nameEn: String(r["英文品名"] || ""), form: String(r["劑型"] || ""),
    manufacturer: String(r["製造商名稱"] || ""), effectiveUntil: String(r["有效日期"] || ""),
    revoked: !!String(r["註銷狀態"] || "").trim(),
  }));
}
function indexRows(raw: PublicationDoc[], license: string) {
  return raw.filter((r) => r["許可證字號"] === license).map((r) => ({
    licenseNo: String(r["許可證字號"] || ""), nameZh: String(r["中文品名"] || ""),
    nameEn: String(r["英文品名"] || ""),
    urls: String(r["仿單圖檔連結"] || "").match(/https?:\/\/[^\s;<>"\u3000]+/gu) || [],
  }));
}
export async function loadPublicationBatch(manifestPath: string, now = Date.now(), verificationOptions: { python?: string; parentPaperMode?: "strict-v2" | "byte-equivalent-v1" } = {}) {
  const path = resolve(manifestPath), bytes = await boundedRead(path, 2_000_000);
  const manifest = json(bytes);
  validatePublicationManifest(manifest);
  const pathFromManifest = (file: string) => isAbsolute(file) ? file : resolve(dirname(path), file);
  const indexes = new Map<number, { rows: PublicationDoc[]; evidence: PublicationDoc }>();
  for (const item of manifest.indexSnapshots) {
    const raw = await boundedRead(pathFromManifest(item.path), 150_000_000);
    const evidenceBytes = await boundedRead(pathFromManifest(item.evidencePath), 200_000);
    must(publicationHash(raw) === item.sha256 && publicationHash(evidenceBytes) === item.evidenceSha256,
      "official_index_or_evidence_hash_mismatch");
    const evidence = json(evidenceBytes);
    must(evidence.infoId === item.infoId && evidence.jsonSha256 === item.sha256 &&
      evidence.jsonBytes === raw.length && evidence.httpStatus === 200 &&
      official(evidence.requestedUrl) && official(evidence.finalUrl) &&
      Array.isArray(evidence.redirects) && evidence.redirects.every((hop: any) => official(hop.fromUrl) && official(hop.toUrl)),
      "official_index_provenance_invalid");
    if (evidence.legacyBlockedRedirect)
      must(evidence.legacyBlockedRedirect.followed === false, "nonhttps_legacy_index_redirect_was_followed");
    assertFreshTimestamp(evidence.retrievedAt, now, "official_index_older_than_24_hours");
    const rows = json(raw);
    must(Array.isArray(rows) && rows.length === evidence.rows, "official_index_row_count_mismatch");
    indexes.set(item.infoId, { rows, evidence });
  }
  const loaded: { source: PreparedTechnicalSource; raw: Buffer; parentRaw?: Buffer }[] = [];
  for (const item of manifest.items) {
    const inputBytes = await boundedRead(pathFromManifest(item.candidateInputPath), 2_000_000);
    must(publicationHash(inputBytes) === item.candidateInputSha256, "candidate_input_hash_mismatch");
    const input = json(inputBytes) as TfdaSourceInput;
    // Caller claims remain rejected by default. Only explicit strict parent mode
    // may derive association evidence by reparsing independently pinned raw bytes.
    const hasParentClaim = Object.hasOwn(input, "officialAssociation");
    must(!hasParentClaim || ["strict-v2", "byte-equivalent-v1"].includes(verificationOptions.parentPaperMode || "") && !!item.parentSource && !!input.officialAssociation,
      "unverified_parent_association_not_supported");
    must(!item.parentSource || hasParentClaim, "parent_source_requires_explicit_association");
    const catalog = indexes.get(36)!, index = indexes.get(39)!;
    if (Object.hasOwn(input, "catalogManufacturingRecords")) {
      const records = catalog.rows.filter((row) => row["許可證字號"] === item.fullLicense);
      must(sameDocument(input.catalogManufacturingRecords, records) &&
        hasSingleOfficialManufacturingProduct(item.fullLicense, input.catalogRows, records),
        "candidate_official_manufacturing_records_binding_mismatch");
    }
    must(input.catalogCheckedAt === catalog.evidence.retrievedAt && input.indexCheckedAt === index.evidence.retrievedAt &&
      sameDocument(input.catalogRows, catalogRows(catalog.rows, item.fullLicense)) &&
      sameDocument(input.indexRows, indexRows(index.rows, item.fullLicense)), "candidate_current_official_index_binding_mismatch");
    assertOfficialPatientCategory(catalog.rows, item.fullLicense, input.officialCategory);
    let parentRaw: Buffer | undefined, parentVerification: PreparedTechnicalSource["parentVerification"];
    if (hasParentClaim) {
      must(input.format === "pdf", "parent_paper_child_must_be_pdf");
      const parentPath = pathFromManifest(item.parentSource!.rawSourcePath);
      parentRaw = await boundedRead(parentPath, 15_000_000);
      if (verificationOptions.parentPaperMode === "byte-equivalent-v1") {
        must(item.parentSource!.currentEquivalentSources, "explicit_equivalent_current_sources_required");
        const parent = { ...item.parentSource!, currentEquivalentSources: item.parentSource!.currentEquivalentSources.map((alias) => ({
          ...alias, rawSourcePath: pathFromManifest(alias.rawSourcePath), rawMetadataPath: pathFromManifest(alias.rawMetadataPath),
        })) };
        parentVerification = (await verifyParentPaperEquivalentSources(parent, input, parentPath, parentRaw, catalog.rows, index.rows,
          manifest.indexSnapshots, { python: verificationOptions.python, now })).proof;
      } else {
        must(!item.parentSource!.currentEquivalentSources, "equivalent_sources_require_explicit_new_parent_mode");
        parentVerification = (await verifyParentPaperSource(item.parentSource!, input, parentPath, parentRaw, catalog.rows, index.rows,
          manifest.indexSnapshots, { python: verificationOptions.python, now })).proof;
      }
    }
    const raw = await boundedRead(pathFromManifest(item.rawSourcePath), 15_000_000);
    const source = prepareTechnicalSource(item, input, raw, now);
    if (parentVerification) {
      const derived = await deriveSerialPaperPdf(pathFromManifest(item.rawSourcePath), raw, verificationOptions);
      must(input.numPages === derived.numPages && sameDocument(input.pages, derived.pages), "candidate_parent_paper_pdf_pages_do_not_match_raw");
      source.rawVerification = derived.rawVerification; source.parentVerification = parentVerification;
      assertTechnicalPublicationSize(source);
    } else source.rawVerification = await verifyCandidateFromRaw(pathFromManifest(item.rawSourcePath), raw, input, verificationOptions);
    assertTechnicalPublicationSize(source);
    loaded.push({ source, raw, ...(parentRaw ? { parentRaw } : {}) });
  }
  return { path, manifest: manifest as PublicationManifest, manifestSha256: publicationHash(bytes), indexes, loaded };
}
type Batch = Awaited<ReturnType<typeof loadPublicationBatch>>;
interface ProtectedDocument {
  licenseNo: string; pointerId: string; pointer: PublicationDoc; leafletId: string; leaflet: PublicationDoc;
}
interface PublicationOperation {
  fullLicense: string; leafletId: string; candidateInputSha256: string; rawSourceSha256: string;
  draftSha256: string; assessmentSha256: string;
  rawVerificationSha256: string;
  decision: string; reason: string; before: PublicationBefore; blobBefore: TechnicalBlobState | null;
  parentVerificationSha256?: string; parentBlobBefore?: TechnicalBlobState | null;
}
interface PublicationSnapshot {
  schema: "tfda-source-publication-snapshot/v1";
  inspectedAt: string; runId: string; batchId: string; manifestSha256: string;
  project: string; bucket: string; indexSnapshots: PublicationManifest["indexSnapshots"];
  catalog: { settings: PublicationDoc; blobPath: string; blobSha256: string; generation: string; md5Hash: string | null; bytes: number; rows: number };
  protectedDocuments: ProtectedDocument[]; operations: PublicationOperation[];
  clinicalReviewed: false; cloudWrites: 0; aiCalls: 0;
}
function assertCloudTarget(options: Record<string, string>) {
  must(options["--project"] === TFDA_PUBLICATION_PROJECT && options["--bucket"] === TFDA_PUBLICATION_BUCKET &&
    !!options["--snapshot"], "explicit_fixed_project_bucket_and_snapshot_required");
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT", "CLOUDSDK_CORE_PROJECT"])
    must(!process.env[key] || process.env[key] === TFDA_PUBLICATION_PROJECT, "incompatible_project_environment");
  must(!process.env.STORAGE_BUCKET || process.env.STORAGE_BUCKET === TFDA_PUBLICATION_BUCKET, "incompatible_bucket_environment");
  must(!process.env.APP_MODE || process.env.APP_MODE === "firebase", "incompatible_application_environment");
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST"])
    must(!process.env[key], "emulator_environment_forbidden");
}
function normalizedName(value: string) { return value.normalize("NFKC").replace(/\s/gu, ""); }
function cloudCatalogCurrent(source: PreparedTechnicalSource, cloudRows: PublicationDoc[]) {
  const current = cloudRows.filter((r) => r.licenseNo === source.draft.licenseNo);
  const fresh = source.input.catalogRows[0];
  return current.length === 1 && current[0].revoked === false &&
    ["nameZh", "nameEn", "form"].every((field) => typeof current[0][field] === "string" &&
      normalizedName(current[0][field]) === normalizedName((fresh as any)[field]));
}
async function cloudMain(mode: string, options: Record<string, string>, batch: Batch) {
  assertCloudTarget(options);
  const snapshotPath = resolve(options["--snapshot"]);
  let snapshot: PublicationSnapshot | undefined, snapshotSha256: string | undefined;
  if (mode === "apply") {
    must(options["--manifest-sha256"] === batch.manifestSha256 && /^[a-f0-9]{64}$/.test(options["--snapshot-sha256"] || ""),
      "apply_requires_exact_manifest_and_snapshot_hashes");
    const bytes = await boundedRead(snapshotPath, 10_000_000);
    snapshotSha256 = publicationHash(bytes);
    must(snapshotSha256 === options["--snapshot-sha256"], "fixed_snapshot_hash_mismatch");
    snapshot = json(bytes);
    must(snapshot?.schema === "tfda-source-publication-snapshot/v1" && snapshot.manifestSha256 === batch.manifestSha256 &&
      snapshot.batchId === batch.manifest.batchId && snapshot.project === TFDA_PUBLICATION_PROJECT && snapshot.bucket === TFDA_PUBLICATION_BUCKET &&
      sameDocument(snapshot.indexSnapshots, batch.manifest.indexSnapshots), "fixed_snapshot_batch_binding_mismatch");
    assertFreshTimestamp(snapshot.inspectedAt, Date.now(), "cloud_snapshot_older_than_24_hours");
    must(Array.isArray(snapshot.operations) && snapshot.operations.length === batch.loaded.length &&
      snapshot.operations.every((op, i) => op.fullLicense === batch.loaded[i].source.draft.licenseNo &&
        op.leafletId === batch.loaded[i].source.draft.id && op.candidateInputSha256 === batch.loaded[i].source.item.candidateInputSha256 &&
        op.rawSourceSha256 === batch.loaded[i].source.item.rawSourceSha256 &&
        op.draftSha256 === publicationHash(JSON.stringify(batch.loaded[i].source.draft)) &&
        op.assessmentSha256 === publicationHash(JSON.stringify(batch.loaded[i].source.assessment)) &&
        op.rawVerificationSha256 === publicationHash(JSON.stringify(batch.loaded[i].source.rawVerification)) &&
        op.parentVerificationSha256 === (batch.loaded[i].source.parentVerification ? publicationHash(JSON.stringify(batch.loaded[i].source.parentVerification)) : undefined)), "fixed_snapshot_source_binding_mismatch");
    must(!snapshot.operations.some((op) => op.decision === "conflict"), "fixed_snapshot_has_publication_conflict");
  }
  // Dynamic SDK imports start only after offline validation and explicit target checks.
  const { initializeApp, applicationDefault, getApps, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  must(getApps().length === 0, "preexisting_firebase_app_forbidden");
  const app = initializeApp({ credential: applicationDefault(), projectId: TFDA_PUBLICATION_PROJECT, storageBucket: TFDA_PUBLICATION_BUCKET });
  const db = getFirestore(app), bucket = getStorage(app).bucket(TFDA_PUBLICATION_BUCKET);
  const ref = (collection: string, id: string) => {
    assertPublicationWrite(collection, id);
    return db.collection(collection).doc(id);
  };
  async function getMany(requests: [string, string][]) {
    if (!requests.length) return [];
    const docs = await db.getAll(...requests.map(([collection, id]) => ref(collection, id)));
    return docs.map((doc) => doc.exists ? canonicalDocument(doc.data()) as PublicationDoc : null);
  }
  async function protectedState(): Promise<ProtectedDocument[]> {
    const pointers = await getMany(TFDA_PROTECTED_LICENSES.map((license) => ["published", publicationHash(license)]));
    must(pointers.every((p) => p && /^[a-f0-9]{64}$/.test(p.leafletId || "")), "protected_eight_publication_missing");
    const leaflets = await getMany(pointers.map((p) => ["leaflets", p!.leafletId]));
    return TFDA_PROTECTED_LICENSES.map((licenseNo, i) => {
      const pointer = pointers[i]!, leaflet = leaflets[i];
      must(leaflet?.licenseNo === licenseNo && leaflet.status === "published" && leaflet.version === pointer.version,
        "protected_eight_publication_inconsistent");
      return { licenseNo, pointerId: publicationHash(licenseNo), pointer, leafletId: pointer.leafletId, leaflet };
    });
  }
  async function readCatalog() {
    const doc = await db.collection("settings").doc("catalog").get();
    must(doc.exists, "cloud_catalog_settings_missing");
    const settings = canonicalDocument(doc.data()) as PublicationDoc;
    must(/^catalog\/[a-f0-9]{16}\.json$/.test(settings.path || "") && /^[a-f0-9]{16}$/.test(settings.version || "") &&
      settings.path === `catalog/${settings.version}.json`, "cloud_catalog_blob_path_invalid");
    const file = bucket.file(settings.path), [metadata] = await file.getMetadata();
    must(Number(metadata.size) > 0 && Number(metadata.size) <= 150_000_000 && /^[1-9]\d{0,30}$/.test(String(metadata.generation)), "cloud_catalog_size_or_generation_invalid");
    const live = { version: settings.version, generation: String(metadata.generation), md5Hash: metadata.md5Hash || null,
      size: String(metadata.size), count: settings.count };
    const filename = catalogCacheFilename(live), cacheFolder = options["--catalog-cache"] && resolve(options["--catalog-cache"]);
    const cachePath = cacheFolder && filename ? resolve(cacheFolder, filename) : null;
    let bytes: Buffer | undefined, verified: ReturnType<typeof verifyCachedCatalog> = null, cacheHit = false;
    if (cachePath) {
      try {
        const cachedBytes = await boundedRead(cachePath, 150_000_000);
        verified = verifyCachedCatalog(cachedBytes, live);
        if (verified) { bytes = cachedBytes; cacheHit = true; }
      } catch (error) {
        if ((error as any)?.code !== "ENOENT" && (error as Error)?.message !== "input_file_exceeds_size_limit") throw error;
      }
    }
    if (!bytes) {
      [bytes] = await bucket.file(settings.path, { generation: live.generation }).download({ validation: "crc32c" });
      if (live.md5Hash) {
        verified = verifyCachedCatalog(bytes, live);
        must(verified, "downloaded_catalog_live_md5_sha_or_count_mismatch");
      }
      if (cachePath && verified) {
        await mkdir(cacheFolder!, { recursive: true });
        const temporary = cachePath + ".tmp-" + randomUUID();
        try {
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await rename(temporary, cachePath);
        } finally {
          await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
      }
    }
    const hash = verified?.sha256 || publicationHash(bytes), rows = verified?.rows || json(bytes);
    must(bytes.length === Number(metadata.size) && hash.startsWith(settings.version) && Array.isArray(rows) && rows.length === settings.count,
      "cloud_catalog_hash_or_count_mismatch");
    return { settings, blobPath: settings.path, blobSha256: hash, generation: live.generation, md5Hash: live.md5Hash,
      bytes: bytes.length, rows: rows.length, records: rows as PublicationDoc[], cacheHit };
  }
  async function blobState(source: PreparedTechnicalSource): Promise<TechnicalBlobState> {
    assertPublicationBlob(source.draft.storagePath);
    const file = bucket.file(source.draft.storagePath);
    try {
      const [metadata] = await file.getMetadata();
      must(Number(metadata.size) > 0 && Number(metadata.size) <= 15_000_000 && /^[1-9]\d{0,30}$/.test(String(metadata.generation)), "existing_source_blob_size_or_generation_invalid");
      const [bytes] = await bucket.file(source.draft.storagePath, { generation: String(metadata.generation) }).download({ validation: "crc32c" });
      must(publicationHash(bytes) === source.draft.sha256, "existing_source_blob_content_conflict");
      return { exists: true, generation: String(metadata.generation), sha256: publicationHash(bytes), owner: canonicalDocument(metadata.metadata || {}) };
    } catch (error) {
      if ((error as any)?.code !== 404) throw error;
      return { exists: false, generation: null, sha256: null };
    }
  }
  // This projection is used only by the create-only blob helper, never written as a leaflet document.
  const parentBlobSource = (source: PreparedTechnicalSource): PreparedTechnicalSource => {
    const proof = source.parentVerification!;
    return { ...source, draft: { ...source.draft, id: proof.parentStoragePath.slice(9, -5), sha256: proof.parentRawSha256,
      storagePath: proof.parentStoragePath, sourceMediaType: "text/html" } };
  };
  const blobStore: TechnicalBlobStore = { state: blobState,
    createIfAbsent: async (path, bytes, mediaType, owner, precondition) => {
      assertPublicationBlob(path);
      try { await bucket.file(path).save(bytes, { resumable: false, validation: "crc32c", preconditionOpts: precondition,
        metadata: { contentType: mediaType, metadata: owner } }); }
      catch (error) { if ((error as any)?.code !== 412) throw error; }
    } };
  try {
    await mkdir(dirname(snapshotPath), { recursive: true });
    // Snapshot creation is exclusive (wx); cloud writes use generation-zero and transaction create/CAS.
    // No persistent local lock can strand a run after a process crash. Journals are append-only diagnostics;
    // exact Firestore ownership markers, never journal presence, determine recovery.
    const catalog = await readCatalog(), protectedDocuments = await protectedState();
    if (mode === "inspect") {
      const runId = randomUUID();
      const requests = batch.loaded.flatMap(({ source }) => [
        ["leaflets", source.draft.id], ["published", publicationHash(source.draft.licenseNo)],
        ["audit", technicalAuditId(runId, source.draft.id)],
      ] as [string, string][]);
      const docs = await getMany(requests), operations: PublicationOperation[] = [];
      for (let i = 0; i < batch.loaded.length; i++) {
        const { source } = batch.loaded[i], before = { leaflet: docs[i * 3], pointer: docs[i * 3 + 1], audit: docs[i * 3 + 2] };
        const inspection = inspectTechnicalPublication(source, before);
        const state = inspection.decision === "skip_protected_publication" || cloudCatalogCurrent(source, catalog.records)
          ? inspection : { decision: "skip_catalog_not_current", reason: "cloud_catalog_missing_revoked_or_current_name_form_mismatch" };
        operations.push({ fullLicense: source.draft.licenseNo, leafletId: source.draft.id,
          candidateInputSha256: source.item.candidateInputSha256, rawSourceSha256: source.item.rawSourceSha256,
          draftSha256: publicationHash(JSON.stringify(source.draft)), assessmentSha256: publicationHash(JSON.stringify(source.assessment)),
          rawVerificationSha256: publicationHash(JSON.stringify(source.rawVerification)),
          ...state, before, blobBefore: state.decision === "create" ? await blobState(source) : null,
          ...(source.parentVerification ? { parentVerificationSha256: publicationHash(JSON.stringify(source.parentVerification)),
            parentBlobBefore: state.decision === "create" ? await blobState(parentBlobSource(source)) : null } : {}) });
      }
      const { records: _records, cacheHit: _cacheHit, ...catalogSnapshot } = catalog;
      const output: PublicationSnapshot = { schema: "tfda-source-publication-snapshot/v1", inspectedAt: new Date().toISOString(),
        runId, batchId: batch.manifest.batchId, manifestSha256: batch.manifestSha256,
        project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET, indexSnapshots: batch.manifest.indexSnapshots,
        catalog: catalogSnapshot, protectedDocuments, operations, clinicalReviewed: false, cloudWrites: 0, aiCalls: 0 };
      const encoded = Buffer.from(JSON.stringify(output, null, 2) + "\n");
      await writeFile(snapshotPath, encoded, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ status: "cloud_readonly_snapshot_created", snapshot: snapshotPath, snapshotSha256: publicationHash(encoded),
        manifestSha256: batch.manifestSha256, items: operations.map((op) => ({ fullLicense: op.fullLicense, decision: op.decision, reason: op.reason })),
        protectedExistingPublications: protectedDocuments.length, catalogCacheHit: catalog.cacheHit, cloudWrites: 0, aiCalls: 0 }));
      return;
    }
    must(snapshot && snapshotSha256, "fixed_snapshot_required");
    const { records: _records, cacheHit: _cacheHit, ...catalogNow } = catalog;
    must(sameDocument(catalogNow, snapshot.catalog), "cloud_catalog_changed_since_fixed_snapshot");
    must(sameDocument(protectedDocuments, snapshot.protectedDocuments), "protected_existing_publications_changed_before_apply");
    const run: PublicationRun = { runId: snapshot.runId, batchId: snapshot.batchId, manifestSha256: batch.manifestSha256, snapshotSha256 };
    const journal = async (value: PublicationDoc) => appendFile(snapshotPath + ".apply-journal.ndjson",
      JSON.stringify({ at: new Date().toISOString(), runId: run.runId, manifestSha256: run.manifestSha256, snapshotSha256, ...value }) + "\n",
      { encoding: "utf8", mode: 0o600, flush: true });
    const store: PublicationStore = { transaction: (operation) => db.runTransaction(async (transaction) => {
      const currentCatalog = await transaction.get(db.collection("settings").doc("catalog"));
      must(currentCatalog.exists && sameDocument(currentCatalog.data(), snapshot!.catalog.settings), "cloud_catalog_changed_during_apply");
      return operation({
        get: async (collection, id) => {
          const document = await transaction.get(ref(collection, id));
          return document.exists ? canonicalDocument(document.data()) : null;
        },
        create: (collection, id, data) => { transaction.create(ref(collection, id), data); },
      });
    }) };
    const results: PublicationDoc[] = [];
    try {
      for (let i = 0; i < batch.loaded.length; i++) {
        const { source: loadedSource, raw, parentRaw } = batch.loaded[i], op = snapshot.operations[i];
        const source = prepareTechnicalSource(loadedSource.item, loadedSource.input, raw);
        source.rawVerification = loadedSource.rawVerification;
        source.parentVerification = loadedSource.parentVerification;
        if (op.decision.startsWith("skip_")) {
          results.push({ fullLicense: op.fullLicense, status: op.decision, reason: op.reason });
          await journal(results.at(-1)!);
          continue;
        }
        must(op.decision === "create" || op.decision === "same_source_no_op", "unsupported_snapshot_publication_decision");
        if (op.decision === "create") {
          must(op.blobBefore !== null && cloudCatalogCurrent(source, catalog.records), "snapshot_blob_or_catalog_binding_missing");
          if (source.parentVerification) {
            must(parentRaw && op.parentBlobBefore, "snapshot_verified_parent_blob_binding_missing");
            const verifiedParent = await ensureTechnicalSourceBlob(blobStore, parentBlobSource(source), parentRaw, op.parentBlobBefore, run);
            await journal({ fullLicense: op.fullLicense, phase: "parent_blob_verified", generation: verifiedParent.generation, sha256: verifiedParent.sha256 });
          }
          const verified = await ensureTechnicalSourceBlob(blobStore, source, raw, op.blobBefore, run);
          await journal({ fullLicense: op.fullLicense, phase: "blob_verified", generation: verified.generation, sha256: verified.sha256 });
        }
        const status = await applyTechnicalPublication(store, source, op.before, run);
        const result = { fullLicense: op.fullLicense, leafletId: op.leafletId, status };
        results.push(result);
        await journal({ ...result, phase: "transaction_reconciled" });
      }
    } finally {
      must(sameDocument(await protectedState(), snapshot.protectedDocuments), "protected_existing_publications_changed_after_apply");
      await journal({ phase: "protected_eight_exact_metadata_and_pointers_unchanged", count: 8 });
    }
    console.log(JSON.stringify({ status: "fixed_batch_apply_finished", project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET,
      actor: TFDA_PUBLICATION_ACTOR, clinicalReviewed: false, results, catalogCacheHit: catalog.cacheHit, protectedExistingPublicationsUnchanged: 8, aiCalls: 0 }));
  } finally {
    await deleteApp(app);
  }
}
export async function main(args = process.argv.slice(2)) {
  const options: Record<string, string> = {};
  const allowed = ["--mode", "--manifest", "--project", "--bucket", "--snapshot", "--manifest-sha256", "--snapshot-sha256", "--catalog-cache", "--python", "--parent-paper-mode"];
  for (let i = 0; i < args.length; i += 2) {
    must(allowed.includes(args[i]) && !!args[i + 1] && !args[i + 1].startsWith("--") && !options[args[i]], "invalid_or_duplicate_cli_arguments");
    options[args[i]] = args[i + 1];
  }
  const mode = options["--mode"] || "validate";
  must(["validate", "inspect", "apply"].includes(mode) && !!options["--manifest"], "usage_requires_explicit_manifest_and_valid_mode");
  must(!options["--parent-paper-mode"] || ["strict-v2", "byte-equivalent-v1"].includes(options["--parent-paper-mode"]), "unsupported_parent_paper_mode");
  const batch = await loadPublicationBatch(options["--manifest"], Date.now(), { python: options["--python"],
    ...(options["--parent-paper-mode"] ? { parentPaperMode: options["--parent-paper-mode"] as "strict-v2" | "byte-equivalent-v1" } : {}) });
  if (mode === "validate") {
    console.log(JSON.stringify({ status: "offline_technical_batch_validated", items: batch.loaded.length,
      manifestSha256: batch.manifestSha256, actor: TFDA_PUBLICATION_ACTOR, clinicalReviewed: false,
      itemsEligible: batch.loaded.map(({ source }) => ({ fullLicense: source.draft.licenseNo, leafletId: source.draft.id,
        status: source.assessment.status, runtimeCompatible: source.assessment.runtimeCompatible,
        rawCanonicalVerified: true, rawVerificationMethod: source.rawVerification!.method,
        rawVerificationSha256: publicationHash(JSON.stringify(source.rawVerification)) })),
      cloudCalls: 0, cloudWrites: 0, aiCalls: 0 }));
    return;
  }
  await cloudMain(mode, options, batch);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify(safePublicationFailure(error)));
    process.exitCode = 1;
  });
}
