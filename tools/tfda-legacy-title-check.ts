/**
 * A diagnostic for an already preserved legacy PDF, never a bulk eligibility gate.
 * The caller supplies the first physical page extracted from the same pinned raw
 * bytes. This function verifies bindings and literal title layout, not extraction
 * quality, clinical content, or permission to publish/replace a source.
 */
import { createHash } from "node:crypto";

export interface LegacyTitleInput {
  fullLicense: string;
  now: string;
  baseline: { licenseNo: string; sourceUrl: string; rawSha256: string };
  catalog: { retrievedAt: string; rows: { licenseNo: string; nameZh: string; nameEn: string }[] };
  index: { retrievedAt: string; rows: { licenseNo: string; sourceUrls: string[] }[] };
  currentReceipt: { licenseNo: string; requestedUrl: string; rawSha256: string; fetchedAt: string };
  currentRawBytes: Uint8Array;
  firstPhysicalPage: { page: number; text: string };
}

export const LEGACY_TITLE_BOUNDS = Object.freeze({ physicalLines: 24, nonemptyLines: 12, characters: 1200, freshnessMs: 86_400_000 });
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const normalize = (text: string) => text.normalize("NFKC").replace(/[“”„‟〝〞]/gu, '"').replace(/\s+/gu, "").toLowerCase();
const clinicalStart = (text: string) => /^(?:主成[分份]|有效成[分份]|適應症|用法(?:及)?用量|用法|用量|藥理作用|藥理特性|警語|注意事項|副作用|不良反應|禁忌|成分|賦形劑|過量|包裝|儲存|性狀|說明|本品(?:之|為)|本劑(?:之|為)|本藥(?:之|為)|每(?:錠|粒|毫升))/u.test(normalize(text).replace(/^[\d一二三四五六七八九十.、()【】:：-]+/u, ""));
const iso = (value: string) => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : NaN;
const baseDiagnostic = { scope: "preserved_legacy_title_layout_diagnostic_only", clinicalReviewed: false, sourceEligibilityEstablished: false, sourceWrites: 0 } as const;

