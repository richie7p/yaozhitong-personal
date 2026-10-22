/** Complete current-role alias proof. Raw equality never establishes a different license. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TfdaFetchedArtifact } from "./tfda-source-core.js";
import { publicationRequire as need } from "./tfda-publication-core.js";

export interface CurrentEquivalentSource {
  fullLicense: string;
  rawSourcePath: string;
  rawSourceSha256: string;
  rawMetadataPath: string;
  rawMetadataSha256: string;
  fetched: TfdaFetchedArtifact;
  allArchiveRoles: Record<string, unknown>[];
}
export interface EquivalentParentSource {
  rawSourcePath: string;
  rawSourceSha256: string;
  fetched: TfdaFetchedArtifact;
  currentEquivalentSources: CurrentEquivalentSource[];
}
export interface CurrentPaperEquivalenceArtifact {
  fullLicense: string;
  fetched: TfdaFetchedArtifact;
  rawSha256: string;
  rawBytes: number;
  rawMetadataSha256: string;
  allArchiveRoles: Record<string, unknown>[];
}
export interface CurrentPaperEquivalence {
  schema: "tfda-current-paper-byte-equivalence/v1";
  licenseNo: string;
  parentRawSha256: string;
  parentDomInspectionSha256: string;
  representativeUrl: string;
  orderedCurrentUrls: string[];
  sharedRawSha256: string;
  sharedRawBytes: number;
  artifacts: CurrentPaperEquivalenceArtifact[];
}
/** v2 remains a separate strict single-current proof; no scope/method aliasing. */
export interface ParentPaperEquivalentVerification {
  schema: "tfda-current-parent-paper-verification/v3";
  method: "official_index_parent_raw_equivalent_current_papers_reparse_v1";
  scope: "complete_byte_equivalent_current_papers_excluding_explicit_history";
  licenseNo: string; indexUrl: string; parentFinalUrl: string;
  parentRawSha256: string; parentRawBytes: number; parentStoragePath: string;
  parentRetrievedAt: string; parentRedirectChain: string[];
  currentPaperUrls: string[]; historicalPaperUrls: string[];
  excludedHistoricalPaperUrls: string[]; excludedHistoricalElectronicUrls: string[];
  branchInventory: { popups: Record<string, unknown>[]; anchors: Record<string, unknown>[] };
  childUrl: string; childRawSha256: string;
  officialCatalogSha256: string; officialIndexSha256: string;
  parentIdentitySha256: string; parentDomInspectionSha256: string;
  parserHelperSha256: string; fetchDependencySha256: string; adapterSha256: string;
  parentDomInvalidReasons: ["current_paper_url_count_not_one"];
  equivalenceVerifierSha256: string;
  currentPaperEquivalence: CurrentPaperEquivalence;
}

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const official = (value: unknown): value is string => { try { if (typeof value !== "string") return false; const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") &&
    (u.hostname === "fda.gov.tw" || u.hostname.endsWith(".fda.gov.tw")) && !/^\/insert\/pdfcase\/?$/iu.test(decodeURIComponent(u.pathname));
} catch { return false; } };
const canonical = (value: string) => { need(official(value), "equivalent_source_nonofficial_or_placeholder_url"); return new URL(value).href; };
const collisionKey = (value: string) => { const u = new URL(canonical(value));
  return JSON.stringify([u.protocol.toLowerCase(), u.hostname.toLowerCase(), decodeURIComponent(u.pathname),
    [...u.searchParams].sort(([ak,av], [bk,bv]) => ak.localeCompare(bk) || av.localeCompare(bv))]); };
function fresh(value: string, now: number) { const stamp = Date.parse(value); need(Number.isFinite(stamp) && stamp <= now + 60_000 &&
  now - stamp < 86_400_000, "equivalent_source_receipt_not_fresh"); }

