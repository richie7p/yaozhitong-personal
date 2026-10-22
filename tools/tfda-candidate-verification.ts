/** Re-derive candidate text from its actual frozen bytes. Local child processes only. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  normalizeTfdaSourceText,
  type TfdaSourceInput,
  type TfdaSourcePage,
} from "./tfda-source-core.js";
import {
  publicationHash, publicationRequire as must, sameDocument,
  type RawCandidateVerification,
} from "./tfda-publication-core.js";

const runFile = promisify(execFile);
const pythonHelper = fileURLToPath(new URL("./fetch-tfda-sources.py", import.meta.url));
const pdfjsHelper = fileURLToPath(new URL("./prepare-tfda-sources.ts", import.meta.url));
const childOptions = { maxBuffer: 8_000_000, windowsHide: true, encoding: "utf8" as const };
export async function derivePdfFromRaw(rawPath: string, raw: Buffer, options: { python?: string } = {}): Promise<{
  numPages: number; pages: TfdaSourcePage[]; rawVerification: RawCandidateVerification;
}> {
  must(raw.length > 0 && raw.length <= 15000000 && raw.subarray(0, 5).toString() === "%PDF-", "raw_pdf_signature_or_size_invalid");
  const [helperBytes, canonicalAdapterBytes, adapterBytes] = await Promise.all([
    readFile(pythonHelper), readFile(pdfjsHelper), readFile(fileURLToPath(import.meta.url)),
  ]);
  const results = await Promise.allSettled([
    runFile(process.execPath, ["--import", "tsx", pdfjsHelper, "--extract-one", rawPath], { ...childOptions, timeout: 60_000 }),
    runFile(options.python || "python", ["-X", "utf8", pythonHelper, "--inspect-pdf-internal", rawPath], {
      ...childOptions, timeout: 45_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    }),
  ]);
  must(results.every((result) => result.status === "fulfilled"), "raw_pdf_verification_engine_unavailable_or_failed");
  let canonical: any, independent: any;
  try {
    canonical = JSON.parse((results[0] as PromiseFulfilledResult<{ stdout: string }>).value.stdout.trim());
    independent = JSON.parse((results[1] as PromiseFulfilledResult<{ stdout: string }>).value.stdout.trim());
  } catch { throw Error("raw_pdf_verification_engine_invalid_json"); }
  const rawSha256 = publicationHash(raw);
  must(canonical.rawSha256 === rawSha256 && independent.rawSha256 === rawSha256 &&
    canonical.rawBytes === raw.length && independent.rawBytes === raw.length, "raw_pdf_inspection_bytes_binding_mismatch");
  must(!canonical.error && !independent.error && canonical.parser === "pdfjs-dist" && independent.sourceFormat === "pdf" &&
    independent.schemaVersion === 3 && independent.parserVersion === "tfda-pdf-independent-v3" && independent.allPhysicalPagesExtracted === true,
    "raw_pdf_complete_independent_extraction_failed");
  const count = canonical.numPages;
  must(Number.isSafeInteger(count) && count > 0 && count <= 200 && independent.physicalPageCount === count &&
    Array.isArray(canonical.pages) && Array.isArray(independent.pages) && canonical.pages.length === count && independent.pages.length === count &&
    canonical.pages.every((page: any, i: number) => page.page === i + 1 && typeof page.text === "string") &&
    independent.pages.every((page: any, i: number) => page.page === i + 1), "raw_pdf_physical_page_inventory_mismatch");
  must(independent.pages.every((page: any) => page.primaryEngine === "pdfplumber"), "raw_pdf_required_independent_engine_missing");
  must(independent.pages.every((page: any) => page.primaryParseError === null && page.pypdfParseError === null &&
    page.pageCharacterLimitExceeded === false && page.textOmittedReason === null &&
    typeof page.text === "string" && typeof page.pypdfText === "string" &&
    Number.isSafeInteger(page.imageCount) && page.imageCount >= 0 &&
    typeof page.imageLarge === "boolean" && typeof page.imageGeometryUnknown === "boolean" &&
    typeof page.hasUnverifiedStructure === "boolean" && page.structureEvidence?.version === "tfda-pdf-structure-v1" &&
    ["review_required", "single_flow_no_detected_structure", "empty_page_no_structure"].includes(page.structureEvidence.status) &&
    (page.hasUnverifiedStructure ? page.structureEvidence.status === "review_required" :
      ["single_flow_no_detected_structure", "empty_page_no_structure"].includes(page.structureEvidence.status)) &&
    Array.isArray(page.structureEvidence.reasons) &&
    Array.isArray(page.imageAreaRatios) && Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0),
    "raw_pdf_page_text_or_image_evidence_unavailable");
  const pages: TfdaSourcePage[] = canonical.pages.map((page: any, i: number) => {
    const peer = independent.pages[i];
    return { page: page.page, text: page.text, independentText: peer.text, additionalIndependentText: peer.pypdfText,
      embeddedImages: peer.imageCount, hasLargeUnverifiedImage: peer.imageLarge || peer.imageGeometryUnknown,
      hasUnverifiedStructure: peer.hasUnverifiedStructure, structureEvidence: peer.structureEvidence };
  });
  return { numPages: count, pages, rawVerification: {
    schema: "tfda-candidate-raw-verification/v1", method: "pdf_raw_three_engine_reparse_v1", rawSha256, rawBytes: raw.length,
    canonicalTextSha256: publicationHash(pages.map((page) => page.text).join("\n\n")),
    derivedPagesSha256: publicationHash(JSON.stringify(pages)), derivedHtmlEvidenceSha256: null,
    parserHelperSha256: publicationHash(helperBytes), adapterSha256: publicationHash(adapterBytes),
    canonicalAdapterSha256: publicationHash(canonicalAdapterBytes), rawInspectionSha256: publicationHash(JSON.stringify({ canonical, independent })),
  } };
}
export async function verifyCandidateFromRaw(
  rawPath: string, raw: Buffer, input: TfdaSourceInput, options: { python?: string } = {},
): Promise<RawCandidateVerification> {
  if (input.format === "pdf") {
    const derived = await derivePdfFromRaw(rawPath, raw, options);
    must(input.numPages === derived.numPages && sameDocument(input.pages, derived.pages), "candidate_pdf_pages_do_not_match_raw_source");
    return derived.rawVerification;
  }
  must(input.format === "html", "unsupported_candidate_raw_format");
  const helperBytes = await readFile(pythonHelper), adapterBytes = await readFile(fileURLToPath(import.meta.url));
  let report: any;
  try {
    const result = await runFile(options.python || "python", ["-X", "utf8", pythonHelper,
      "--inspect-html-internal", rawPath, input.fetched.finalUrl], {
      timeout: 45_000, maxBuffer: 8_000_000, windowsHide: true, encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    report = JSON.parse(result.stdout.trim());
  } catch {
    // Missing runtime/dependencies, timeout, parse failure and excess output all fail closed.
    throw Error("raw_html_verification_helper_unavailable_or_failed");
  }
  must(report?.rawSha256 === publicationHash(raw) && report.rawBytes === raw.length &&
    report.sourceUrl === input.fetched.finalUrl, "raw_html_inspection_bytes_binding_mismatch");
  must(report.schemaVersion === 4 && report.parserVersion === "tfda-complete-dom-v4" &&
    report.sourceFormat === "html" && report.tableSerializationVersion === "tfda-simple-table-literal-v1" &&
    report.toggleAllCount >= 1 && report.bodyCandidateCount === 1 &&
    report.allMainBlocksAccounted === true && report.unaccountedMainBlockCount === 0 &&
    report.identityFields && report.ambiguousIdentityFields &&
    Object.keys(report.ambiguousIdentityFields).every((label) => ["製造廠名稱", "製造廠地址"].includes(label)) &&
    Array.isArray(report.sections) && Array.isArray(report.nonTextImages), "raw_html_inspection_structure_invalid");
  const fields = report.identityFields;
  const labels = ["中文品名", "英文品名", "許可證號", "藥品類別"];
  must(labels.every((label) => typeof fields[label] === "string") &&
    !!(fields["中文品名"].trim() || fields["英文品名"].trim()) && fields["藥品類別"].trim() &&
    normalizeTfdaSourceText(fields["許可證號"]) === normalizeTfdaSourceText(input.licenseNo),
    "raw_html_current_identity_field_missing_or_mismatch");
  const product = input.catalogRows[0];
  must(product && normalizeTfdaSourceText(fields["中文品名"]) === normalizeTfdaSourceText(product.nameZh) &&
    normalizeTfdaSourceText(fields["英文品名"]) === normalizeTfdaSourceText(product.nameEn),
    "raw_html_current_product_header_mismatch");
  const prefix = labels.map((label) => fields[label]).join("\n");
  must(typeof report.normalizedSectionText === "string", "raw_html_complete_section_text_missing");
  const text = prefix + "\n\n" + report.normalizedSectionText;
  const unverified = report.hasUnverifiedNonTextContent !== false || report.simpleTablesConserved !== true ||
    report.complexTableCount !== 0 || report.tableSerializationVersion !== "tfda-simple-table-literal-v1";
  const pages = [{ page: 1, text, embeddedImages: report.nonTextImages.length, hasLargeUnverifiedImage: unverified }];
  const htmlEvidence = { completeMainDocument: report.fullDomConserved === true,
    domConservationPassed: report.fullDomConserved === true, canonicalTextSha256: publicationHash(text),
    sectionCount: report.sections.length, hasUnverifiedNonTextContent: unverified };
  must(input.numPages === 1 && sameDocument(input.pages, pages), "candidate_html_pages_do_not_match_raw_source");
  must(sameDocument(input.htmlEvidence, htmlEvidence), "candidate_html_evidence_does_not_match_raw_source");
  // The helper's needs_review summary also covers repeated factory metadata.
  // All other ambiguity and every conservation/nontext condition were checked above.
  const multiFactoryMetadata = Object.keys(report.ambiguousIdentityFields).length > 0;
  must(report.fullDomConserved === true && !unverified && (report.status === "independent_dom_extracted_draft" ||
    multiFactoryMetadata && report.status === "needs_review"),
    "raw_html_conservation_or_nontext_gate_failed");
  return { schema: "tfda-candidate-raw-verification/v1", method: "html_raw_dom_reparse_v4",
    rawSha256: publicationHash(raw), rawBytes: raw.length, canonicalTextSha256: publicationHash(text),
    derivedPagesSha256: publicationHash(JSON.stringify(pages)), derivedHtmlEvidenceSha256: publicationHash(JSON.stringify(htmlEvidence)),
    parserHelperSha256: publicationHash(helperBytes), adapterSha256: publicationHash(adapterBytes),
    canonicalAdapterSha256: null, rawInspectionSha256: publicationHash(JSON.stringify(report)),
    // Several factories/processes may be listed for one product. Preserve every value;
    // this does not establish a unique manufacturer or relax product identity checks.
    ...(multiFactoryMetadata ? { htmlMultiFactoryMetadata: report.ambiguousIdentityFields } : {}) };
}
