/**
 * Offline, deterministic technical gates for an official TFDA source.
 * Callers supply evidence gathered from original bytes and current official
 * indexes. Nothing here fetches, publishes, loads configuration, or invokes AI.
 */
import { createHash } from "node:crypto";
import type { Chunk, Leaflet } from "../shared/schema.js";
import { hasSingleOfficialManufacturingProduct, type OfficialCatalogManufacturingRecord } from "./tfda-manufacturing-roles.js";

export const TFDA_SOURCE_LIMITS = {
  rawBytes: 15_000_000,
  pdfPages: 200,
  pageCharacters: 22_000,
  sourceDocumentBytes: 800_000,
  runtimeSourceCharacters: 22_000,
  evidenceAgeMs: 24 * 60 * 60 * 1000,
  futureClockSkewMs: 60_000,
} as const;

export const TFDA_TECHNICAL_CRITERIA = {
  version: "tfda-automated-source-v1",
  scope:
    "Official identity, current association and complete machine text checks only.",
  humanReviewed: false,
  clinicalReviewed: false,
  pdfTextRule:
    "Every physical page has equal ordered normalized text from two independent extractors.",
  imageRule:
    "No large unverified image; a caller must inspect all page image bounds.",
  structureRule:
    "PDF pages require an explicit single-flow structure check; detected tables, columns, vector grids or unknown geometry require source correction.",
  completenessLimit:
    "Extraction agreement is technical evidence, not semantic or clinical review.",
} as const;

export interface TfdaCatalogProduct {
  licenseNo: string;
  nameZh: string;
  nameEn: string;
  form: string;
  manufacturer: string;
  effectiveUntil: string;
  revoked: boolean;
}
export interface TfdaLeafletIndexRow {
  licenseNo: string;
  nameZh: string;
  nameEn: string;
  urls: string[];
}
export interface TfdaFetchedArtifact {
  requestedUrl: string;
  finalUrl: string;
  /** If redirected, include EVERY hop, starting at requestedUrl and ending at finalUrl. */
  redirectChain?: string[];
  retrievedAt: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  /** Determined from original bytes, never inferred from a URL or Content-Type alone. */
  contentSignature: "pdf" | "html" | "unknown";
}
export interface TfdaSourcePage {
  page: number;
  /** Complete original page text, preserved without clipping or normalization. */
  text: string;
  independentText?: string;
  /** A third extraction, when supplied, must also preserve complete ordered text. */
  additionalIndependentText?: string;
  embeddedImages?: number;
  /** Explicit false requires examination of all image bounds, not only text extraction. */
  hasLargeUnverifiedImage?: boolean;
  /** PDF-only: explicit false is required; missing/unknown structure remains in review. */
  hasUnverifiedStructure?: boolean;
  structureEvidence?: {
    version: "tfda-pdf-structure-v1";
    status: "review_required" | "single_flow_no_detected_structure" | "empty_page_no_structure";
    reasons: string[];
    [key: string]: unknown;
  };
}
export interface TfdaOfficialAssociation {
  indexUrl: string;
  detailUrl: string;
  licenseNo: string;
  /** Links read from the current official detail DOM for this complete license. */
  linkedSourceUrls: string[];
  retrievedAt: string;
  detailSha256: string;
}
export interface TfdaHtmlEvidence {
  /** Produced by the HTML adapter after exact, ordered main-DOM conservation. */
  completeMainDocument: boolean;
  domConservationPassed: boolean;
  canonicalTextSha256: string;
  sectionCount: number;
  hasUnverifiedNonTextContent: boolean;
  /** Explicit capability for newly re-derived two-column numbered outlines only. */
  tableSerializationVersion?: "tfda-numbered-outline-literal-v1" | "tfda-numbered-outline-literal-v2";
  numberedOutlineEvidenceSha256?: string;
}
export interface TfdaSourceInput {
  licenseNo: string;
  /** Optional compatibility field. Publication independently checks raw InfoId36. */
  officialCategory?: string;
  /** Explicit evaluation time makes this function reproducible. */
  checkedAt: string;
  /** Optional local calendar day for inclusive expiry checks; otherwise UTC day. */
  asOfDate?: string;
  catalogCheckedAt: string;
  indexCheckedAt: string;
  catalogRows: TfdaCatalogProduct[];
  /** Complete original InfoId36 rows. Publication rechecks these against raw bytes. */
  catalogManufacturingRecords?: OfficialCatalogManufacturingRecord[];
  indexRows: TfdaLeafletIndexRow[];
  fetched: TfdaFetchedArtifact;
  format: "pdf" | "html";
  numPages: number;
  pages: TfdaSourcePage[];
  officialAssociation?: TfdaOfficialAssociation;
  /** Only identical raw hashes can resolve otherwise ambiguous multiple index URLs. */
  sameSourceArtifacts?: TfdaFetchedArtifact[];
  htmlEvidence?: TfdaHtmlEvidence;
}
export type TfdaSourceReason =
  | "invalid_evaluation_date"
  | "invalid_complete_license"
  | "catalog_evidence_not_fresh"
  | "index_evidence_not_fresh"
  | "source_evidence_not_fresh"
  | "catalog_license_missing"
  | "catalog_product_ambiguous"
  | "raw_material_source_not_patient_leaflet"
  | "catalog_identity_incomplete"
  | "license_revoked"
  | "license_expired_or_invalid_date"
  | "index_license_missing"
  | "index_identity_ambiguous"
  | "index_product_title_mismatch"
  | "index_source_url_missing"
  | "nonofficial_or_invalid_url"
  | "placeholder_source_path"
  | "redirect_history_incomplete"
  | "source_not_currently_associated"
  | "official_association_invalid"
  | "multiple_distinct_sources_require_resolution"
  | "invalid_source_hash"
  | "invalid_or_oversize_raw_source"
  | "source_media_or_signature_mismatch"
  | "invalid_source_page_count"
  | "page_inventory_incomplete_or_duplicate"
  | "source_page_text_missing"
  | "source_page_too_large"
  | "source_document_too_large"
  | "source_text_quality_failed"
  | "independent_extraction_missing"
  | "independent_ordered_text_mismatch"
  | "page_image_inventory_missing"
  | "large_unverified_image"
  | "unverified_structure"
  | "medical_document_heading_missing"
  | "current_complete_product_name_missing"
  | "other_complete_license_requires_scope_review"
  | "html_conservation_evidence_missing_or_failed";