/** Derive a download artifact from the ORIGINAL archive result, not a renewed timestamp. */
export function equivalentFetchedFromReceipt(record: any): TfdaFetchedArtifact {
  const requested = record?.requestedUrl || record?.sourceUrl, final = record?.finalUrl;
  need(record?.httpStatus === 200 && official(requested) && official(final) &&
    /^downloaded_/u.test(record?.status || "") && (record?.archiveMediaKind || record?.sourceType) === "pdf" &&
    !record?.rawVersions, "equivalent_source_successful_single_pdf_receipt_required");
  if (record.redirectChain !== undefined && record.redirects !== undefined)
    need(isDeepStrictEqual(record.redirectChain, record.redirects), "equivalent_source_conflicting_redirect_receipts");
  const redirects = record.redirectChain ?? record.redirects;
  need(Array.isArray(redirects), "equivalent_source_explicit_redirect_receipt_required");
  const chain: string[] = []; let expected = requested;
  for (const hop of redirects) {
    need(hop && official(hop.from) && official(hop.to) && [301,302,303,307,308].includes(hop.httpStatus ?? hop.status) &&
      (hop.httpStatus === undefined || hop.status === undefined || hop.httpStatus === hop.status) && canonical(hop.from) === canonical(expected),
      "equivalent_source_redirect_receipt_invalid");
    if (!chain.length) chain.push(hop.from); chain.push(hop.to); expected = hop.to;
  }
  need(canonical(expected) === canonical(final), "equivalent_source_missing_actual_redirect_receipt");
  if (!chain.length) chain.push(requested);
  return { requestedUrl: requested, finalUrl: final, redirectChain: chain, retrievedAt: record.fetchedAt || record.at,
    sha256: record.sourceBlobSha256 || record.sha256, bytes: record.bytes, mediaType: record.contentType || record.mediaType, contentSignature: "pdf" };
}
export interface CurrentPaperEquivalenceBinding { source: CurrentEquivalentSource; rawBytes: Uint8Array; metadataBytes: Uint8Array }

