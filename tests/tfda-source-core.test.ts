import { describe, expect, it } from "vitest";
import {
  evaluateTfdaSource,
  normalizeTfdaSourceText,
  TFDA_SOURCE_LIMITS,
  tfdaSourceHash,
  type TfdaFetchedArtifact,
  type TfdaSourceInput,
} from "../tools/tfda-source-core";

// All products, licenses, bytes/hashes, URLs and medicine prose below are SYNTHETIC.
// No test retrieves official material, invokes a model, or connects to a cloud.
const licenseNo = "衛部藥製字第999991號";
const sourceUrl = "https://mcp.fda.gov.tw/synthetic/test-leaflet.pdf";
const nameZh = '"合成品牌"測試錠5毫克';
const nameEn = "SYNTHETIC TEST TABLETS 5MG";
const firstText =
  `${nameZh}\n${nameEn}\n${licenseNo}\n【適應症】\n` +
  "這是測試使用的合成來源內容。每項敘述均是測試文字，完整保留頁面內容與原始順序，沒有真實藥品資訊。".repeat(
    4,
  );
const secondText =
  "【警語及注意事項】\n" +
  "若符合合成條件甲，依合成條件乙處理。本句只供程式測試，前後必要條件與例外全部保留，不是醫療指示。".repeat(
    4,
  );
const fetched = (
  overrides: Partial<TfdaFetchedArtifact> = {},
): TfdaFetchedArtifact => ({
  requestedUrl: sourceUrl,
  finalUrl: sourceUrl,
  retrievedAt: "2026-10-21T03:58:00Z",
  sha256: tfdaSourceHash("SYNTHETIC raw PDF bytes"),
  bytes: 4096,
  mediaType: "application/pdf",
  contentSignature: "pdf",
  ...overrides,
});
const candidate = (): TfdaSourceInput => ({
  licenseNo,
  checkedAt: "2026-10-21T04:00:00Z",
  catalogCheckedAt: "2026-10-21T03:55:00Z",
  indexCheckedAt: "2026-10-21T03:55:00Z",
  catalogRows: [
    {
      licenseNo,
      nameZh,
      nameEn,
      form: "合成錠劑",
      manufacturer: "合成測試製造商",
      effectiveUntil: "2029/12/31",
      revoked: false,
    },
  ],
  indexRows: [{ licenseNo, nameZh, nameEn, urls: [sourceUrl] }],
  fetched: fetched(),
  format: "pdf",
  numPages: 2,
  pages: [
    {
      page: 1,
      text: firstText,
      independentText: firstText,
      embeddedImages: 0,
      hasLargeUnverifiedImage: false,
      hasUnverifiedStructure: false,
    },
    {
      page: 2,
      text: secondText,
      independentText: secondText,
      embeddedImages: 0,
      hasLargeUnverifiedImage: false,
      hasUnverifiedStructure: false,
    },
  ],
});
function replaceText(input: TfdaSourceInput, from: string, to: string) {
  input.pages = input.pages.map((page) => ({
    ...page,
    text: page.text.replaceAll(from, to),
    independentText: page.independentText?.replaceAll(from, to),
  }));
}

describe("patient source category", () => {
  it("retains a manufacturing-material source outside patient publication", () => {
    const input = candidate();
    input.pages[0].text += "\n\t製劑原料\n";
    input.pages[0].independentText = input.pages[0].text;
    const result = evaluateTfdaSource(input);
    expect(result.eligibleTechnical).toBe(false);
    expect(result.reasons).toContain("raw_material_source_not_patient_leaflet");
  });
  it("does not mistake a sentence mentioning raw material for its product category", () => {
    const input = candidate();
    input.pages[0].text += "\n這句合成警語提及原料藥，但不是製劑原料分類。\n";
    input.pages[0].independentText = input.pages[0].text;
    expect(evaluateTfdaSource(input).reasons).not.toContain("raw_material_source_not_patient_leaflet");
  });
});
function longPage(length: number): string {
  const prefix = `${nameZh}\n${licenseNo}\n【適應症】\n`;
  const body = "合成來源完整內容保留條件甲乙丙丁與例外敘述。";
  return (prefix + body.repeat(Math.ceil(length / body.length))).slice(
    0,
    length,
  );
}
function setPageText(input: TfdaSourceInput, texts: string[]) {
  input.numPages = texts.length;
  input.pages = texts.map((text, index) => ({
    page: index + 1,
    text,
    independentText: text,
    hasLargeUnverifiedImage: false,
    hasUnverifiedStructure: false,
  }));
}