export type TfdaSourceStatus =
  "raw_only" | "needs_review" | "technically_eligible";
export interface TfdaPageEvidence {
  page: number;
  characters: number;
  textSha256: string;
  independentNormalizedExactMatch: boolean | null;
  additionalIndependentNormalizedExactMatch: boolean | null;
  /** Number of nonempty supplied text results, including the canonical extractor. */
  suppliedTextExtractionCount: number;
  /** Diagnostic only. Even 100% character coverage does not establish ordering. */
  independentCharacterCoverage: number | null;
  hasLargeUnverifiedImage: boolean | null;
  hasUnverifiedStructure: boolean | null;
}
export interface TfdaSourceAssessment {
  status: TfdaSourceStatus;
  acquired: boolean;
  rawOnly: boolean;
  draft: boolean;
  eligibleTechnical: boolean;
  /** Includes technical eligibility as well as the CURRENT whole-source model budget. */
  runtimeCompatible: boolean;
  reasons: TfdaSourceReason[];
  warnings: string[];
  criteria: typeof TFDA_TECHNICAL_CRITERIA;
  draftLeaflet: Leaflet | null;
  canonicalTextSha256: string | null;
  evidence: {
    catalogRowCount: number;
    coalescedProductCount: number;
    catalogManufacturingRecords?: OfficialCatalogManufacturingRecord[];
    indexRowCount: number;
    indexUrlCount: number;
    totalCharacters: number;
    serializedDraftBytes: number;
    chunksBytes: number;
    modelBudgetCompatible: boolean;
    matchedCurrentName: "zh" | "en" | null;
    printedCompleteLicenses: string[];
    pages: TfdaPageEvidence[];
  };
}

export const tfdaSourceHash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

/** Preserve brand, amounts, punctuation and order. Only typography/space varies. */
export function normalizeTfdaSourceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”„‟〝〞]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s/gu, "");
}
export function isRawMaterialOfficialCategory(value: unknown): boolean {
  return typeof value === "string" && /原料藥|製劑原料|醫藥原料/u.test(normalizeTfdaSourceText(value));
}
const hashPattern = /^[a-f0-9]{64}$/;
const licenseBody =
  "(?:衛署|衛部|內衛)[\\p{Script=Han}]{1,12}字第(?:R\\d{5,7}|\\d{6,8})號";
