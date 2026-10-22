/** Local-only independent current-paper association and serial PDF verification. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizeTfdaSourceText as norm, type TfdaSourceInput, type TfdaSourcePage, type TfdaOfficialAssociation } from "./tfda-source-core.js";
import { assertFreshTimestamp, assertOfficialPatientCategory, publicationHash as hash, publicationRequire as must, sameDocument,
  type PublicationBatchItem, type PublicationDoc, type PublicationIndexSnapshot, type ParentPaperVerification, type RawCandidateVerification } from "./tfda-publication-core.js";

const run = promisify(execFile);
const parentHelper = fileURLToPath(new URL("./inspect-tfda-parent-paper.py", import.meta.url));
const fetchHelper = fileURLToPath(new URL("./fetch-tfda-sources.py", import.meta.url));
const canonicalHelper = fileURLToPath(new URL("./prepare-tfda-sources.ts", import.meta.url));
const adapter = fileURLToPath(import.meta.url);
const options = { maxBuffer: 8_000_000, windowsHide: true, encoding: "utf8" as const };
const official = (value: string) => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password &&
  (!url.port || url.port === "443") && (url.hostname === "fda.gov.tw" || url.hostname.endsWith(".fda.gov.tw")) && !/^\/insert\/pdfcase\/?$/iu.test(url.pathname); } catch { return false; } };
const canonicalUrl = (value: string) => { must(official(value), "parent_paper_nonofficial_or_invalid_url"); return new URL(value).href; };
const sourceUrls = (value: unknown) => typeof value === "string" ? value.match(/https?:\/\/[^\s;<>"\u3000]+/gu) || [] : [];
const localDay = (now: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
function validExpiry(value: string, today: string) {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/u.exec(value || "");
  if (!match) return false;
  const date = `${match[1]}-${match[2]}-${match[3]}`, time = Date.parse(date + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date && date >= today;
}
export function parentBlobPath(rawSha256: string) {
  must(/^[a-f0-9]{64}$/u.test(rawSha256), "parent_raw_hash_invalid");
  return `leaflets/${hash("official-current-parent|" + rawSha256)}.html`;
}
export function assertParentProofSize(proof: ParentPaperVerification) {
  must(Buffer.byteLength(JSON.stringify(proof), "utf8") <= 100_000, "parent_branch_proof_exceeds_100000_bytes_no_truncation");
}
export async function verifyParentPaperSource(parent: NonNullable<PublicationBatchItem["parentSource"]>, input: TfdaSourceInput,
  rawPath: string, raw: Buffer, catalogRows: PublicationDoc[], indexRows: PublicationDoc[], snapshots: PublicationIndexSnapshot[],
  { python = "python", now = Date.now() }: { python?: string; now?: number } = {}): Promise<{ association: TfdaOfficialAssociation; proof: ParentPaperVerification }> {
  must(parent && raw.length > 0 && raw.length <= 15_000_000 && hash(raw) === parent.rawSourceSha256 &&
    parent.fetched?.sha256 === hash(raw) && parent.fetched.bytes === raw.length && parent.fetched.contentSignature === "html" &&
    /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(parent.fetched.mediaType) && /<html[\s>]|<!doctype html/iu.test(raw.toString("utf8", 0, Math.min(raw.length, 1000))),
    "parent_raw_bytes_hash_or_html_signature_mismatch");
  assertFreshTimestamp(parent.fetched.retrievedAt, now, "parent_source_not_fresh");
  const requested = canonicalUrl(parent.fetched.requestedUrl), final = canonicalUrl(parent.fetched.finalUrl);
  const hops = parent.fetched.redirectChain || [parent.fetched.requestedUrl];
  must(hops.length > 0 && hops.every(official) && canonicalUrl(hops[0]) === requested && canonicalUrl(hops.at(-1)!) === final &&
    (requested === final || hops.length > 1), "parent_redirect_history_incomplete_or_unsafe");
  const selectedCatalog = catalogRows.filter((row) => row["許可證字號"] === input.licenseNo);
  const selectedIndex = indexRows.filter((row) => row["許可證字號"] === input.licenseNo);
  assertOfficialPatientCategory(catalogRows, input.licenseNo, input.officialCategory);
  must(selectedCatalog.length > 0 && selectedCatalog.every((row) => !String(row["註銷狀態"] || "").trim() && validExpiry(row["有效日期"], localDay(now))), "parent_current_license_revoked_expired_or_missing");
  const identity = (row: PublicationDoc) => ["許可證字號", "中文品名", "英文品名", "劑型", "製造商名稱", "有效日期"].map((key) => norm(row[key] || ""));
  must(new Set(selectedCatalog.map((row) => JSON.stringify(identity(row)))).size === 1, "parent_current_catalog_identity_ambiguous");
  const indexed = [...new Set(selectedIndex.flatMap((row) => sourceUrls(row["仿單圖檔連結"])).map(canonicalUrl))];
  must(indexed.length === 1 && indexed[0] === requested, "parent_must_be_unique_actual_Info39_url");
  const catalog = selectedCatalog[0];
  must(selectedIndex.length > 0 && selectedIndex.every((row) => norm(row["中文品名"] || "") === norm(catalog["中文品名"] || "") &&
    norm(row["英文品名"] || "") === norm(catalog["英文品名"] || "")), "parent_official_index_title_mismatch");
  let report: any;
  try { const result = await run(python, ["-X", "utf8", parentHelper, "--raw", rawPath, "--source-url", parent.fetched.finalUrl],
    { ...options, timeout: 45_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", OMP_NUM_THREADS: "1" } }); report = JSON.parse(result.stdout.trim()); }
  catch { throw Error("parent_raw_reparse_unavailable_or_failed"); }
  const [parserBytes, dependencyBytes, adapterBytes] = await Promise.all([readFile(parentHelper), readFile(fetchHelper), readFile(adapter)]);
  must(report.schema === "tfda-parent-paper-association/v1" && report.parserVersion === "tfda-parent-paper-strict-v1" && report.schemaVersion === 1 &&
    report.rawSha256 === hash(raw) && report.rawBytes === raw.length && canonicalUrl(report.sourceUrl) === final &&
    report.parserHelperSha256 === hash(parserBytes) && report.fetchDependencySha256 === hash(dependencyBytes), "parent_raw_reparse_binding_invalid");
  must(report.associationValid === true && Array.isArray(report.invalidReasons) && report.invalidReasons.length === 0 &&
    report.scope === "single_current_paper_excluding_explicit_electronic_history" && report.allScopedAnchorsAccounted === true &&
    report.currentPopupCount === 1 && report.historicalPopupCount <= 1 && Array.isArray(report.currentOtherUrls) && report.currentOtherUrls.length === 0 &&
    Array.isArray(report.orderedScopedResources) && report.orderedScopedResources.length === 0 &&
    Array.isArray(report.currentPaperUrls) && report.currentPaperUrls.length === 1 && Array.isArray(report.historicalPaperUrls) && report.historicalPaperUrls.length === 0 &&
    Array.isArray(report.excludedHistoricalElectronicUrls) && Array.isArray(report.historicalOtherUrls) &&
    sameDocument(report.historicalOtherUrls, report.excludedHistoricalElectronicUrls) && report.excludedHistoricalElectronicUrls.every(official) &&
    Array.isArray(report.orderedPopups) && Array.isArray(report.orderedAnchors) && report.ambiguousIdentityFields && !Object.keys(report.ambiguousIdentityFields).length,
    "parent_current_paper_branch_inventory_ambiguous_or_historical");
  must(norm(report.identityFields?.["許可證號"]) === norm(input.licenseNo) &&
    norm(report.identityFields?.["中文品名"]) === norm(catalog["中文品名"] || "") && norm(report.identityFields?.["英文品名"]) === norm(catalog["英文品名"] || "") &&
    norm(report.identityFields?.["藥品類別"]) === norm(assertOfficialPatientCategory(catalogRows, input.licenseNo)), "parent_current_complete_identity_or_category_mismatch");
  const childUrl = canonicalUrl(input.fetched.requestedUrl);
  must(canonicalUrl(report.currentPaperUrls[0]) === childUrl && !report.excludedHistoricalElectronicUrls.some((url: string) => canonicalUrl(url) === childUrl) &&
    /^[a-f0-9]{64}$/u.test(input.fetched.sha256), "parent_current_child_url_not_exact_match");
  const association: TfdaOfficialAssociation = { indexUrl: parent.fetched.requestedUrl, detailUrl: parent.fetched.finalUrl,
    licenseNo: input.licenseNo, linkedSourceUrls: [input.fetched.requestedUrl], retrievedAt: parent.fetched.retrievedAt, detailSha256: hash(raw) };
  if (input.officialAssociation !== undefined) must(sameDocument(input.officialAssociation, association), "candidate_parent_claim_differs_from_raw_parent");
  const catalogSnapshot = snapshots.find((entry) => entry.infoId === 36), indexSnapshot = snapshots.find((entry) => entry.infoId === 39);
  must(catalogSnapshot && indexSnapshot, "parent_both_official_index_hashes_required");
  const proof: ParentPaperVerification = { schema: "tfda-current-parent-paper-verification/v1", method: "official_index_parent_raw_current_paper_reparse_v1",
    licenseNo: input.licenseNo, indexUrl: parent.fetched.requestedUrl, parentFinalUrl: parent.fetched.finalUrl,
    parentRawSha256: hash(raw), parentRawBytes: raw.length, parentStoragePath: parentBlobPath(hash(raw)), parentRetrievedAt: parent.fetched.retrievedAt,
    parentRedirectChain: hops, currentPaperUrls: [input.fetched.requestedUrl], historicalPaperUrls: [], childUrl: input.fetched.requestedUrl, childRawSha256: input.fetched.sha256,
    excludedHistoricalElectronicUrls: report.excludedHistoricalElectronicUrls, branchInventory: { popups: report.orderedPopups, anchors: report.orderedAnchors },
    officialCatalogSha256: catalogSnapshot.sha256, officialIndexSha256: indexSnapshot.sha256,
    parentIdentitySha256: hash(JSON.stringify(report.identityFieldOccurrences)), parentDomInspectionSha256: hash(JSON.stringify(report)),
    parserHelperSha256: hash(parserBytes), fetchDependencySha256: hash(dependencyBytes), adapterSha256: hash(adapterBytes) };
  assertParentProofSize(proof); return { association, proof };
}

/** Same three engines/physical/image/structure evidence as direct PDF verification, executed serially. */
export async function deriveSerialPaperPdf(rawPath: string, raw: Buffer, { python = "python" }: { python?: string } = {}) {
  must(raw.length > 0 && raw.length <= 15_000_000 && raw.subarray(0, 5).toString() === "%PDF-", "paper_pdf_signature_or_size_invalid");
  let canonical: any, independent: any;
  try {
    canonical = JSON.parse((await run(process.execPath, ["--import", "tsx", canonicalHelper, "--extract-one", rawPath], { ...options, timeout: 60_000 })).stdout.trim());
    independent = JSON.parse((await run(python, ["-X", "utf8", fetchHelper, "--inspect-pdf-internal", rawPath], { ...options, timeout: 45_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", OMP_NUM_THREADS: "1" } })).stdout.trim());
  } catch { throw Error("paper_pdf_required_engine_unavailable_or_failed"); }
  const rawSha256 = hash(raw), count = canonical.numPages;
  must(canonical.rawSha256 === rawSha256 && independent.rawSha256 === rawSha256 && canonical.rawBytes === raw.length && independent.rawBytes === raw.length &&
    !canonical.error && !independent.error && canonical.parser === "pdfjs-dist" && independent.sourceFormat === "pdf" && independent.schemaVersion === 3 &&
    independent.parserVersion === "tfda-pdf-independent-v3" && independent.allPhysicalPagesExtracted === true, "paper_pdf_complete_independent_extraction_failed");
  must(Number.isSafeInteger(count) && count > 0 && count <= 200 && independent.physicalPageCount === count && Array.isArray(canonical.pages) && Array.isArray(independent.pages) &&
    canonical.pages.length === count && independent.pages.length === count && canonical.pages.every((page: any, i: number) => page.page === i + 1 && typeof page.text === "string") &&
    independent.pages.every((page: any, i: number) => page.page === i + 1), "paper_pdf_complete_physical_inventory_invalid");
  must(independent.pages.every((page: any) => page.primaryEngine === "pdfplumber" && page.primaryParseError === null && page.pypdfParseError === null &&
    page.pageCharacterLimitExceeded === false && page.textOmittedReason === null && typeof page.text === "string" && typeof page.pypdfText === "string" &&
    Number.isSafeInteger(page.imageCount) && page.imageCount >= 0 && typeof page.imageLarge === "boolean" && typeof page.imageGeometryUnknown === "boolean" &&
    typeof page.hasUnverifiedStructure === "boolean" && page.structureEvidence?.version === "tfda-pdf-structure-v1" &&
    (page.hasUnverifiedStructure ? page.structureEvidence.status === "review_required" : ["single_flow_no_detected_structure", "empty_page_no_structure"].includes(page.structureEvidence.status)) &&
    Array.isArray(page.structureEvidence.reasons) && Array.isArray(page.imageAreaRatios) && Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0),
    "paper_pdf_complete_text_image_structure_evidence_missing");
  const pages: TfdaSourcePage[] = canonical.pages.map((page: any, i: number) => { const peer = independent.pages[i]; return {
    page: page.page, text: page.text, independentText: peer.text, additionalIndependentText: peer.pypdfText, embeddedImages: peer.imageCount,
    hasLargeUnverifiedImage: peer.imageLarge || peer.imageGeometryUnknown, hasUnverifiedStructure: peer.hasUnverifiedStructure, structureEvidence: peer.structureEvidence,
  }; });
  const [helperBytes, canonicalBytes, adapterBytes] = await Promise.all([readFile(fetchHelper), readFile(canonicalHelper), readFile(adapter)]);
  const rawVerification: RawCandidateVerification = { schema: "tfda-candidate-raw-verification/v1", method: "pdf_raw_three_engine_reparse_v1", rawSha256, rawBytes: raw.length,
    canonicalTextSha256: hash(pages.map((page) => page.text).join("\n\n")), derivedPagesSha256: hash(JSON.stringify(pages)), derivedHtmlEvidenceSha256: null,
    parserHelperSha256: hash(helperBytes), adapterSha256: hash(adapterBytes), canonicalAdapterSha256: hash(canonicalBytes), rawInspectionSha256: hash(JSON.stringify({ canonical, independent })) };
  return { numPages: count, pages, rawVerification };
}
