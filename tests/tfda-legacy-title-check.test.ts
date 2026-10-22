import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconcileLegacyTitle, type LegacyTitleInput } from "../tools/tfda-legacy-title-check.js";

const bytes = Buffer.from("%PDF-1.7\nunit fixture; not a parsed or clinically validated PDF\n");
const rawSha256 = createHash("sha256").update(bytes).digest("hex");
const sourceUrl = "https://mcp.fda.gov.tw/insert/pdfcasefile/unit-fixture?c=2";
function fixture(other = false): LegacyTitleInput {
  const licenseNo = other ? "衛署藥製字第040161號" : "衛署藥製字第026087號";
  return {
    fullLicense: licenseNo, now: "2026-10-22T11:00:00.000Z",
    baseline: { licenseNo, sourceUrl, rawSha256 },
    catalog: { retrievedAt: "2026-10-21T15:47:37.937Z", rows: [{ licenseNo, nameZh: other ? '"晟德"安佳熱滴劑１００毫克/毫升（乙醯胺酚）' : '"生達"咳服錠200毫克(呱芬那辛)', nameEn: other ? 'ANTI-PHEN DROPS 100MG/ML "CENTER" (ACETAMINOPHEN)' : 'G.F. TABLETS 200MG "STANDARD" (GUAIFENESIN)' }] },
    index: { retrievedAt: "2026-10-21T15:47:33.705Z", rows: [{ licenseNo, sourceUrls: [sourceUrl] }] },
    currentReceipt: { licenseNo, requestedUrl: sourceUrl, rawSha256, fetchedAt: "2026-10-22T10:50:00Z" },
    currentRawBytes: bytes,
    firstPhysicalPage: { page: 1, text: other ? '〝晟德〞\n安佳熱 滴劑 100 毫克 / 毫升 ( 乙醯胺酚 )\nAnti-phen drops 100mg/ml 〝 C enter 〞 (Acetaminophen)\n衛署藥製字第\nGMP\n號 040161\nG-2315\n主 成 分：每毫升 (ml) 含有\nAcetaminophen 100mg' : '" 生達 "\n咳 服\nG.F.\n錠 200 毫克\nTablets 200mg\n〝 Standard 〞\n(Guaifenesin)\n( 呱芬那辛 )\n本品之主成份 Guaifenesin 為一種藥品\n主成分：每錠含 200mg' },
  };
}

