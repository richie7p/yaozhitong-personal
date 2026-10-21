/** Small-batch publication primitives. No configuration, AI or application runtime imports. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Leaflet } from "../shared/schema.js";
import {
  evaluateTfdaSource,
  type TfdaSourceAssessment,
  type TfdaSourceInput,
} from "./tfda-source-core.js";

export const TFDA_PUBLICATION_PROJECT = "project-b6fe4904-e687-4365-b2f";
export const TFDA_PUBLICATION_BUCKET = `${TFDA_PUBLICATION_PROJECT}-yzt-test-data`;
export const TFDA_PUBLICATION_ACTOR = "tfda-technical-source-validation-not-clinical";
export const TFDA_PUBLICATION_SCHEMA = "tfda-source-publication-batch/v1";
export const TFDA_PROTECTED_LICENSES = [
  "內衛成製字第000544號",
  ...["014025", "019054", "026087", "030418", "039632", "040161", "040833"].map(
    (code) => `衛署藥製字第${code}號`,
  ),
] as const;
export type PublicationDoc = Record<string, any>;
export const publicationHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function publicationRequire(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(code);
}
const must: typeof publicationRequire = publicationRequire;
export function canonicalDocument(value: unknown): any {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}
export function sameDocument(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonicalDocument(left), canonicalDocument(right));
}
export function assertPublicationWrite(collection: string, id: string) {
  must(["leaflets", "published", "audit"].includes(collection) && /^[a-f0-9]{64}$/.test(id),
    "technical_publication_write_allowlist_violation");
}
export function assertPublicationBlob(path: string) {
  must(/^leaflets\/[a-f0-9]{64}\.(pdf|html)$/.test(path), "technical_publication_blob_allowlist_violation");
}
export interface PublicationBatchItem {
  fullLicense: string;
  candidateInputPath: string;
  candidateInputSha256: string;
  rawSourcePath: string;
  rawSourceSha256: string;
}
export interface PublicationIndexSnapshot {
  infoId: 36 | 39;
  path: string;
  sha256: string;
  evidencePath: string;
  evidenceSha256: string;
}
export interface PublicationManifest {
  schema: typeof TFDA_PUBLICATION_SCHEMA;
  batchId: string;
  project: typeof TFDA_PUBLICATION_PROJECT;
  bucket: typeof TFDA_PUBLICATION_BUCKET;
  indexSnapshots: PublicationIndexSnapshot[];
  items: PublicationBatchItem[];
}
export function validatePublicationManifest(value: any): asserts value is PublicationManifest {
  must(value?.schema === TFDA_PUBLICATION_SCHEMA && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.batchId || ""), "invalid_publication_batch_manifest");
  must(value.project === TFDA_PUBLICATION_PROJECT && value.bucket === TFDA_PUBLICATION_BUCKET, "explicit_fixed_publication_target_required");
  must(Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 50, "publication_batch_must_have_1_to_50_items");
  must(new Set(value.items.map((i: any) => i.fullLicense)).size === value.items.length, "duplicate_complete_license_in_batch");
  must(Array.isArray(value.indexSnapshots) && value.indexSnapshots.length === 2 &&
    new Set(value.indexSnapshots.map((i: any) => i.infoId)).size === 2 &&
    value.indexSnapshots.every((i: any) => [36, 39].includes(i.infoId)), "both_current_official_indexes_required");
  for (const item of value.items) {
    must(typeof item.fullLicense === "string" && item.fullLicense.length > 8 && item.fullLicense.length < 100, "complete_license_required");
    for (const key of ["candidateInputPath", "rawSourcePath"])
      must(typeof item[key] === "string" && item[key].length > 0, "explicit_candidate_and_raw_paths_required");
    for (const key of ["candidateInputSha256", "rawSourceSha256"])
      must(/^[a-f0-9]{64}$/.test(item[key] || ""), "explicit_candidate_and_raw_hashes_required");
  }
  for (const item of value.indexSnapshots) {
    must(typeof item.path === "string" && !!item.path && typeof item.evidencePath === "string" && !!item.evidencePath,
      "explicit_index_and_evidence_paths_required");
    must(/^[a-f0-9]{64}$/.test(item.sha256 || "") && /^[a-f0-9]{64}$/.test(item.evidenceSha256 || ""), "explicit_index_and_evidence_hashes_required");
  }
}
export function assertFreshTimestamp(value: string, now: number, code: string) {
  const time = Date.parse(value), age = now - time;
  must(Number.isFinite(time) && age >= -60000 && age < 86400000, code);
}
export interface CatalogCacheMetadata {
  version: string;
  generation: string;
  md5Hash: string | null;
  size: string | number;
  count: number;
}
/** Derived solely from freshly read cloud metadata; no cached sidecar can certify itself. */
export function catalogCacheFilename(live: CatalogCacheMetadata): string | null {
  if (!/^[a-f0-9]{16}$/.test(live.version) || !/^[1-9]\d{0,30}$/.test(live.generation) ||
      typeof live.md5Hash !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(live.md5Hash) ||
      !Number.isSafeInteger(Number(live.size)) || Number(live.size) <= 0 || Number(live.size) > 150000000 ||
      !Number.isSafeInteger(live.count) || live.count < 1) return null;
  const decoded = Buffer.from(live.md5Hash, "base64");
  if (decoded.length !== 16 || decoded.toString("base64") !== live.md5Hash) return null;
  return `${live.version}-${live.generation}-${decoded.toString("hex")}.json`;
}
export function verifyCachedCatalog(bytes: Buffer, live: CatalogCacheMetadata): {
  rows: PublicationDoc[]; sha256: string;
} | null {
  if (!catalogCacheFilename(live) || bytes.length !== Number(live.size) ||
    createHash("md5").update(bytes).digest("base64") !== live.md5Hash) return null;
  const sha256 = publicationHash(bytes);
  if (!sha256.startsWith(live.version)) return null;
  try {
    const rows = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows) || rows.length !== live.count || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return null;
    return { rows, sha256 };
  } catch { return null; }
}
export interface PreparedTechnicalSource {
  item: PublicationBatchItem;
  draft: Leaflet;
  assessment: TfdaSourceAssessment;
  input: TfdaSourceInput;
  rawVerification?: RawCandidateVerification;
}
export interface RawCandidateVerification {
  schema: "tfda-candidate-raw-verification/v1";
  method: "html_raw_dom_reparse_v4" | "pdf_raw_three_engine_reparse_v1";
  rawSha256: string;
  rawBytes: number;
  canonicalTextSha256: string;
  derivedPagesSha256: string;
  derivedHtmlEvidenceSha256: string | null;
  parserHelperSha256: string;
  adapterSha256: string;
  canonicalAdapterSha256: string | null;
  rawInspectionSha256: string;
}
export function prepareTechnicalSource(
  item: PublicationBatchItem, input: TfdaSourceInput, raw: Buffer, now = Date.now(),
): PreparedTechnicalSource {
  must(input.licenseNo === item.fullLicense && raw.length > 0 && raw.length <= 15000000 &&
    publicationHash(raw) === item.rawSourceSha256 && input.fetched.sha256 === item.rawSourceSha256 &&
    input.fetched.bytes === raw.length, "candidate_raw_source_binding_mismatch");
  must(input.format === "pdf" ? raw.subarray(0, 5).toString() === "%PDF-" :
    input.format === "html" && /<html[\s>]|<!doctype html/i.test(raw.toString("utf8", 0, Math.min(raw.length, 1000))),
    "raw_source_content_signature_mismatch");
  const checkedAt = new Date(now).toISOString();
  const asOfDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  // Evaluation uses actual publication time. A candidate cannot freeze freshness by supplying an old checkedAt.
  const assessment = evaluateTfdaSource({ ...input, checkedAt, asOfDate });
  must(assessment.status === "technically_eligible" && assessment.eligibleTechnical === true &&
    assessment.runtimeCompatible === true && assessment.draftLeaflet !== null,
    "source_not_technically_eligible_or_runtime_incompatible:" + assessment.reasons.join(","));
  const draft = assessment.draftLeaflet;
  must(draft.licenseNo === item.fullLicense && draft.sha256 === item.rawSourceSha256 &&
    draft.id === publicationHash(item.fullLicense + "|" + draft.sha256) && draft.version === draft.sha256.slice(0, 16),
    "evaluated_source_identity_mismatch");
  assertPublicationBlob(draft.storagePath);
  must(draft.chunks.map((chunk) => chunk.text).join("\n\n") === [...input.pages].sort((a, b) => a.page - b.page).map((page) => page.text).join("\n\n"),
    "evaluated_source_text_was_changed_or_truncated");
  return { item, draft, assessment, input };
}
export interface PublicationBefore {
  leaflet: PublicationDoc | null;
  pointer: PublicationDoc | null;
  audit: PublicationDoc | null;
}
export interface PublicationRun {
  runId: string;
  batchId: string;
  manifestSha256: string;
  snapshotSha256: string;
}
export interface TechnicalBlobState {
  exists: boolean;
  generation: string | null;
  sha256: string | null;
  owner?: Record<string, string>;
}
export interface TechnicalBlobStore {
  state(source: PreparedTechnicalSource): Promise<TechnicalBlobState>;
  createIfAbsent(path: string, bytes: Buffer, mediaType: string, owner: Record<string, string>,
    precondition: { ifGenerationMatch: 0 }): Promise<void>;
}
/** A committed blob is never replaced. A failed transaction can reuse only this exact run's verified blob. */
export async function ensureTechnicalSourceBlob(
  store: TechnicalBlobStore, source: PreparedTechnicalSource, raw: Buffer,
  before: TechnicalBlobState, run: PublicationRun,
): Promise<TechnicalBlobState> {
  assertPublicationBlob(source.draft.storagePath);
  must(publicationHash(raw) === source.draft.sha256 && raw.length <= 15000000, "blob_raw_source_binding_mismatch");
  const owner = { technicalRunId: run.runId, batchId: run.batchId, manifestSha256: run.manifestSha256,
    snapshotSha256: run.snapshotSha256, rawSourceSha256: source.draft.sha256 };
  const own = (state: TechnicalBlobState) => Object.entries(owner).every(([key, value]) => state.owner?.[key] === value);
  const existing = await store.state(source);
  if (before.exists) {
    must(existing.exists && existing.generation === before.generation && existing.sha256 === before.sha256 &&
      existing.sha256 === source.draft.sha256, "source_blob_changed_since_fixed_snapshot");
  } else {
    must(before.generation === null && before.sha256 === null, "absent_blob_baseline_invalid");
    if (existing.exists) must(own(existing), "unexpected_blob_created_since_snapshot");
    else await store.createIfAbsent(source.draft.storagePath, raw, source.draft.sourceMediaType || "application/pdf", owner, { ifGenerationMatch: 0 });
  }
  const verified = await store.state(source);
  must(verified.exists && !!verified.generation && verified.sha256 === source.draft.sha256 &&
    (before.exists ? verified.generation === before.generation : own(verified)), "uploaded_source_blob_hash_or_generation_verification_failed");
  return verified;
}
export function technicalAuditId(runId: string, leafletId: string): string {
  return publicationHash(`${TFDA_PUBLICATION_ACTOR}|${runId}|${leafletId}`);
}
const contentFields = ["id", "licenseNo", "version", "sha256", "storagePath", "chunks"];
export function sameTechnicalSource(actual: PublicationDoc, expected: Leaflet) {
  return contentFields.every((field) => sameDocument(actual[field], (expected as any)[field])) &&
    (actual.sourceMediaType || "application/pdf") === (expected.sourceMediaType || "application/pdf");
}
export type PublicationDecision = "create" | "same_source_no_op" | "skip_protected_publication" | "skip_catalog_not_current" | "conflict";
export function inspectTechnicalPublication(source: PreparedTechnicalSource, before: PublicationBefore): {
  decision: PublicationDecision; reason: string;
} {
  if ((TFDA_PROTECTED_LICENSES as readonly string[]).includes(source.draft.licenseNo))
    return { decision: "skip_protected_publication", reason: "protected_existing_eight_never_modified" };
  if (before.pointer) {
    if (before.pointer.leafletId === source.draft.id && before.pointer.version === source.draft.version &&
        before.leaflet?.status === "published" && sameTechnicalSource(before.leaflet, source.draft))
      return { decision: "same_source_no_op", reason: "identical_content_preserve_existing_metadata" };
    return { decision: "conflict", reason: "existing_publication_must_not_be_replaced" };
  }
  if (before.leaflet || before.audit)
    return { decision: "conflict", reason: "existing_leaflet_or_audit_requires_separate_resolution" };
  return { decision: "create", reason: "new_technical_source_only" };
}
export interface PublicationTx {
  get(collection: string, id: string): Promise<PublicationDoc | null>;
  create(collection: string, id: string, data: PublicationDoc): void;
}
export interface PublicationStore {
  transaction<T>(operation: (tx: PublicationTx) => Promise<T>): Promise<T>;
}
function owned(document: PublicationDoc | null, run: PublicationRun): boolean {
  const marker = document?.sourceImport;
  return !!marker && marker.runId === run.runId && marker.batchId === run.batchId &&
    marker.manifestSha256 === run.manifestSha256 && marker.snapshotSha256 === run.snapshotSha256;
}
function technicalVerification(source: PreparedTechnicalSource) {
  return {
    method: "tfda-automated-source-v1", actor: TFDA_PUBLICATION_ACTOR,
    clinicalReviewed: false, humanReviewed: false,
    criteria: source.assessment.criteria, evidence: source.assessment.evidence,
    canonicalTextSha256: source.assessment.canonicalTextSha256,
    candidateInputSha256: source.item.candidateInputSha256,
    rawSourceSha256: source.item.rawSourceSha256,
    catalogCheckedAt: source.input.catalogCheckedAt, indexCheckedAt: source.input.indexCheckedAt,
    rawVerification: source.rawVerification,
    scope: "Official source identity and complete machine text checks; technical source availability only.",
  };
}
export async function applyTechnicalPublication(
  store: PublicationStore, source: PreparedTechnicalSource, before: PublicationBefore,
  run: PublicationRun, timestamp = new Date().toISOString(),
) {
  const draft = source.draft;
  must(source.rawVerification?.schema === "tfda-candidate-raw-verification/v1" &&
    source.rawVerification.rawSha256 === draft.sha256 &&
    source.rawVerification.canonicalTextSha256 === source.assessment.canonicalTextSha256,
    "publication_requires_fresh_raw_candidate_verification");
  must(source.assessment.status === "technically_eligible" && source.assessment.eligibleTechnical &&
    source.assessment.runtimeCompatible && source.assessment.draftLeaflet &&
    sameTechnicalSource(source.assessment.draftLeaflet, draft), "publication_requires_revalidated_technical_source");
  must(!!run.runId && !!run.batchId && /^[a-f0-9]{64}$/.test(run.manifestSha256) &&
    /^[a-f0-9]{64}$/.test(run.snapshotSha256), "invalid_technical_publication_run");
  const pointerId = publicationHash(draft.licenseNo), auditId = technicalAuditId(run.runId, draft.id);
  const sourceVerification = technicalVerification(source);
  return store.transaction(async (tx) => {
    const current = {
      pointer: await tx.get("published", pointerId),
      leaflet: await tx.get("leaflets", draft.id),
      audit: await tx.get("audit", auditId),
    };
    const inspection = inspectTechnicalPublication(source, current);
    if (inspection.decision === "skip_protected_publication") return "skip_protected_publication" as const;
    if (inspection.decision === "same_source_no_op") {
      if (owned(current.pointer, run) && owned(current.leaflet, run) && owned(current.audit, run)) {
        const marker = current.leaflet!.sourceImport;
        must(Number.isFinite(Date.parse(marker.at)) &&
          sameDocument(current.leaflet, { ...draft, status: "published", checkedBy: TFDA_PUBLICATION_ACTOR,
            checkedAt: marker.at, sourceImport: marker, sourceVerification }) &&
          sameDocument(current.pointer, { leafletId: draft.id, version: draft.version, sourceImport: marker }) &&
          sameDocument(current.audit, { id: auditId, actor: TFDA_PUBLICATION_ACTOR, action: "leaflet.technical_source_publish",
            target: draft.id, at: marker.at, sourceImport: marker, clinicalReviewed: false }), "owned_publication_marker_inconsistent");
        return "recovered_committed_publication" as const;
      }
      must(sameDocument(current, before), "publication_changed_since_fixed_snapshot");
      return "same_source_no_op" as const;
    }
    must(inspection.decision === "create", inspection.reason);
    must(sameDocument(current, before), "publication_changed_since_fixed_snapshot");
    const sourceImport = { ...run, at: timestamp };
    const writes: [string, string, PublicationDoc][] = [
      ["leaflets", draft.id, { ...draft, status: "published", checkedBy: TFDA_PUBLICATION_ACTOR, checkedAt: timestamp, sourceImport, sourceVerification }],
      ["published", pointerId, { leafletId: draft.id, version: draft.version, sourceImport }],
      ["audit", auditId, { id: auditId, actor: TFDA_PUBLICATION_ACTOR, action: "leaflet.technical_source_publish", target: draft.id, at: timestamp, sourceImport, clinicalReviewed: false }],
    ];
    for (const [collection, id, value] of writes) {
      assertPublicationWrite(collection, id);
      tx.create(collection, id, value);
    }
    return "published_technical_source" as const;
  });
}