export function reconcileLegacyTitle(input: LegacyTitleInput) {
  const fail = (code: string, evidence: Record<string, unknown> = {}) => ({ ...baseDiagnostic, ok: false, code, evidence });
  if (!input || !/^[\p{Script=Han}]{2,12}字第[A-Z]?\d{6}[A-Z]?號$/u.test(input.fullLicense || "")) return fail("complete_license_required");
  if (input.baseline?.licenseNo !== input.fullLicense || input.currentReceipt?.licenseNo !== input.fullLicense) return fail("baseline_receipt_full_license_mismatch");
  if (!Array.isArray(input.catalog?.rows) || input.catalog.rows.length !== 1 || input.catalog.rows[0]?.licenseNo !== input.fullLicense) return fail("unique_exact_current_catalog_row_required");
  if (!Array.isArray(input.index?.rows) || input.index.rows.length !== 1 || input.index.rows[0]?.licenseNo !== input.fullLicense) return fail("unique_exact_current_index_row_required");
  const current = input.catalog.rows[0], index = input.index.rows[0];
  if (typeof current.nameZh !== "string" || typeof current.nameEn !== "string" || !normalize(current.nameZh) || !normalize(current.nameEn)) return fail("complete_bilingual_current_names_required");
  const sourceUrl = input.baseline.sourceUrl;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:" || !(parsed.hostname === "fda.gov.tw" || parsed.hostname.endsWith(".fda.gov.tw")) || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443")) return fail("official_https_baseline_url_required");
  } catch { return fail("official_https_baseline_url_required"); }
  const currentUrls = Array.isArray(index.sourceUrls) ? [...new Set(index.sourceUrls)] : [];
  if (currentUrls.length !== 1 || currentUrls[0] !== sourceUrl || input.currentReceipt.requestedUrl !== sourceUrl) return fail("exact_unique_current_index_baseline_receipt_url_required");
  const now = iso(input.now), timestamps = { catalog: input.catalog.retrievedAt, index: input.index.retrievedAt, currentReceipt: input.currentReceipt.fetchedAt };
  if (!Number.isFinite(now) || Object.values(timestamps).some(value => !Number.isFinite(iso(value)) || now - iso(value) < 0 || now - iso(value) > LEGACY_TITLE_BOUNDS.freshnessMs)) return fail("fresh_official_index_and_current_receipt_required");
  if (!(input.currentRawBytes instanceof Uint8Array) || input.currentRawBytes.length < 5 || input.currentRawBytes.length > 15_000_000 || Buffer.from(input.currentRawBytes.subarray(0, 5)).toString("ascii") !== "%PDF-") return fail("actual_bounded_pdf_bytes_required");
  const actualRawSha256 = sha(input.currentRawBytes);
  if (!/^[a-f0-9]{64}$/u.test(input.baseline.rawSha256) || actualRawSha256 !== input.baseline.rawSha256 || actualRawSha256 !== input.currentReceipt.rawSha256) return fail("actual_baseline_receipt_raw_hash_mismatch", { actualRawSha256 });
  if (input.firstPhysicalPage?.page !== 1 || typeof input.firstPhysicalPage.text !== "string") return fail("first_physical_page_required");

  const firstPage = input.firstPhysicalPage.text.split("\f", 1)[0], lines: { physicalLine: number; text: string; normalized: string }[] = [];
  let characters = 0, rawPrefix = "", stopReason = "end_of_first_page";
  const physicalLines = firstPage.split(/\r\n|\n|\r/u);
  for (let i = 0; i < physicalLines.length; i++) {
    const text = physicalLines[i];
    if (i >= LEGACY_TITLE_BOUNDS.physicalLines) { stopReason = "physical_line_bound"; break; }
    if (clinicalStart(text)) { stopReason = "clinical_body_heading"; break; }
    if (characters + text.length + (i ? 1 : 0) > LEGACY_TITLE_BOUNDS.characters) { stopReason = "character_bound"; break; }
    if (text.trim() && lines.length >= LEGACY_TITLE_BOUNDS.nonemptyLines) { stopReason = "nonempty_line_bound"; break; }
    rawPrefix += (i ? "\n" : "") + text; characters = rawPrefix.length;
    if (text.trim()) lines.push({ physicalLine: i + 1, text, normalized: normalize(text) });
  }
  const nameZh = normalize(current.nameZh), nameEn = normalize(current.nameEn);
  const chinese: typeof lines = [], english: typeof lines = [];
  let zh = "", en = "", projectionStop = "bounded_header_exhausted";
  for (const line of lines) {
    const han = /\p{Script=Han}/u.test(line.normalized), latin = /\p{Script=Latin}/u.test(line.normalized);
    // A mixed or neutral nonempty line is a barrier. Never remove individual
    // words, move a line, or skip uncertain content to complete a product name.
    if (han === latin) { projectionStop = han ? "mixed_script_line_barrier" : "neutral_line_barrier"; break; }
    if (han) { chinese.push(line); zh += line.normalized; }
    else { english.push(line); en += line.normalized; }
    if (zh.startsWith(nameZh) && en.startsWith(nameEn)) { projectionStop = "both_complete_titles_matched"; break; }
  }
  const evidence = {
    bindings: { fullLicense: input.fullLicense, baselineSourceUrl: sourceUrl, exactCurrentIndexUrls: [...index.sourceUrls], actualRawSha256, baselineRawSha256: input.baseline.rawSha256, currentReceiptRawSha256: input.currentReceipt.rawSha256, actualRawBytes: input.currentRawBytes.length, now: input.now, timestamps: { ...timestamps }, catalogRows: 1, indexRows: 1, firstPhysicalPage: 1, firstPageTextSha256: sha(input.firstPhysicalPage.text) },
    title: { rawPrefix, stopReason, bounds: LEGACY_TITLE_BOUNDS, lines, normalizedPrefix: normalize(rawPrefix), chineseProjection: zh, englishProjection: en, chinesePhysicalLines: chinese.map(line => line.physicalLine), englishPhysicalLines: english.map(line => line.physicalLine), projectionStop },
    currentNames: { nameZh: current.nameZh, nameEn: current.nameEn, normalizedNameZh: nameZh, normalizedNameEn: nameEn },
  };
  if (projectionStop !== "both_complete_titles_matched") return fail("complete_bilingual_title_prefix_not_matched", evidence);
  return { ...baseDiagnostic, ok: true, code: "legacy_title_layout_reconciled", evidence: { ...evidence, matchedNames: { nameZh: current.nameZh, nameEn: current.nameEn, chineseProjectionOffset: 0, englishProjectionOffset: 0 }, method: normalize(rawPrefix).includes(nameZh) && normalize(rawPrefix).includes(nameEn) ? "literal_bilingual_title_with_typography_normalization" : "ordered_whole_line_bilingual_projection" } };
}