describe("preserved legacy title layout diagnosis", () => {
  it("recognizes the real interleaved bilingual title without reordering words or losing strength", () => {
    const result = reconcileLegacyTitle(fixture());
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject({ method: "ordered_whole_line_bilingual_projection", matchedNames: { chineseProjectionOffset: 0, englishProjectionOffset: 0 }, title: { chinesePhysicalLines: [1, 2, 4, 8], englishPhysicalLines: [3, 5, 6, 7], stopReason: "clinical_body_heading" }, bindings: { actualRawSha256: rawSha256 } });
    expect(result.clinicalReviewed).toBe(false); expect(result.sourceEligibilityEstablished).toBe(false);
  });
  it("recognizes the real typographic quotes, fullwidth forms and split English spacing", () => {
    const result = reconcileLegacyTitle(fixture(true));
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject({ method: "literal_bilingual_title_with_typography_normalization", title: { englishProjection: 'anti-phendrops100mg/ml"center"(acetaminophen)' } });
  });
  it("rejects an English strength mismatch even when the entire Chinese name matches", () => {
    const input = fixture(); input.firstPhysicalPage.text = input.firstPhysicalPage.text.replace("Tablets 200mg", "Tablets 100mg");
    expect(reconcileLegacyTitle(input).ok).toBe(false);
  });
  it("rejects an English trademark mismatch instead of accepting Chinese alone", () => {
    const input = fixture(); input.firstPhysicalPage.text = input.firstPhysicalPage.text.replace("Standard", "OTHER");
    expect(reconcileLegacyTitle(input).ok).toBe(false);
  });
  it("requires a complete English name in both the current catalog and actual header", () => {
    const missingHeader = fixture(); missingHeader.firstPhysicalPage.text = missingHeader.firstPhysicalPage.text.replace("(Guaifenesin)\n", "");
    expect(reconcileLegacyTitle(missingHeader).ok).toBe(false);
    const missingCatalog = fixture(); missingCatalog.catalog.rows[0].nameEn = "";
    expect(reconcileLegacyTitle(missingCatalog).code).toBe("complete_bilingual_current_names_required");
  });
  it("requires exact complete licenses and one catalog/index row, never bare-number equivalence", () => {
    const wrongPrefix = fixture(); wrongPrefix.fullLicense = "衛部藥製字第026087號";
    expect(reconcileLegacyTitle(wrongPrefix).ok).toBe(false);
    const wrongLicense = fixture(); wrongLicense.index.rows[0].licenseNo = "衛署藥輸字第026087號";
    expect(reconcileLegacyTitle(wrongLicense).ok).toBe(false);
    const duplicate = fixture(); duplicate.catalog.rows.push({ ...duplicate.catalog.rows[0] });
    expect(reconcileLegacyTitle(duplicate).ok).toBe(false);
  });
  it("requires the exact current indexed URL and receipt rather than a similar path or foreign host", () => {
    const wrongUrl = fixture(); wrongUrl.index.rows[0].sourceUrls = [sourceUrl + "&other=1"];
    expect(reconcileLegacyTitle(wrongUrl).ok).toBe(false);
    const ambiguous = fixture(); ambiguous.index.rows[0].sourceUrls.push(sourceUrl + "&new=1");
    expect(reconcileLegacyTitle(ambiguous).ok).toBe(false);
    const wrongReceipt = fixture(); wrongReceipt.currentReceipt.requestedUrl += "&other=1";
    expect(reconcileLegacyTitle(wrongReceipt).ok).toBe(false);
    const foreign = fixture(); foreign.baseline.sourceUrl = "https://mcp.fda.gov.tw.evil.invalid/doc.pdf";
    expect(reconcileLegacyTitle(foreign).code).toBe("official_https_baseline_url_required");
  });
  it("hashes the actual bytes and requires agreement with both immutable baseline and current receipt", () => {
    const changedBytes = fixture(); changedBytes.currentRawBytes = Buffer.concat([bytes, Buffer.from("changed")]);
    expect(reconcileLegacyTitle(changedBytes).code).toBe("actual_baseline_receipt_raw_hash_mismatch");
    const changedReceipt = fixture(); changedReceipt.currentReceipt.rawSha256 = "a".repeat(64);
    expect(reconcileLegacyTitle(changedReceipt).ok).toBe(false);
    const changedBaseline = fixture(); changedBaseline.baseline.rawSha256 = "b".repeat(64);
    expect(reconcileLegacyTitle(changedBaseline).ok).toBe(false);
  });
  it("requires fresh catalog, index and current receipt independently, with no future timestamps", () => {
    for (const field of ["catalog", "index", "currentReceipt"] as const) {
      const input = fixture(); if (field === "currentReceipt") input.currentReceipt.fetchedAt = "2026-10-20T00:00:00Z"; else input[field].retrievedAt = "2026-10-20T00:00:00Z";
      expect(reconcileLegacyTitle(input).code).toBe("fresh_official_index_and_current_receipt_required");
    }
    const future = fixture(); future.currentReceipt.fetchedAt = "2026-10-23T00:00:00Z";
    expect(reconcileLegacyTitle(future).ok).toBe(false);
  });
  it("does not borrow matching names from clinical text or accept an old title followed by a new one", () => {
    const body = fixture(); body.firstPhysicalPage.text = "主 成 份：\n" + body.firstPhysicalPage.text;
    expect(reconcileLegacyTitle(body).ok).toBe(false);
    const englishBody = fixture(); englishBody.firstPhysicalPage.text = 'G.F. TABLETS 200MG "STANDARD" (GUAIFENESIN)\n"生達"咳服\nWARNINGS:\n錠200毫克(呱芬那辛)';
    expect(reconcileLegacyTitle(englishBody).ok).toBe(false);
    englishBody.firstPhysicalPage.text = englishBody.firstPhysicalPage.text.replace("WARNINGS:", "OTHERBODYTEXT");
    expect(reconcileLegacyTitle(englishBody).ok).toBe(false);
    const oldThenNew = fixture(); oldThenNew.firstPhysicalPage.text = '"舊商標"舊品名\nOLD PRODUCT\n' + oldThenNew.firstPhysicalPage.text;
    expect(reconcileLegacyTitle(oldThenNew).ok).toBe(false);
  });
  it("does not cross physical pages, form feeds, distant blank spans or the character bound", () => {
    const pageTwo = fixture(); pageTwo.firstPhysicalPage.page = 2;
    expect(reconcileLegacyTitle(pageTwo).ok).toBe(false);
    const crossPage = fixture(); crossPage.firstPhysicalPage.text = crossPage.firstPhysicalPage.text.replace("( 呱芬那辛 )", "\f( 呱芬那辛 )");
    expect(reconcileLegacyTitle(crossPage).ok).toBe(false);
    const distant = fixture(); distant.firstPhysicalPage.text = distant.firstPhysicalPage.text.replace("咳 服\n", "咳 服\n" + "\n".repeat(30));
    expect(reconcileLegacyTitle(distant).ok).toBe(false);
    const huge = fixture(); huge.firstPhysicalPage.text = " ".repeat(1201) + huge.firstPhysicalPage.text;
    expect(reconcileLegacyTitle(huge).ok).toBe(false);
  });
  it("never treats the title as a bag of words or deletes mixed-script content", () => {
    const reordered = fixture(); reordered.firstPhysicalPage.text = reordered.firstPhysicalPage.text.replace("Tablets 200mg\n〝 Standard 〞", "〝 Standard 〞\nTablets 200mg");
    expect(reconcileLegacyTitle(reordered).ok).toBe(false);
    const mixed = fixture(); mixed.firstPhysicalPage.text = mixed.firstPhysicalPage.text.replace("G.F.\n", "G.F. 備註\n");
    expect(reconcileLegacyTitle(mixed).ok).toBe(false);
  });
});