const completeLicense = new RegExp(`^${licenseBody}$`, "u");
function calendarDate(value: string): string | null {
  const matched = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(value);
  if (!matched) return null;
  const iso = `${matched[1]}-${matched[2]}-${matched[3]}`;
  const time = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === iso
    ? iso
    : null;
}
function normalizedUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === "fda.gov.tw" ||
        parsed.hostname.endsWith(".fda.gov.tw")
      ) ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443")
    )
      return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}
function placeholderUrl(value: string): boolean {
  try {
    return /^\/insert\/pdfcase\/?$/iu.test(new URL(value).pathname);
  } catch {
    return false;
  }
}
function textQuality(text: string): boolean {
  if (!text.trim() || /\uFFFD|[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text))
    return false;
  const meaningful = text.match(/[\p{Script=Han}\p{Letter}\p{Number}]/gu) || [];
  // Printed ingredient/quantity leaders also occur after a closing parenthesis
  // or a numeric percentage. Inspect them only in this same-line repetition
  // projection; preserve every source character, original hash and density.
  const repetitionCheckText = text
    .split(/[\r\n\u2028\u2029]/u)
    .map((line) =>
      normalizeTfdaSourceText(line).replace(
        /((?:[\p{Letter}\p{Number}]|\p{Number}%)[)\]]{0,3})[.\-·・]{20,}(?=[\p{Letter}\p{Number}])/gu,
        "$1.",
      ),
    )
    .join("");
  return (
    meaningful.length >= 24 &&
    meaningful.length / Math.max(text.trim().length, 1) >= 0.25 &&
    !/(.)\1{19}/u.test(repetitionCheckText)
  );
}
function characterCoverage(left: string, right: string): number {
  const counts = new Map<string, number>();
  for (const char of left) counts.set(char, (counts.get(char) || 0) + 1);
  let shared = 0;
  for (const char of right) {
    const remaining = counts.get(char) || 0;
    if (remaining > 0) {
      shared++;
      counts.set(char, remaining - 1);
    }
  }
  return shared / Math.max(left.length, right.length, 1);
}