/** All current aliases must prove the SAME original bytes. This proves association only. */
export function verifyCurrentPaperEquivalence(args: {
  licenseNo: string; parentFetched: TfdaFetchedArtifact; parentDomReport: any;
  sources: CurrentPaperEquivalenceBinding[]; representativeFetched: TfdaFetchedArtifact; now: number;
}): CurrentPaperEquivalence {
  const { licenseNo, parentFetched, parentDomReport: report, sources, representativeFetched, now } = args;
  need(/^(?:衛署|衛部|內衛)[\p{Script=Han}]{1,12}字第(?:R\d{5,7}|\d{6,8})號$/u.test(licenseNo) && Number.isFinite(now), "equivalent_source_full_license_and_clock_required");
  need(report?.schema === "tfda-parent-paper-association/v2" && report?.parserVersion === "tfda-parent-paper-strict-v2" && report?.schemaVersion === 2 &&
    report.associationValid === false && isDeepStrictEqual(report.invalidReasons, ["current_paper_url_count_not_one"]) &&
    report.scope === "single_current_paper_excluding_explicit_history" && report.allScopedAnchorsAccounted === true &&
    report.currentPopupCount === 1 && report.historicalPopupCount <= 1 && Array.isArray(report.currentOtherUrls) && !report.currentOtherUrls.length &&
    Array.isArray(report.orderedScopedResources) && !report.orderedScopedResources.length &&
    Array.isArray(report.currentPaperUrls) && report.currentPaperUrls.length >= 2 && report.currentPaperUrls.length <= 50 &&
    Array.isArray(report.historicalPaperUrls) && isDeepStrictEqual(report.historicalPaperUrls, report.excludedHistoricalPaperUrls) &&
    Array.isArray(report.historicalOtherUrls) && isDeepStrictEqual(report.historicalOtherUrls, report.excludedHistoricalElectronicUrls) &&
    Array.isArray(report.orderedPopups) && Array.isArray(report.orderedAnchors) && report.ambiguousIdentityFields && !Object.keys(report.ambiguousIdentityFields).length &&
    report.rawSha256 === parentFetched.sha256 && report.rawBytes === parentFetched.bytes && canonical(report.sourceUrl) === canonical(parentFetched.finalUrl),
    "equivalent_parent_complete_dom_inventory_required");
  fresh(parentFetched.retrievedAt, now);
  const orderedCurrentUrls: string[] = report.currentPaperUrls;
  const keys = orderedCurrentUrls.map(collisionKey), historicalKeys = [...report.excludedHistoricalPaperUrls, ...report.excludedHistoricalElectronicUrls].map(collisionKey);
  need(new Set(keys).size === keys.length && keys.every(key => !historicalKeys.includes(key)), "equivalent_source_current_history_or_alias_collision");
  need(sources.length === orderedCurrentUrls.length && sources.every((entry, i) => entry.source.fetched.requestedUrl === orderedCurrentUrls[i]) &&
    representativeFetched.requestedUrl === orderedCurrentUrls[0], "equivalent_source_complete_dom_order_required");
  let sharedRawSha256 = "", sharedRawBytes = 0;
  const artifacts: CurrentPaperEquivalenceArtifact[] = sources.map(({ source, rawBytes, metadataBytes }, i) => {
    need(source.fullLicense === licenseNo && rawBytes.length > 0 && rawBytes.length <= 15_000_000 &&
      Buffer.from(rawBytes.subarray(0, 5)).toString() === "%PDF-" && sha(rawBytes) === source.rawSourceSha256 &&
      sha(metadataBytes) === source.rawMetadataSha256 && metadataBytes.length > 0 && metadataBytes.length <= 2_000_000,
      "equivalent_source_actual_raw_or_metadata_binding_invalid");
    let envelope: any; try { envelope = JSON.parse(Buffer.from(metadataBytes).toString("utf8")); } catch { need(false, "equivalent_source_native_metadata_invalid_json"); }
    need(envelope && isDeepStrictEqual(Object.keys(envelope).sort(), ["job", "result"]) && envelope.job?.sourceUrl === orderedCurrentUrls[i] &&
      envelope.job?.origin !== "derived_known_official_license_route" && Array.isArray(envelope.job?.parents) && envelope.job.parents.length > 0 &&
      isDeepStrictEqual(envelope.job.parents, source.allArchiveRoles) && isDeepStrictEqual(envelope.result?.parents, envelope.job.parents) &&
      Array.isArray(envelope.job?.cohorts) && envelope.job.cohorts.includes("current_paper") && !envelope.job.cohorts.some((role: string) => /historical/iu.test(role)),
      "equivalent_source_all_native_roles_required");
    need(source.allArchiveRoles.every((role) => role.fullLicense === licenseNo && role.licenseState === "active" &&
      role.discoveryType === "current_paper" && role.sourceAttribute === "paperLinks" && role.literalUrl === orderedCurrentUrls[i] &&
      role.parentSourceUrl === parentFetched.requestedUrl && role.parentFinalUrl === parentFetched.finalUrl &&
      role.parentRawSha256 === parentFetched.sha256 && role.parentFetchedAt === parentFetched.retrievedAt &&
      role.parentUrlHash === sha(parentFetched.requestedUrl) && role.association !== "no_Info39_association"), "equivalent_source_role_cross_license_or_parent_mismatch");
    const actualFetched = equivalentFetchedFromReceipt(envelope.result);
    need(isDeepStrictEqual(actualFetched, source.fetched) && actualFetched.requestedUrl === orderedCurrentUrls[i] &&
      actualFetched.sha256 === sha(rawBytes) && actualFetched.bytes === rawBytes.length && /^(?:application\/pdf)(?:;|$)/iu.test(actualFetched.mediaType),
      "equivalent_source_original_receipt_differs_from_manifest");
    fresh(actualFetched.retrievedAt, now);
    if (!i) { sharedRawSha256 = sha(rawBytes); sharedRawBytes = rawBytes.length; }
    need(sha(rawBytes) === sharedRawSha256 && rawBytes.length === sharedRawBytes && Buffer.from(rawBytes).equals(Buffer.from(sources[0].rawBytes)),
      "equivalent_source_current_bytes_differ");
    return { fullLicense: licenseNo, fetched: actualFetched, rawSha256: sha(rawBytes), rawBytes: rawBytes.length,
      rawMetadataSha256: sha(metadataBytes), allArchiveRoles: source.allArchiveRoles };
  });
  need(isDeepStrictEqual(representativeFetched, artifacts[0].fetched), "equivalent_source_representative_receipt_not_dom_first");
  return { schema: "tfda-current-paper-byte-equivalence/v1", licenseNo, parentRawSha256: parentFetched.sha256,
    parentDomInspectionSha256: sha(JSON.stringify(report)), representativeUrl: orderedCurrentUrls[0], orderedCurrentUrls,
    sharedRawSha256, sharedRawBytes, artifacts };
}
