import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  compareRecognition,
  expandedManifestSchema,
  fixtureBlob,
  imageMediaType,
  validateGroundedSource,
} from "../tools/seminar-expanded-support.js";
import type { GroundedResult, Leaflet } from "../shared/schema.js";

const manifest = () => ({
  version: 1,
  fixture: { database: "db.json", blobs: "blobs" },
  cases: [
    {
      id: "case-1",
      inputKind: "real_photo",
      image: "photo.jpg",
      provenance: {
        description: "Original camera photograph supplied by owner",
        cameraCaptureAttested: true,
      },
      expected: [
        {
          licenseNo: "TEST-1",
          fields: { doseAmount: 0.5, doseUnit: "錠", frequencyRaw: null },
        },
      ],
    },
  ],
});

describe("review-only photograph scope", () => {
  it("accepts a predeclared synonymous route only when the complete returned words occur in the image transcript", () => {
    const expected = [{licenseNo: "TEST-ROUTE", fields: {route: "口服"},
      fieldAlternatives: {route: ["口服", "內服藥，口服"]}}];
    const row = {name: "Literal bag", route: "內服藥，口服", rawText: "使用方法：內服藥，口服；每次1粒。",
      candidates: [{licenseNo: "TEST-ROUTE"}]};
    expect(compareRecognition([row], expected)).toMatchObject({passed: true, strictPassed: false});
    expect(compareRecognition([{...row, rawText: "使用方法：外用。"}], expected).passed).toBe(false);
  });
  it("cannot turn an unconfirmed photo into a full workflow with no drug expectations", () => {
    const input: any = manifest();
    input.cases[0].expected = [];
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
  });
  it("keeps a usage-review photo separate from confirmed official identities", () => {
    const input: any = manifest();
    input.cases[0].scope = "usage_review";
    input.cases[0].reviewNameMustInclude = "ETOFENAMATE";
    input.cases[0].expected = [];
    expect(expandedManifestSchema.safeParse(input).success).toBe(true);
    input.cases[0].expected = manifest().cases[0].expected;
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
  });
});
describe("expanded acceptance evidence and denominator", () => {
  it("requires a provenance attestation before calling a file a real camera photo", () => {
    const input = manifest();
    input.cases[0].provenance.cameraCaptureAttested = false;
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
  });
  it("requires original URL for a public photograph", () => {
    const input = manifest();
    input.cases[0].inputKind = "public_photo";
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
    expect(
      expandedManifestSchema.parse({
        ...input,
        cases: [
          {
            ...input.cases[0],
            provenance: {
              ...input.cases[0].provenance,
              sourceUrl: "https://example.org/photo",
            },
          },
        ],
      }).cases[0].inputKind,
    ).toBe("public_photo");
  });
  it("does not allow a transformed image to lose its derivation", () => {
    const input = manifest();
    input.cases[0].inputKind = "transformed";
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
  });
  it("keeps missing photographs explicit instead of inventing a fixture", () => {
    const input: any = manifest();
    delete input.cases[0].image;
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
    input.cases[0].notAvailableReason = "No owner photograph supplied yet";
    expect(expandedManifestSchema.parse(input).cases[0].image).toBeUndefined();
  });
  it("labels manual flow independently and never permits it to masquerade as OCR", () => {
    const original = manifest();
    expect(
      expandedManifestSchema.safeParse({
        ...original,
        cases: [{ ...original.cases[0], skipRecognition: true }],
      }).success,
    ).toBe(false);
    const manual: any = {
      ...original.cases[0],
      skipRecognition: true,
      inputKind: "manual_medication",
    };
    delete manual.image;
    expect(
      expandedManifestSchema.parse({ ...original, cases: [manual] }).cases[0]
        .skipRecognition,
    ).toBe(true);
  });
  it("bounds repeats and fixed denominator without duplicate case identities", () => {
    const input = manifest();
    expect(
      expandedManifestSchema.safeParse({
        ...input,
        cases: [input.cases[0], input.cases[0]],
      }).success,
    ).toBe(false);
    expect(
      expandedManifestSchema.safeParse({
        ...input,
        cases: [{ ...input.cases[0], repeat: 4 }],
      }).success,
    ).toBe(false);
    expect(
      expandedManifestSchema.safeParse({
        ...input,
        cases: Array.from({ length: 6 }, (_, index) => ({
          ...input.cases[0],
          id: "case-" + index,
          repeat: 3,
        })),
      }).success,
    ).toBe(false);
  });
  it("accepts a literal non-numeric dose without inventing one tablet and refuses an empty or conflicting dose", () => {
    const input: any = manifest();
    input.cases[0].expected[0].confirm = {
      doseAmount: null,
      doseUnit: "",
      doseText: "適量",
      frequencyRaw: "BID",
      sourceNote: "Fictional external-use software test",
    };
    expect(expandedManifestSchema.safeParse(input).success).toBe(true);
    input.cases[0].expected[0].confirm.doseText = "";
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
    input.cases[0].expected[0].confirm.doseText = "適量";
    input.cases[0].expected[0].confirm.doseUnit = "錠";
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
    input.cases[0].expected[0].confirm.doseAmount = 1;
    input.cases[0].expected[0].confirm.doseUnit = "錠";
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
  });
});
describe("literal OCR scoring and isolated files", () => {
  const expected = expandedManifestSchema.parse(manifest()).cases[0].expected;
  const recognized = {
    candidates: [{ licenseNo: "TEST-1" }],
    doseAmount: 0.5,
    doseUnit: "錠",
    frequencyRaw: null,
  };
  it("retains null expectation and exact dose without inventing frequency", () => {
    expect(compareRecognition([recognized], expected).passed).toBe(true);
    expect(
      compareRecognition([{ ...recognized, frequencyRaw: "QD" }], expected)
        .passed,
    ).toBe(false);
    expect(
      compareRecognition([{ ...recognized, doseAmount: 5 }], expected).passed,
    ).toBe(false);
  });
  it("does not accept wrong official identity or ambiguous duplicate candidates", () => {
    expect(
      compareRecognition(
        [{ ...recognized, candidates: [{ licenseNo: "TEST-2" }] }],
        expected,
      ).passed,
    ).toBe(false);
    expect(compareRecognition([recognized, recognized], expected).passed).toBe(
      false,
    );
    expect(
      compareRecognition([{ ...recognized, candidates: [] }], expected),
    ).toMatchObject({
      passed: false,
      comparisons: [
        {
          candidateMatches: 0,
          fieldsStrictPassed: true,
          diagnosticRowSelection:
            "single_row_fields_only_identity_still_failed",
        },
      ],
    });
  });
  it("keeps a candidate-only selection distinct and checks image-visible medication words in raw transcription", () => {
    const reference = [
      {
        ...expected[0],
        rawTextMustInclude: ["Secorine syrup", "飯後使用"],
        identity: {
          policy: "candidate_only" as const,
          note: "Manufacturer and flavor are not visible; selected license is only a candidate.",
        },
      },
    ];
    const rows = [
      { ...recognized, rawText: "Secorine syrup；每天3次 飯後使用" },
    ];
    expect(compareRecognition(rows, reference)).toMatchObject({
      passed: true,
      comparisons: [{ identity: { policy: "candidate_only" } }],
    });
    expect(
      compareRecognition(
        [{ ...recognized, rawText: "Different syrup；每天3次" }],
        reference,
      ).passed,
    ).toBe(false);
  });
  it("accepts only predeclared literal alternatives while retaining a failed strict-primary result", () => {
    const reference = [
      {
        ...expected[0],
        fields: {
          ...expected[0].fields,
          strength: "80mg/tab",
          frequencyRaw: "每天3次",
        },
        fieldAlternatives: {
          strength: ["80mg/tab", "80mg"],
          frequencyRaw: ["每天3次", "每天3次飯後使用"],
        },
      },
    ];
    const actual = {
      ...recognized,
      strength: "80mg",
      frequencyRaw: "每天3次飯後使用",
      rawText: "80mg/tab；每天3次 飯後使用",
    };
    expect(
      compareRecognition(
        [{ ...actual, frequencyRaw: "每天3次 飯後使用" }],
        reference,
      ),
    ).toMatchObject({ passed: true, strictPassed: false });
    expect(compareRecognition([actual], reference)).toMatchObject({
      passed: true,
      strictPassed: false,
      comparisons: [
        {
          fields: {
            strength: {
              strictMatch: false,
              matchKind: "predeclared_literal_alternative",
            },
          },
        },
      ],
    });
    expect(
      compareRecognition([{ ...actual, rawText: "沒有來源值" }], reference)
        .passed,
    ).toBe(false);
    expect(
      compareRecognition([{ ...actual, strength: "80毫克" }], reference).passed,
    ).toBe(false);
  });
  it("refuses to add an alternative to an explicitly missing/null strength", () => {
    const input: any = manifest();
    input.cases[0].expected[0].fields.strength = null;
    input.cases[0].expected[0].fieldAlternatives = { strength: ["80mg"] };
    expect(expandedManifestSchema.safeParse(input).success).toBe(false);
  });
  it("rejects file traversal outside the source blob tree", () => {
    const root = resolve("fixture/blobs");
    expect(() => fixtureBlob(root, "../db.json")).toThrow();
    expect(() => fixtureBlob(root, resolve("outside.pdf"))).toThrow();
    expect(fixtureBlob(root, "leaflets/source.pdf")).toBe(
      resolve(root, "leaflets/source.pdf"),
    );
  });
  it("accepts supported signatures and rejects HEIC/oversize without converting photos", () => {
    expect(imageMediaType(Buffer.from([255, 216, 255]))).toBe("image/jpeg");
    expect(imageMediaType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
      "image/png",
    );
    expect(() => imageMediaType(Buffer.from("ftypheic"))).toThrow();
    expect(() => imageMediaType(Buffer.alloc(8_000_001))).toThrow();
  });
});
describe("new-source citation validation", () => {
  const source: Leaflet = {
    id: "source",
    licenseNo: "TEST-1",
    version: "v1",
    sourceUrl: "https://mcp.fda.gov.tw/example.pdf",
    sha256: "hash",
    storagePath: "leaflets/example.pdf",
    status: "published",
    checkedBy: null,
    checkedAt: null,
    chunks: [
      {
        id: "c1",
        licenseNo: "TEST-1",
        version: "v1",
        page: 1,
        start: 0,
        text: "用於測試。僅有某狀況時適用。",
      },
    ],
  };
  const result = (): GroundedResult => ({
    status: "supported",
    claims: [
      {
        text: "測試用途",
        category: "purpose",
        citations: [{ chunkId: "c1", quote: "用於測試。" }],
      },
    ],
    chunks: source.chunks.map((chunk) => ({ ...chunk })),
    quiz: [
      {
        id: "q1",
        q: "何者是原文？",
        options: ["用於測試", "任何時候都適用"],
        answer: 0,
        explain: "依仿單「適應症」原文：用於測試。",
        explanationKind: "source_quote",
        citations: [{ chunkId: "c1", quote: "用於測試。" }],
      },
    ],
    followups: [],
    rejectedCount: 0,
    sourceVersions: { "TEST-1": "v1" },
    verification: "model_assisted",
  });
  it("validates exact chunks and own-source explanation while leaving semantics pending", () => {
    expect(validateGroundedSource(result(), source)).toMatchObject({
      passed: true,
      semanticReview: "pending_independent_review",
    });
  });
  it.each(["效能", "附記", "使用上注意事項"])(
    "accepts the explicitly supported real source section %s without renaming it",
    (section) => {
      const actual = result();
      actual.quiz[0].explain = `依仿單「${section}」原文：用於測試。`;
      expect(validateGroundedSource(actual, source).passed).toBe(true);
      expect(actual.quiz[0].explain).toContain(`「${section}」`);
    },
  );
  it.each(["作用機轉", "廣告", "任意章節"])(
    "does not admit an unknown/non-education source section %s",
    (section) => {
      const actual = result();
      actual.quiz[0].explain = `依仿單「${section}」原文：用於測試。`;
      expect(validateGroundedSource(actual, source).passed).toBe(false);
    },
  );
  it("rejects modified source chunks, wrong versions and fabricated explanation", () => {
    const altered = result();
    altered.chunks[0].text = "任何時候都適用。";
    expect(validateGroundedSource(altered, source).passed).toBe(false);
    const wrongVersion = result();
    wrongVersion.sourceVersions["TEST-1"] = "v2";
    expect(validateGroundedSource(wrongVersion, source).passed).toBe(false);
    const explanation = result();
    explanation.quiz[0].explain = "依仿單「適應症」原文：任何時候都適用。";
    expect(validateGroundedSource(explanation, source).passed).toBe(false);
  });
  it("rejects a condition mention that does not occur in the approved claim and its own source", () => {
    const altered = result();
    altered.claims[0].sourceMentions = [{ field: "conditions", value: "氣喘" }];
    expect(validateGroundedSource(altered, source).passed).toBe(false);
  });
  const completeSafetyCase = () => {
    const original = structuredClone(source);
    const body = "孕婦及授乳期婦女使用前請先諮詢醫師。";
    const field = { sourceSection: "注意事項", quote: "注意事項：" + body, body };
    original.chunks[0].text += "\n" + field.quote;
    const actual = result();
    actual.chunks = structuredClone(original.chunks);
    actual.quiz[0].learningObjective = "purpose";
    actual.quiz[0].sourceSection = "適應症";
    actual.claims.push({ text: field.quote, category: "warning", citations: [{chunkId: "c1", quote: field.quote}] });
    actual.quiz.push({ id: "safety-1", q: "孕婦及授乳期婦女使用前應如何處理？",
      options: [body, "孕婦及授乳期婦女使用前不必諮詢醫師。"], answer: 0,
      explain: "依仿單「注意事項」原文：" + field.quote, explanationKind: "source_quote",
      citations: [{chunkId: "c1", quote: field.quote}], learningObjective: "warning",
      sourceSection: "注意事項", coverageSectionId: "safety-1", assessmentScope: "one_key_point" });
    actual.safetyCoverage = { scope: "recognized_source_sections", assessmentScope: "one_key_point_per_section",
      status: "complete", sourceSectionCount: 1, coveredSectionCount: 1, quizCoveredSectionCount: 1,
      sections: [{id: "safety-1", chunkId: "c1", sourceSection: "注意事項", claimIndex: 1, quizIds: ["safety-1"]}] };
    return { original, actual, required: [field] };
  };
  it("checks predeclared safety fields against full displayed text and each field's own question", () => {
    const { original, actual, required } = completeSafetyCase();
    expect(validateGroundedSource(actual, original, required).passed).toBe(true);
  });
  it("does not accept a complete label when another original safety field was omitted", () => {
    const { original, actual, required } = completeSafetyCase();
    const missing = {sourceSection: "過量", quote: "過量：誤服過量應立即就醫。", body: "誤服過量應立即就醫。"};
    original.chunks[0].text += "\n" + missing.quote;
    actual.chunks = structuredClone(original.chunks);
    expect(validateGroundedSource(actual, original, [...required, missing]).passed).toBe(false);
  });
  it("rejects truncated displayed conditions despite an intact citation and reported coverage", () => {
    const { original, actual, required } = completeSafetyCase();
    actual.claims[1].text = "使用前請先諮詢醫師。";
    expect(validateGroundedSource(actual, original, required).passed).toBe(false);
  });
  it("does not count a purpose-only or orphaned question as a warning understanding check", () => {
    const { original, actual, required } = completeSafetyCase();
    actual.quiz[1].learningObjective = "purpose";
    expect(validateGroundedSource(actual, original, required).passed).toBe(false);
    actual.quiz[1].learningObjective = "warning";
    actual.quiz[1].coverageSectionId = "different-field";
    expect(validateGroundedSource(actual, original, required).passed).toBe(false);
  });
});