export function evaluateTfdaSource(
  input: TfdaSourceInput,
): TfdaSourceAssessment {
  const reasons = new Set<TfdaSourceReason>();
  const add = (reason: TfdaSourceReason) => {
    reasons.add(reason);
  };
  const warnings: string[] = [];
  const norm = normalizeTfdaSourceText;
  const licenseNo = norm(input.licenseNo);
  const checkedTime = Date.parse(input.checkedAt);
  const asOfDate =
    input.asOfDate !== undefined
      ? calendarDate(input.asOfDate)
      : Number.isFinite(checkedTime)
        ? new Date(checkedTime).toISOString().slice(0, 10)
        : null;
  if (!Number.isFinite(checkedTime) || !asOfDate)
    add("invalid_evaluation_date");
  if (!completeLicense.test(licenseNo)) add("invalid_complete_license");
  const fresh = (timestamp: string) => {
    const age = checkedTime - Date.parse(timestamp);
    return (
      Number.isFinite(age) &&
      age >= -TFDA_SOURCE_LIMITS.futureClockSkewMs &&
      age < TFDA_SOURCE_LIMITS.evidenceAgeMs
    );
  };
  if (!fresh(input.catalogCheckedAt)) add("catalog_evidence_not_fresh");
  if (!fresh(input.indexCheckedAt)) add("index_evidence_not_fresh");

  const catalogRows = input.catalogRows.filter(
    (row) => norm(row.licenseNo) === licenseNo,
  );
  const products = new Map<string, TfdaCatalogProduct>();
  const sharedManufacturingProduct = hasSingleOfficialManufacturingProduct(
    licenseNo, catalogRows, input.catalogManufacturingRecords,
  );
  for (const row of catalogRows) {
    const key = JSON.stringify([
      norm(row.nameZh),
      norm(row.nameEn),
      norm(row.form),
      sharedManufacturingProduct ? "official_manufacturing_roles_preserved" : norm(row.manufacturer),
      calendarDate(row.effectiveUntil) || row.effectiveUntil,
      row.revoked,
    ]);
    products.set(key, row);
  }
  if (!catalogRows.length) add("catalog_license_missing");
  if (products.size > 1) add("catalog_product_ambiguous");
  if (sharedManufacturingProduct) warnings.push("official_manufacturing_roles_preserved_not_unique_factory");
  const product = products.size === 1 ? [...products.values()][0] : null;
  // An official source can describe manufacturing material rather than a
  // patient medicine. Keep it in the corpus, outside patient-facing publication.
  const materialCategory = /^(?:(?:本品)?僅供)?(?:製劑原料|醫藥原料|原料藥)(?:使用|用)?[。.]?$/u;
  if (isRawMaterialOfficialCategory(input.officialCategory) || input.pages.some((page) => page.text.split(/\r?\n/u).some((line) => materialCategory.test(line.trim()))))
    add("raw_material_source_not_patient_leaflet");
  if (product) {
    if (
      (!norm(product.nameZh) && !norm(product.nameEn)) ||
      !norm(product.form) ||
      !norm(product.manufacturer) ||
      typeof product.revoked !== "boolean"
    )
      add("catalog_identity_incomplete");
    if (product.revoked) add("license_revoked");
    const expiry = calendarDate(product.effectiveUntil);
    if (!expiry || !asOfDate || expiry < asOfDate)
      add("license_expired_or_invalid_date");
  }
  const indexRows = input.indexRows.filter(
    (row) => norm(row.licenseNo) === licenseNo,
  );
  const indexIdentities = new Set(
    indexRows.map((row) =>
      JSON.stringify([norm(row.nameZh), norm(row.nameEn)]),
    ),
  );
  if (!indexRows.length) add("index_license_missing");
  if (indexIdentities.size > 1) add("index_identity_ambiguous");
  if (
    product &&
    indexRows.some(
      (row) =>
        norm(row.nameZh) !== norm(product.nameZh) ||
        norm(row.nameEn) !== norm(product.nameEn),
    )
  )
    add("index_product_title_mismatch");
  const indexUrls = [
    ...new Set(
      indexRows
        .flatMap((row) => row.urls)
        .map((url) => normalizedUrl(url) || url),
    ),
  ];
  if (!indexUrls.length) add("index_source_url_missing");
  for (const url of indexUrls) {
    if (!normalizedUrl(url)) add("nonofficial_or_invalid_url");
    if (placeholderUrl(url)) add("placeholder_source_path");
  }
  const inspectArtifact = (artifact: TfdaFetchedArtifact) => {
    const requested = normalizedUrl(artifact.requestedUrl),
      final = normalizedUrl(artifact.finalUrl);
    const chain = artifact.redirectChain;
    for (const url of [
      artifact.requestedUrl,
      ...(chain || []),
      artifact.finalUrl,
    ]) {
      if (!normalizedUrl(url)) add("nonofficial_or_invalid_url");
      if (placeholderUrl(url)) add("placeholder_source_path");
    }
    if (
      requested !== final &&
      (!chain ||
        chain.length < 2 ||
        normalizedUrl(chain[0]) !== requested ||
        normalizedUrl(chain[chain.length - 1]) !== final)
    )
      add("redirect_history_incomplete");
    if (!fresh(artifact.retrievedAt)) add("source_evidence_not_fresh");
    if (!hashPattern.test(artifact.sha256)) add("invalid_source_hash");
    if (
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > TFDA_SOURCE_LIMITS.rawBytes
    )
      add("invalid_or_oversize_raw_source");
    const media = artifact.mediaType.toLowerCase().split(";", 1)[0].trim();
    if (
      artifact.contentSignature !== input.format ||
      media !== (input.format === "pdf" ? "application/pdf" : "text/html")
    )
      add("source_media_or_signature_mismatch");
    return requested;
  };
  const requestedUrl = inspectArtifact(input.fetched);
  let associated = !!requestedUrl && indexUrls.includes(requestedUrl);
  if (input.officialAssociation) {
    const association = input.officialAssociation;
    const indexUrl = normalizedUrl(association.indexUrl);
    const linkedUrls = association.linkedSourceUrls.map(normalizedUrl);
    const valid =
      !!indexUrl &&
      indexUrls.includes(indexUrl) &&
      !!normalizedUrl(association.detailUrl) &&
      norm(association.licenseNo) === licenseNo &&
      hashPattern.test(association.detailSha256) &&
      fresh(association.retrievedAt) &&
      linkedUrls.length > 0 &&
      linkedUrls.every(Boolean) &&
      !!requestedUrl &&
      linkedUrls.includes(requestedUrl) &&
      ![
        association.indexUrl,
        association.detailUrl,
        ...association.linkedSourceUrls,
      ].some(placeholderUrl);
    if (!valid) add("official_association_invalid");
    else associated = true;
  }
  if (!associated) add("source_not_currently_associated");
  if (indexUrls.length > 1) {
    const artifacts = [input.fetched, ...(input.sameSourceArtifacts || [])];
    const byUrl = new Map<string, string>();
    for (const artifact of artifacts) {
      const url =
        artifact === input.fetched ? requestedUrl : inspectArtifact(artifact);
      if (url) byUrl.set(url, artifact.sha256);
    }
    if (!indexUrls.every((url) => byUrl.get(url) === input.fetched.sha256))
      add("multiple_distinct_sources_require_resolution");
  }

  const pageCountValid =
    Number.isSafeInteger(input.numPages) &&
    input.numPages > 0 &&
    input.numPages <=
      (input.format === "pdf" ? TFDA_SOURCE_LIMITS.pdfPages : 1);
  if (!pageCountValid) add("invalid_source_page_count");
  const ordered = [...input.pages].sort((a, b) => a.page - b.page);
  const inventoryValid =
    pageCountValid &&
    ordered.length === input.numPages &&
    ordered.every((page, index) => page.page === index + 1);
  if (!inventoryValid) add("page_inventory_incomplete_or_duplicate");
  const pageEvidence: TfdaPageEvidence[] = [];
  let allTextPresent = true,
    allPagesFit = true;
  for (const page of ordered) {
    const text = page.text;
    if (!text.trim()) {
      add("source_page_text_missing");
      allTextPresent = false;
    }
    if (text.length > TFDA_SOURCE_LIMITS.pageCharacters) {
      add("source_page_too_large");
      allPagesFit = false;
    }
    if (!textQuality(text)) add("source_text_quality_failed");
    if (typeof page.hasLargeUnverifiedImage !== "boolean")
      add("page_image_inventory_missing");
    if (page.hasLargeUnverifiedImage) add("large_unverified_image");
    if (input.format === "pdf" && page.hasUnverifiedStructure !== false)
      add("unverified_structure");
    if (
      page.embeddedImages !== undefined &&
      (!Number.isSafeInteger(page.embeddedImages) || page.embeddedImages < 0)
    )
      add("page_image_inventory_missing");
    let equal: boolean | null = null,
      additionalEqual: boolean | null = null,
      coverage: number | null = null;
    if (input.format === "pdf") {
      if (
        typeof page.independentText !== "string" ||
        !page.independentText.trim()
      )
        add("independent_extraction_missing");
      else {
        const primary = norm(text),
          independent = norm(page.independentText);
        equal = primary === independent;
        coverage = characterCoverage(primary, independent);
        if (!equal) add("independent_ordered_text_mismatch");
      }
    }
    if (page.additionalIndependentText !== undefined) {
      if (
        typeof page.additionalIndependentText !== "string" ||
        !page.additionalIndependentText.trim()
      ) {
        add("independent_extraction_missing");
      } else {
        additionalEqual = norm(text) === norm(page.additionalIndependentText);
        if (!additionalEqual) add("independent_ordered_text_mismatch");
      }
    }
    pageEvidence.push({
      page: page.page,
      characters: text.length,
      textSha256: tfdaSourceHash(text),
      independentNormalizedExactMatch: equal,
      additionalIndependentNormalizedExactMatch: additionalEqual,
      suppliedTextExtractionCount:
        (text.trim() ? 1 : 0) +
        (typeof page.independentText === "string" && page.independentText.trim()
          ? 1
          : 0) +
        (typeof page.additionalIndependentText === "string" &&
        page.additionalIndependentText.trim()
          ? 1
          : 0),
      independentCharacterCoverage: coverage,
      hasLargeUnverifiedImage: page.hasLargeUnverifiedImage ?? null,
      hasUnverifiedStructure: page.hasUnverifiedStructure ?? null,
    });
  }
  const canonicalText = ordered.map((page) => page.text).join("\n\n");
  const canonicalTextSha256 =
    ordered.length && allTextPresent ? tfdaSourceHash(canonicalText) : null;
  const normalizedText = norm(canonicalText);
  if (
    !/(適應症|用途|效能|用法|用量|警語|禁忌|注意事項|副作用|不良反應|indications|dosage|warnings|contraindications)/iu.test(
      normalizedText,
    )
  )
    add("medical_document_heading_missing");
  if ((normalizedText.match(/[\p{Letter}\p{Number}]/gu) || []).length < 120)
    add("source_text_quality_failed");
  // A complete printed license alone cannot authorize an old product name.
  const nameAppears = (name: string) => {
    const value = norm(name);
    if (!value) return false;
    let offset = normalizedText.indexOf(value);
    while (offset >= 0) {
      const suffix = normalizedText.slice(
        offset + value.length,
        offset + value.length + 1,
      );
      if (!/[\d/%]/u.test(suffix)) return true;
      offset = normalizedText.indexOf(value, offset + 1);
    }
    return false;
  };
  const matchedCurrentName =
    product && nameAppears(product.nameZh)
      ? ("zh" as const)
      : product && nameAppears(product.nameEn)
        ? ("en" as const)
        : null;
  if (!matchedCurrentName) add("current_complete_product_name_missing");
  const printedCompleteLicenses = [
    ...new Set(normalizedText.match(new RegExp(licenseBody, "gu")) || []),
  ];
  if (printedCompleteLicenses.some((value) => value !== licenseNo))
    add("other_complete_license_requires_scope_review");
  if (input.format === "html") {
    const html = input.htmlEvidence;
    if (
      !html ||
      html.completeMainDocument !== true ||
      html.domConservationPassed !== true ||
      html.hasUnverifiedNonTextContent !== false ||
      !Number.isSafeInteger(html.sectionCount) ||
      html.sectionCount < 1 ||
      html.canonicalTextSha256 !== canonicalTextSha256
    )
      add("html_conservation_evidence_missing_or_failed");
  }
  const identityHashValid =
    completeLicense.test(licenseNo) && hashPattern.test(input.fetched.sha256);
  const leafletId = tfdaSourceHash(licenseNo + "|" + input.fetched.sha256);
  const version = input.fetched.sha256.slice(0, 16);
  const chunks: Chunk[] = ordered.map((page) => ({
    id: `${leafletId.slice(0, 16)}-${page.page}-0-whole-page-v1-${tfdaSourceHash(page.text).slice(0, 16)}`,
    licenseNo,
    version,
    page: page.page,
    start: 0,
    text: page.text,
    sourceFormat: input.format,
  }));
  const chunksBytes = Buffer.byteLength(JSON.stringify(chunks));
  let draftLeaflet: Leaflet | null =
    identityHashValid && inventoryValid && allTextPresent && allPagesFit
      ? {
          id: leafletId,
          licenseNo,
          version,
          sourceUrl: input.fetched.requestedUrl,
          sha256: input.fetched.sha256,
          storagePath: `leaflets/${leafletId}.${input.format}`,
          chunks,
          status: "draft",
          checkedBy: null,
          checkedAt: null,
          sourceMediaType:
            input.format === "pdf" ? "application/pdf" : "text/html",
        }
      : null;
  const serializedDraftBytes = draftLeaflet
    ? Buffer.byteLength(JSON.stringify(draftLeaflet))
    : 0;
  if (
    chunksBytes > TFDA_SOURCE_LIMITS.sourceDocumentBytes ||
    serializedDraftBytes > TFDA_SOURCE_LIMITS.sourceDocumentBytes
  ) {
    add("source_document_too_large");
    draftLeaflet = null;
  }
  const totalCharacters = ordered.reduce(
    (total, page) => total + page.text.length,
    0,
  );
  const modelBudgetCompatible =
    totalCharacters <= TFDA_SOURCE_LIMITS.runtimeSourceCharacters;
  if (!modelBudgetCompatible)
    warnings.push(
      "complete_source_exceeds_current_model_budget; source must not be clipped",
    );
  const eligibleTechnical = reasons.size === 0 && !!draftLeaflet;
  return {
    status: eligibleTechnical
      ? "technically_eligible"
      : draftLeaflet
        ? "needs_review"
        : "raw_only",
    acquired:
      Number.isSafeInteger(input.fetched.bytes) && input.fetched.bytes > 0,
    rawOnly: !draftLeaflet,
    draft: !!draftLeaflet,
    eligibleTechnical,
    runtimeCompatible: eligibleTechnical && modelBudgetCompatible,
    reasons: [...reasons],
    warnings,
    criteria: TFDA_TECHNICAL_CRITERIA,
    draftLeaflet,
    canonicalTextSha256,
    evidence: {
      catalogRowCount: catalogRows.length,
      coalescedProductCount: products.size,
      ...(sharedManufacturingProduct ? { catalogManufacturingRecords: structuredClone(input.catalogManufacturingRecords!) } : {}),
      indexRowCount: indexRows.length,
      indexUrlCount: indexUrls.length,
      totalCharacters,
      serializedDraftBytes,
      chunksBytes,
      modelBudgetCompatible,
      matchedCurrentName,
      printedCompleteLicenses,
      pages: pageEvidence,
    },
  };
}
