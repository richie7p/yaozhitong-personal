/** Small-batch publication primitives. No configuration, AI or application runtime imports. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Leaflet } from "../shared/schema.js";
import type { CurrentEquivalentSource, ParentPaperEquivalentVerification } from "./tfda-current-paper-equivalence.js";
import {
  evaluateTfdaSource,
  isRawMaterialOfficialCategory, normalizeTfdaSourceText,
  type TfdaSourceAssessment,
  type TfdaSourceInput,
  type TfdaFetchedArtifact,
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
/** Authoritative raw official metadata, never a candidate-supplied category claim. */
export function assertOfficialPatientCategory(rawRows: PublicationDoc[], licenseNo: string, declaredCategory?: string): string {
  const rows = rawRows.filter((row) => row["許可證字號"] === licenseNo);
  const categories = rows.map((row) => String(row["藥品類別"] || "").trim());
  publicationRequire(rows.length > 0 && categories.every(Boolean), "official_product_category_missing");
  publicationRequire(!categories.some(isRawMaterialOfficialCategory), "official_raw_material_source_not_patient_leaflet");
  publicationRequire(new Set(categories.map(normalizeTfdaSourceText)).size === 1, "official_product_category_ambiguous");
  if (declaredCategory !== undefined)
    publicationRequire(typeof declaredCategory === "string" && normalizeTfdaSourceText(declaredCategory) === normalizeTfdaSourceText(categories[0]), "candidate_official_category_mismatch");
  return categories[0];
}
export class PublicationValidationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "PublicationValidationError";
  }
}
export function publicationRequire(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PublicationValidationError(code);
}
/** Never serialize SDK messages, details, request objects, headers or credentials. */
export function safePublicationFailure(error: unknown) {
  const validation = error instanceof PublicationValidationError;
  const grpc = ["OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
    "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED",
    "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED"];
  const known = new Set([...grpc, "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENOENT", "EACCES", "EPERM", "ENOSPC"]);
  let code = validation ? "VALIDATION_FAILED" : "UNKNOWN";
  for (let current: any = error, depth = 0; !validation && current && depth < 4; current = current.cause, depth++) {
    const value = current.code ?? current.status ?? current.statusCode;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value < grpc.length) { code = grpc[value]; break; }
    if (typeof value === "string" && known.has(value)) { code = value; break; }
    if (typeof value === "number" && [400, 401, 403, 404, 408, 409, 412, 429, 500, 502, 503, 504].includes(value)) { code = `HTTP_${value}`; break; }
  }
  return { status: "failed", error: validation && /^[a-zA-Z0-9_:,.-]{1,1500}$/.test(error.message)
    ? error.message : "cloud_or_file_operation_failed", diagnostic: { code, validation,
      readOnlyTransient: !validation && ["UNAVAILABLE", "DEADLINE_EXCEEDED", "ECONNRESET"].includes(code) }, aiCalls: 0 };
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
  /** Accepted only by the explicit strict parent-paper mode after independent reparse. */
  parentSource?: { rawSourcePath: string; rawSourceSha256: string; fetched: TfdaFetchedArtifact;
    /** Requires the explicit byte-equivalent mode and native reads of every raw/receipt. */
    currentEquivalentSources?: CurrentEquivalentSource[] };
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
    if (item.parentSource !== undefined) must(item.parentSource && typeof item.parentSource.rawSourcePath === "string" &&
      !!item.parentSource.rawSourcePath && /^[a-f0-9]{64}$/.test(item.parentSource.rawSourceSha256 || "") &&
      item.parentSource.fetched && typeof item.parentSource.fetched === "object", "explicit_parent_source_path_hash_and_fetch_required");
    if (item.parentSource?.currentEquivalentSources !== undefined) {
      const aliases = item.parentSource.currentEquivalentSources;
      must(Array.isArray(aliases) && aliases.length >= 2 && aliases.length <= 50 && aliases.every((alias: any) =>
        alias && alias.fullLicense === item.fullLicense && typeof alias.rawSourcePath === "string" && !!alias.rawSourcePath &&
        typeof alias.rawMetadataPath === "string" && !!alias.rawMetadataPath && /^[a-f0-9]{64}$/u.test(alias.rawSourceSha256 || "") &&
        /^[a-f0-9]{64}$/u.test(alias.rawMetadataSha256 || "") && alias.fetched && typeof alias.fetched.requestedUrl === "string" &&
        Array.isArray(alias.allArchiveRoles) && alias.allArchiveRoles.length > 0) &&
        new Set(aliases.map((alias: any) => alias.fetched.requestedUrl)).size === aliases.length,
        "complete_pinned_current_equivalent_sources_required");
    }
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
  parentVerification?: ParentPaperVerification;
}
/** Derived from actual indexed parent bytes; no local filesystem paths are persisted. */
export type ParentPaperVerification = StrictParentPaperVerification | ParentPaperEquivalentVerification;
export interface StrictParentPaperVerification {
  schema: "tfda-current-parent-paper-verification/v2";
  method: "official_index_parent_raw_current_paper_reparse_v2";
  scope: "single_current_paper_excluding_explicit_history";
  licenseNo: string; indexUrl: string; parentFinalUrl: string;
  parentRawSha256: string; parentRawBytes: number; parentStoragePath: string;
  parentRetrievedAt: string; parentRedirectChain: string[];
  currentPaperUrls: string[]; historicalPaperUrls: string[];
  excludedHistoricalPaperUrls: string[];
  excludedHistoricalElectronicUrls: string[];
  branchInventory: { popups: PublicationDoc[]; anchors: PublicationDoc[] };
  childUrl: string; childRawSha256: string;
  officialCatalogSha256: string; officialIndexSha256: string;
  parentIdentitySha256: string; parentDomInspectionSha256: string;
  parserHelperSha256: string; fetchDependencySha256: string; adapterSha256: string;
}
export interface RawCandidateVerification {
  schema: "tfda-candidate-raw-verification/v1";
  method: "html_raw_dom_reparse_v4" | "html_raw_numbered_outline_reparse_v1" | "html_raw_rectangular_outline_reparse_v2" | "pdf_raw_three_engine_reparse_v1";
  rawSha256: string;
  rawBytes: number;
  canonicalTextSha256: string;
  derivedPagesSha256: string;
  derivedHtmlEvidenceSha256: string | null;
  parserHelperSha256: string;
  adapterSha256: string;
  canonicalAdapterSha256: string | null;
  rawInspectionSha256: string;
  /** Complete repeated factory metadata from the raw HTML report; never a unique-factory claim. */
  htmlMultiFactoryMetadata?: Partial<Record<"製造廠名稱" | "製造廠地址", string[]>>;
  /** Full strictly reparsed outline hierarchy; never a caller-provided simple-table flag. */
  htmlNumberedOutlineEvidence?: Record<string, unknown>;
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
    ...(source.parentVerification ? { officialParentVerification: source.parentVerification } : {}),
    scope: "Official source identity and complete machine text checks; technical source availability only.",
  };
}
export function assertTechnicalPublicationSize(source: PreparedTechnicalSource, marker = {
  runId: "x".repeat(100), batchId: "x".repeat(100), manifestSha256: "a".repeat(64), snapshotSha256: "b".repeat(64), at: "2099-12-31T23:59:59.999Z",
}) {
  must(Buffer.byteLength(JSON.stringify({ ...source.draft, status: "published", checkedBy: TFDA_PUBLICATION_ACTOR,
    checkedAt: marker.at, sourceImport: marker, sourceVerification: technicalVerification(source) }), "utf8") <= 800_000,
    "verified_source_document_exceeds_800000_bytes");
}
export async function applyTechnicalPublication(
  store: PublicationStore, source: PreparedTechnicalSource, before: PublicationBefore,
  run: PublicationRun, timestamp = new Date().toISOString(),
) {
  const draft = source.draft;
  if (source.input.officialAssociation) {
    const proof = source.parentVerification;
    const roleKey = (value: string) => { try { const url = new URL(value); return JSON.stringify([url.protocol, url.hostname,
      decodeURIComponent(url.pathname), [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))]); } catch { return null; } };
    const strictSingle = proof?.schema === "tfda-current-parent-paper-verification/v2" &&
      proof.method === "official_index_parent_raw_current_paper_reparse_v2" && proof.scope === "single_current_paper_excluding_explicit_history" &&
      proof.currentPaperUrls.length === 1 && proof.currentPaperUrls[0] === proof.childUrl && !source.item.parentSource?.currentEquivalentSources;
    let completeEquivalent = false;
    if (proof?.schema === "tfda-current-parent-paper-verification/v3") {
      const eq = proof.currentPaperEquivalence;
      const aliases = source.item.parentSource?.currentEquivalentSources;
      completeEquivalent = proof.method === "official_index_parent_raw_equivalent_current_papers_reparse_v1" &&
        proof.scope === "complete_byte_equivalent_current_papers_excluding_explicit_history" &&
        sameDocument(proof.parentDomInvalidReasons, ["current_paper_url_count_not_one"]) &&
        /^[a-f0-9]{64}$/u.test(proof.equivalenceVerifierSha256) &&
        !!eq && eq.schema === "tfda-current-paper-byte-equivalence/v1" &&
        eq.licenseNo === draft.licenseNo && eq.parentRawSha256 === proof.parentRawSha256 &&
        eq.parentDomInspectionSha256 === proof.parentDomInspectionSha256 &&
        eq.sharedRawSha256 === draft.sha256 && eq.sharedRawBytes === source.input.fetched.bytes &&
        eq.representativeUrl === proof.childUrl && proof.currentPaperUrls[0] === proof.childUrl &&
        Array.isArray(proof.currentPaperUrls) && proof.currentPaperUrls.length >= 2 && proof.currentPaperUrls.length <= 50 &&
        new Set(proof.currentPaperUrls).size === proof.currentPaperUrls.length &&
        sameDocument(eq.orderedCurrentUrls, proof.currentPaperUrls) &&
        sameDocument(source.input.officialAssociation.linkedSourceUrls, proof.currentPaperUrls) &&
        Array.isArray(aliases) && aliases.length === proof.currentPaperUrls.length &&
        Array.isArray(eq.artifacts) && eq.artifacts.length === aliases.length &&
        eq.artifacts.every((artifact, index) => {
          const alias = aliases[index];
          return artifact.fullLicense === draft.licenseNo && artifact.rawSha256 === draft.sha256 &&
            artifact.rawBytes === eq.sharedRawBytes && artifact.fetched.requestedUrl === proof.currentPaperUrls[index] &&
            artifact.fetched.sha256 === draft.sha256 && artifact.fetched.bytes === eq.sharedRawBytes &&
            /^[a-f0-9]{64}$/u.test(artifact.rawMetadataSha256) && alias.fullLicense === draft.licenseNo &&
            alias.rawSourceSha256 === artifact.rawSha256 && alias.rawMetadataSha256 === artifact.rawMetadataSha256 &&
            sameDocument(alias.fetched, artifact.fetched) && sameDocument(alias.allArchiveRoles, artifact.allArchiveRoles) &&
            artifact.allArchiveRoles.length > 0;
        });
    }
    must(proof && (strictSingle || completeEquivalent) &&
      proof.licenseNo === draft.licenseNo && proof.childRawSha256 === draft.sha256 &&
      proof.childUrl === source.input.fetched.requestedUrl && proof.parentRawSha256 === source.input.officialAssociation.detailSha256 &&
      sameDocument(proof.historicalPaperUrls, proof.excludedHistoricalPaperUrls) && roleKey(proof.childUrl) !== null &&
      proof.currentPaperUrls.every((current) => roleKey(current) !== null &&
        [...proof.excludedHistoricalPaperUrls, ...proof.excludedHistoricalElectronicUrls].every((url) => roleKey(url) !== null && roleKey(url) !== roleKey(current))),
      "publication_requires_independently_verified_parent_association");
  } else must(!source.parentVerification, "unexpected_parent_verification_without_association");
  must(source.rawVerification?.schema === "tfda-candidate-raw-verification/v1" &&
    source.rawVerification.rawSha256 === draft.sha256 &&
    source.rawVerification.canonicalTextSha256 === source.assessment.canonicalTextSha256,
    "publication_requires_fresh_raw_candidate_verification");
  must(source.assessment.status === "technically_eligible" && source.assessment.eligibleTechnical &&
    source.assessment.runtimeCompatible && source.assessment.draftLeaflet &&
    sameTechnicalSource(source.assessment.draftLeaflet, draft), "publication_requires_revalidated_technical_source");
  must(!!run.runId && !!run.batchId && /^[a-f0-9]{64}$/.test(run.manifestSha256) &&
    /^[a-f0-9]{64}$/.test(run.snapshotSha256), "invalid_technical_publication_run");
  assertTechnicalPublicationSize(source, { ...run, at: timestamp });
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