describe("synthetic TFDA technical source gates", () => {
  it("requires explicit PDF structure evidence even when all text engines agree", () => {
    const input = candidate();
    delete input.pages[0].hasUnverifiedStructure;
    expect(evaluateTfdaSource(input).reasons).toContain("unverified_structure");
    input.pages[0].hasUnverifiedStructure = true;
    expect(evaluateTfdaSource(input).reasons).toContain("unverified_structure");
    input.pages[0].hasUnverifiedStructure = false;
    expect(evaluateTfdaSource(input).status).toBe("technically_eligible");
  });
  it("keeps complete multi-page text as draft chunks while making only an automated technical claim", () => {
    const input = candidate(),
      result = evaluateTfdaSource(input);
    expect(result.status).toBe("technically_eligible");
    expect(result).toMatchObject({
      acquired: true,
      rawOnly: false,
      draft: true,
      eligibleTechnical: true,
      runtimeCompatible: true,
      reasons: [],
    });
    expect(result.criteria).toMatchObject({
      humanReviewed: false,
      clinicalReviewed: false,
    });
    expect(result.draftLeaflet).toMatchObject({
      status: "draft",
      checkedBy: null,
      checkedAt: null,
      licenseNo,
    });
    expect(result.draftLeaflet!.chunks.map((chunk) => chunk.text)).toEqual([
      firstText,
      secondText,
    ]);
    expect(
      result.draftLeaflet!.chunks.map((chunk) => [chunk.page, chunk.start]),
    ).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(result.draftLeaflet!.chunks[1].id).toContain("-2-0-whole-page-v1-");
    expect(result.canonicalTextSha256).toBe(
      tfdaSourceHash(firstText + "\n\n" + secondText),
    );
  });

  it("coalesces ingredient-level catalog rows only when all product identity fields remain invariant", () => {
    const input = candidate();
    input.catalogRows.push({
      ...input.catalogRows[0],
      nameZh: "“合成品牌”測試錠５毫克",
      effectiveUntil: "2029-12-31",
    });
    expect(evaluateTfdaSource(input)).toMatchObject({
      eligibleTechnical: true,
      evidence: { catalogRowCount: 2, coalescedProductCount: 1 },
    });
    input.catalogRows[1].manufacturer = "不同的合成製造商";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "catalog_product_ambiguous",
    );
  });

  it("does not confuse an equal numeric suffix with a complete issuer/type/license identity", () => {
    const input = candidate();
    input.licenseNo = "999991";
    expect(evaluateTfdaSource(input).reasons).toEqual(
      expect.arrayContaining([
        "invalid_complete_license",
        "catalog_license_missing",
        "index_license_missing",
      ]),
    );
    input.licenseNo = "衛署藥輸字第999991號";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "catalog_license_missing",
    );
  });

  it("accepts a complete R-prefixed license without dropping its prefix", () => {
    const input = candidate(),
      researchLicense = "衛署藥製字第R00091號";
    input.licenseNo = researchLicense;
    input.catalogRows[0].licenseNo = researchLicense;
    input.indexRows[0].licenseNo = researchLicense;
    replaceText(input, licenseNo, researchLicense);
    const result = evaluateTfdaSource(input);
    expect(result.eligibleTechnical).toBe(true);
    expect(result.draftLeaflet!.licenseNo).toBe(researchLicense);
  });

  it.each([
    ["catalogCheckedAt", "2026-10-20T04:00:00Z", "catalog_evidence_not_fresh"],
    ["indexCheckedAt", "2026-10-22T04:00:00Z", "index_evidence_not_fresh"],
  ] as const)(
    "requires fresh independent current index evidence: %s",
    (field, time, reason) => {
      const input = candidate();
      input[field] = time;
      expect(evaluateTfdaSource(input).reasons).toContain(reason);
    },
  );

  it("requires fresh retrieved source bytes as well as fresh indexes", () => {
    const input = candidate();
    input.fetched.retrievedAt = "2026-10-19T04:00:00Z";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "source_evidence_not_fresh",
    );
  });

  it.each(["2026/10/20", "2029/02/30", "not-a-date"])(
    "rejects expired or invalid effective dates: %s",
    (expiry) => {
      const input = candidate();
      input.catalogRows[0].effectiveUntil = expiry;
      expect(evaluateTfdaSource(input).reasons).toContain(
        "license_expired_or_invalid_date",
      );
    },
  );

  it("checks revocation and a caller-specified inclusive local expiry day", () => {
    const input = candidate();
    input.catalogRows[0].effectiveUntil = "2026/10/21";
    input.asOfDate = "2026-10-21";
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);
    input.catalogRows[0].revoked = true;
    expect(evaluateTfdaSource(input).reasons).toContain("license_revoked");
    input.checkedAt = "invalid";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "invalid_evaluation_date",
    );
  });

  it("preserves brand and strength when comparing the current index product title", () => {
    const input = candidate();
    input.indexRows[0].nameZh = '"其他品牌"測試錠50毫克';
    expect(evaluateTfdaSource(input).reasons).toContain(
      "index_product_title_mismatch",
    );
  });

  it("does not let a printed complete license authorize an obsolete name or different strength", () => {
    const input = candidate();
    replaceText(input, nameZh, '"舊品牌"測試錠500毫克');
    replaceText(input, nameEn, "OBSOLETE SYNTHETIC TABLETS 500MG");
    const result = evaluateTfdaSource(input);
    expect(result.evidence.printedCompleteLicenses).toContain(licenseNo);
    expect(result.reasons).toContain("current_complete_product_name_missing");
    expect(result.eligibleTechnical).toBe(false);
  });

  it("accepts either complete current product name but never removes amounts or brand words", () => {
    const input = candidate();
    replaceText(input, nameZh, "合成不相符中文名稱");
    expect(evaluateTfdaSource(input).evidence.matchedCurrentName).toBe("en");
    replaceText(input, nameEn, "SYNTHETIC TEST TABLETS 50MG");
    expect(evaluateTfdaSource(input).reasons).toContain(
      "current_complete_product_name_missing",
    );
  });

  it("does not treat a concentration extension as the exact complete product name", () => {
    const input = candidate();
    replaceText(input, nameZh, nameZh + "/毫升");
    replaceText(input, nameEn, nameEn + "/ML");
    expect(evaluateTfdaSource(input).reasons).toContain(
      "current_complete_product_name_missing",
    );
  });

  it("defers shared multi-license source scope instead of applying it across products automatically", () => {
    const input = candidate();
    input.pages[1].text += "\n衛部藥製字第999992號";
    input.pages[1].independentText = input.pages[1].text;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "other_complete_license_requires_scope_review",
    );
  });

  it.each([
    "http://mcp.fda.gov.tw/synthetic/test.pdf",
    "https://mcp.fda.gov.tw.evil.example/synthetic/test.pdf",
    "https://user:secret@mcp.fda.gov.tw/synthetic/test.pdf",
    "https://mcp.fda.gov.tw:8443/synthetic/test.pdf",
  ])("rejects an unsafe source endpoint: %s", (url) => {
    const input = candidate();
    input.fetched.requestedUrl = url;
    input.fetched.finalUrl = url;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "nonofficial_or_invalid_url",
    );
  });

  it("requires a fully official redirect chain including both endpoints", () => {
    const input = candidate(),
      final = "https://www.fda.gov.tw/synthetic/final.pdf";
    input.fetched.finalUrl = final;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "redirect_history_incomplete",
    );
    input.fetched.redirectChain = [
      sourceUrl,
      "http://mcp.fda.gov.tw/synthetic/hop.pdf",
      final,
    ];
    expect(evaluateTfdaSource(input).reasons).toContain(
      "nonofficial_or_invalid_url",
    );
    input.fetched.redirectChain = [sourceUrl, final];
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);
  });

  it("rejects TFDA's generic pdfcase placeholder as a source path", () => {
    const input = candidate(),
      placeholder = "https://mcp.fda.gov.tw/insert/pdfcase?c=2";
    input.indexRows[0].urls = [placeholder];
    input.fetched = fetched({
      requestedUrl: placeholder,
      finalUrl: placeholder,
    });
    expect(evaluateTfdaSource(input).reasons).toContain(
      "placeholder_source_path",
    );
  });

  it("requires current official association instead of trusting a plausible official PDF URL", () => {
    const input = candidate();
    input.fetched = fetched({
      requestedUrl: "https://mcp.fda.gov.tw/synthetic/unlisted.pdf",
      finalUrl: "https://mcp.fda.gov.tw/synthetic/unlisted.pdf",
    });
    expect(evaluateTfdaSource(input).reasons).toContain(
      "source_not_currently_associated",
    );
  });

  it("allows a current official detail DOM to associate an index entry with its paper attachment", () => {
    const input = candidate(),
      indexUrl = `https://mcp.fda.gov.tw/exportpdf/${licenseNo}`;
    input.indexRows[0].urls = [indexUrl];
    input.officialAssociation = {
      indexUrl,
      detailUrl: `https://mcp.fda.gov.tw/im_detail_1/${licenseNo}?export=opendata`,
      licenseNo,
      linkedSourceUrls: [sourceUrl],
      retrievedAt: input.fetched.retrievedAt,
      detailSha256: tfdaSourceHash("SYNTHETIC current detail DOM"),
    };
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);
    input.officialAssociation.licenseNo = "衛部藥製字第999992號";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "official_association_invalid",
    );
  });

  it("enumerates every index URL, never auto-selecting the first unresolved attachment", () => {
    const input = candidate(),
      otherUrl = "https://mcp.fda.gov.tw/synthetic/other-version.pdf";
    input.indexRows[0].urls.push(otherUrl);
    expect(evaluateTfdaSource(input).reasons).toContain(
      "multiple_distinct_sources_require_resolution",
    );
    input.sameSourceArtifacts = [
      fetched({ requestedUrl: otherUrl, finalUrl: otherUrl }),
    ];
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);
    input.sameSourceArtifacts[0].sha256 = tfdaSourceHash(
      "SYNTHETIC distinct attachment bytes",
    );
    expect(evaluateTfdaSource(input).reasons).toContain(
      "multiple_distinct_sources_require_resolution",
    );
  });

  it("unions duplicate index rows before checking all source associations", () => {
    const input = candidate();
    input.indexRows.push({
      ...input.indexRows[0],
      urls: ["https://mcp.fda.gov.tw/synthetic/another.pdf"],
    });
    expect(evaluateTfdaSource(input)).toMatchObject({
      eligibleTechnical: false,
      evidence: { indexRowCount: 2, indexUrlCount: 2 },
    });
    input.indexRows[1].nameEn = "DIFFERENT SYNTHETIC TITLE";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "index_identity_ambiguous",
    );
  });

  it("detects missing and duplicate physical pages rather than trusting max(page)", () => {
    const input = candidate();
    input.numPages = 3;
    expect(evaluateTfdaSource(input)).toMatchObject({
      status: "raw_only",
      draftLeaflet: null,
    });
    expect(evaluateTfdaSource(input).reasons).toContain(
      "page_inventory_incomplete_or_duplicate",
    );
    input.numPages = 2;
    input.pages[1].page = 1;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "page_inventory_incomplete_or_duplicate",
    );
  });

  it("retains a blank physical page as a blocker instead of silently omitting it", () => {
    const input = candidate();
    input.pages[1].text = "\n ";
    input.pages[1].independentText = "\n ";
    const result = evaluateTfdaSource(input);
    expect(result.evidence.pages).toHaveLength(2);
    expect(result.reasons).toContain("source_page_text_missing");
    expect(result.status).toBe("raw_only");
    expect(result.draftLeaflet).toBeNull();
  });

  it("never equates perfect character coverage with correct multi-column reading order", () => {
    const input = candidate();
    input.pages[1].independentText = [...secondText].reverse().join("");
    const result = evaluateTfdaSource(input);
    expect(result.evidence.pages[1]).toMatchObject({
      independentCharacterCoverage: 1,
      independentNormalizedExactMatch: false,
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasons).toContain("independent_ordered_text_mismatch");
  });

  it("normalizes extractor typography only for comparison and preserves the canonical original text", () => {
    const input = candidate();
    input.pages[0].independentText = firstText
      .replaceAll('"', "“")
      .replaceAll("5", "５")
      .replaceAll("\n", "  ");
    expect(normalizeTfdaSourceText(input.pages[0].independentText)).toBe(
      normalizeTfdaSourceText(firstText),
    );
    const result = evaluateTfdaSource(input);
    expect(result.eligibleTechnical).toBe(true);
    expect(result.draftLeaflet!.chunks[0].text).toBe(firstText);
  });

  it("requires independent extraction on every page", () => {
    const input = candidate();
    delete input.pages[1].independentText;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "independent_extraction_missing",
    );
  });

  it("requires a supplied third extractor to agree even when the first independent extractor matches", () => {
    const input = candidate();
    for (const page of input.pages)
      page.additionalIndependentText = page.text.replaceAll("\n", "  ");
    const agreed = evaluateTfdaSource(input);
    expect(agreed.eligibleTechnical).toBe(true);
    expect(agreed.evidence.pages[1]).toMatchObject({
      independentNormalizedExactMatch: true,
      additionalIndependentNormalizedExactMatch: true,
      suppliedTextExtractionCount: 3,
    });
    input.pages[1].additionalIndependentText = [...secondText]
      .reverse()
      .join("");
    const disagreed = evaluateTfdaSource(input);
    expect(disagreed.reasons).toContain("independent_ordered_text_mismatch");
    expect(disagreed.eligibleTechnical).toBe(false);
    expect(disagreed.evidence.pages[1]).toMatchObject({
      independentNormalizedExactMatch: true,
      additionalIndependentNormalizedExactMatch: false,
      suppliedTextExtractionCount: 3,
    });
  });

  it("distinguishes an unavailable third engine from a supplied extraction that returned blank text", () => {
    const input = candidate();
    const absent = evaluateTfdaSource(input);
    expect(absent.eligibleTechnical).toBe(true);
    expect(absent.evidence.pages[1]).toMatchObject({
      additionalIndependentNormalizedExactMatch: null,
      suppliedTextExtractionCount: 2,
    });
    input.pages[1].additionalIndependentText = " \n ";
    const empty = evaluateTfdaSource(input);
    expect(empty.reasons).toContain("independent_extraction_missing");
    expect(empty.eligibleTechnical).toBe(false);
    expect(empty.evidence.pages[1].suppliedTextExtractionCount).toBe(2);
  });

  it("blocks large unverified images and unknown image inventories while accepting an inventoried small logo", () => {
    const input = candidate();
    input.pages[0].embeddedImages = 1;
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);
    input.pages[0].hasLargeUnverifiedImage = true;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "large_unverified_image",
    );
    delete input.pages[0].hasLargeUnverifiedImage;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "page_image_inventory_missing",
    );
  });

  it("does not pass text merely because it is long and contains a current product name", () => {
    const input = candidate();
    replaceText(input, "【適應症】", "【合成欄位甲】");
    replaceText(input, "【警語及注意事項】", "【合成欄位乙】");
    expect(evaluateTfdaSource(input).reasons).toContain(
      "medical_document_heading_missing",
    );
    input.pages[1].text += "\uFFFD";
    input.pages[1].independentText = input.pages[1].text;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "source_text_quality_failed",
    );
  });

  it("keeps sparse image-only extraction and corrupt text as drafts", () => {
    const input = candidate();
    input.pages[1].text = "1";
    input.pages[1].independentText = "1";
    expect(evaluateTfdaSource(input).reasons).toContain(
      "source_text_quality_failed",
    );
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(false);
  });

  it("accepts the whole-page character boundary and rejects its next character without clipping", () => {
    const input = candidate();
    setPageText(input, [longPage(TFDA_SOURCE_LIMITS.pageCharacters)]);
    const within = evaluateTfdaSource(input);
    expect(within.eligibleTechnical).toBe(true);
    expect(within.draftLeaflet!.chunks[0].text).toHaveLength(22_000);
    setPageText(input, [longPage(TFDA_SOURCE_LIMITS.pageCharacters + 1)]);
    const over = evaluateTfdaSource(input);
    expect(over.reasons).toContain("source_page_too_large");
    expect(over.draftLeaflet).toBeNull();
    expect(over.evidence.totalCharacters).toBe(22_001);
  });

  it("distinguishes a complete technically eligible stored source from the current whole-source model budget", () => {
    const input = candidate();
    setPageText(input, [longPage(12_000), longPage(12_000)]);
    const result = evaluateTfdaSource(input);
    expect(result).toMatchObject({
      status: "technically_eligible",
      eligibleTechnical: true,
      runtimeCompatible: false,
    });
    expect(
      result.draftLeaflet!.chunks.map((chunk) => chunk.text.length),
    ).toEqual([12_000, 12_000]);
    expect(result.warnings.join(" ")).toContain("must not be clipped");
  });

  it("enforces UTF-8 document bytes independently of per-page characters", () => {
    const input = candidate();
    setPageText(
      input,
      Array.from({ length: 20 }, () => longPage(15_000)),
    );
    const result = evaluateTfdaSource(input);
    expect(result.evidence.chunksBytes).toBeGreaterThan(800_000);
    expect(result.reasons).toContain("source_document_too_large");
    expect(result.draftLeaflet).toBeNull();
  });

  it("enforces raw size, page count, hash shape and actual content signature", () => {
    const input = candidate();
    input.fetched.bytes = TFDA_SOURCE_LIMITS.rawBytes + 1;
    input.numPages = 201;
    input.fetched.sha256 = "unverified";
    input.fetched.contentSignature = "unknown";
    expect(evaluateTfdaSource(input).reasons).toEqual(
      expect.arrayContaining([
        "invalid_or_oversize_raw_source",
        "invalid_source_page_count",
        "invalid_source_hash",
        "source_media_or_signature_mismatch",
      ]),
    );
  });

  it("accepts HTML only with caller-produced complete DOM conservation and no unverified nontext content", () => {
    const input = candidate(),
      text = firstText + "\n\n" + secondText;
    input.format = "html";
    input.fetched = fetched({
      mediaType: "text/html; charset=utf-8",
      contentSignature: "html",
    });
    setPageText(input, [text]);
    delete input.pages[0].independentText;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "html_conservation_evidence_missing_or_failed",
    );
    input.htmlEvidence = {
      completeMainDocument: true,
      domConservationPassed: true,
      canonicalTextSha256: tfdaSourceHash(text),
      sectionCount: 2,
      hasUnverifiedNonTextContent: false,
    };
    const result = evaluateTfdaSource(input);
    expect(result.eligibleTechnical).toBe(true);
    expect(result.draftLeaflet!.chunks[0].sourceFormat).toBe("html");
    input.htmlEvidence.hasUnverifiedNonTextContent = true;
    expect(evaluateTfdaSource(input).reasons).toContain(
      "html_conservation_evidence_missing_or_failed",
    );
    input.htmlEvidence.hasUnverifiedNonTextContent = false;
    input.htmlEvidence.canonicalTextSha256 = "a".repeat(64);
    expect(evaluateTfdaSource(input).reasons).toContain(
      "html_conservation_evidence_missing_or_failed",
    );
  });

  it("is deterministic and does not mutate supplied page order, index rows, products or evidence", () => {
    const input = candidate();
    input.pages.reverse();
    const before = structuredClone(input);
    const first = evaluateTfdaSource(input),
      second = evaluateTfdaSource(input);
    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(first.draftLeaflet!.chunks.map((chunk) => chunk.page)).toEqual([
      1, 2,
    ]);
  });
});
