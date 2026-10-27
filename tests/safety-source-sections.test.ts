import { describe, expect, it } from "vitest";
import { grounded, OutputSchema, sourcePassages, type Llm } from "../server/ai";
import { completeWarningCitations } from "../server/source-boundary";
import {
  completeSafetyLearning,
  SAFETY_SECTIONS,
} from "../server/safety-learning";
import type { Chunk, Claim } from "../shared/schema";

const page = (text: string): Chunk => ({
  id: "synthetic-safety-fields",
  licenseNo: "SYNTHETIC-SAFETY-FIELDS",
  version: "literal-v1",
  page: 1,
  start: 0,
  text,
});
const source = page(
  "2 適應症\n用於緩解合成症狀甲。\n\n" +
    "5 警語及注意事項\n除非有合成指示，合成情況甲不得使用。\n\n" +
    "6 特殊族群注意事項\n動物試驗觀察到合成反應，與人類的關係尚不明確。若有合成情況乙，請洽醫師。\n\n" +
    "13 包裝及儲存\n每瓶合成包裝。本品易燃，請遠離火源。請置於合成保存環境。\n\n" +
    "14 病人使用須知\n請將瓶身倒置，先擠入瓶蓋。不可直接擠於患處，以避免用量過多。\n\n" +
    "15 其他\n合成行政資料。另記載合成保存資訊。\n",
);
const expectedSections = [
  "警語及注意事項",
  "特殊族群注意事項",
  "包裝及儲存",
  "病人使用須知",
];

describe("explicit population, storage and patient-information source fields", () => {
  it("keeps all original bytes and distinct numbered top-level scope", () => {
    const passages = sourcePassages([source]);
    expect(passages.map((p) => p.quote).join("")).toBe(source.text);
    const safety = passages.filter((p) =>
      SAFETY_SECTIONS.has(p.sourceSection || ""),
    );
    expect(safety.map((p) => p.sourceSection)).toEqual(expectedSections);
    const population = safety[1];
    expect(population.quote).toContain("與人類的關係尚不明確");
    expect(population.requiredConditions).toEqual(["若有合成情況乙"]);
    expect(population.quote).not.toContain("除非有合成指示");
    expect(safety[0].quote).not.toContain("特殊族群注意事項");
    expect(safety[2].quote).toContain("每瓶合成包裝");
    expect(safety[2].quote).toContain("請遠離火源");
    expect(safety[3].quote).toContain("以避免用量過多");
    expect(safety[3].quote).not.toContain("合成行政資料");
    expect(passages.find((p) => p.sourceSection === "其他")?.quote).toContain(
      "合成行政資料",
    );
  });

  it.each(["特殊族群注意事項", "病人使用須知", "包裝及儲存"])(
    "does not publish a fragment of a %s field even with another category",
    (section) => {
      const original = page(
        `【${section}】若有合成情況甲，請先閱讀原文。這項條件不可省略。`,
      );
      const passages = sourcePassages([original]);
      const claim: Claim = {
        text: "這項條件不可省略。",
        category: "other",
        citations: [{ chunkId: original.id, quote: "這項條件不可省略。" }],
      };
      expect(
        completeWarningCitations(claim, [original], passages, SAFETY_SECTIONS),
      ).toBe(false);
      claim.citations[0].quote = original.text;
      expect(
        completeWarningCitations(claim, [original], passages, SAFETY_SECTIONS),
      ).toBe(true);
      expect(
        OutputSchema.parse({
          status: "supported",
          claims: [],
          quiz: [
            {
              q: `依仿單「${section}」欄，何者符合原文？`,
              options: ["原文條件", "另一條件"],
              answer: 0,
              sourceSection: section,
              citations: claim.citations,
            },
          ],
        }).quiz[0].sourceSection,
      ).toBe(section);
    },
  );

  it("keeps original safety fields without synthesizing attribution-only quiz questions", () => {
    const completed = completeSafetyLearning(
      { claims: [], quiz: [] },
      sourcePassages([source]),
    );
    expect(completed.safetyCoverage).toMatchObject({
      scope: "recognized_source_sections",
      assessmentScope: "one_key_point_per_section",
      status: "partial",
      sourceSectionCount: 4,
      coveredSectionCount: 4,
      quizCoveredSectionCount: 1,
    });
    expect(completed.claims.map((claim) => claim.kind)).toEqual(
      expectedSections.map(() => "source_exact_safety"),
    );
    for (const claim of completed.claims) {
      expect(source.text).toContain(claim.citations[0].quote);
      expect(claim.text).toBe(claim.citations[0].quote.trim());
      expect(claim.profileRefs).toBeUndefined();
    }
    expect(completed.quiz.map((q) => q.sourceSection)).toEqual([
      "警語及注意事項",
    ]);
    for (const section of ["包裝及儲存", "病人使用須知"]) {
      expect(completed.quiz.some((q) => q.sourceSection === section)).toBe(false);
      expect(completed.claims.some((claim) =>
        claim.kind === "source_exact_safety" &&
        claim.citations[0].quote.includes(section),
      )).toBe(true);
    }
  });

  it("does not classify pure packaging, ingredients or generic other/storage fields as safety", () => {
    const original = page(
      "【成分】合成成分甲。\n【包裝】每盒十包合成包裝。\n" +
        "【其他】合成行政資料。\n【儲存條件】置於合成場所。\n" +
        "【儲存方式】合成保存方式。\n【儲存】置於合成場所。\n" +
        "【貯存】置於合成場所。\n",
    );
    const completed = completeSafetyLearning(
      { claims: [], quiz: [] },
      sourcePassages([original]),
    );
    expect(completed.claims).toEqual([]);
    expect(completed.quiz).toEqual([]);
    expect(completed.safetyCoverage?.status).toBe("no_sections");
  });

  it.each([
    "【病人使用須知】合成說明未完整結束",
    "【包裝及儲存】請遠離合成火源，但",
  ])("retains strict source review for incomplete new fields", (text) => {
    expect(() => sourcePassages([page(text)])).toThrow(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });

  it.each(["特殊族群注意事項", "病人使用須知", "包裝及儲存"])(
    "preserves a complete overlong %s field as original reading only",
    (section) => {
      const text = `【${section}】` + "合成條件".repeat(400) + "。";
      const passages = sourcePassages([page(text)]);
      expect(passages).toHaveLength(1);
      expect(passages[0]).toMatchObject({
        quote: text,
        sourceSection: section,
        modelEligible: false,
      });
      const completed = completeSafetyLearning({ claims: [], quiz: [] }, passages);
      expect(completed.claims[0].text).toBe(text);
      expect(completed.claims[0].citations).toEqual([
        { chunkId: "synthetic-safety-fields", quote: text },
      ]);
      expect(completed.quiz).toEqual([]);
      expect(completed.safetyCoverage).toMatchObject({
        status: "partial",
        coveredSectionCount: 1,
        quizCoveredSectionCount: 0,
      });
    },
  );

  it.each(["特殊族群注意事項", "病人使用須知", "包裝及儲存"])(
    "still rejects an incomplete %s suffix after a complete sentence",
    (section) => {
      for (const tail of ["但", "若有合成情況", "除非有合成指示"]) {
        expect(() =>
          sourcePassages([page(`【${section}】合成內容完整結束。但仍須保留條件。${tail}`)]),
        ).toThrow(expect.objectContaining({ code: "source_requires_review" }));
      }
    },
  );

  it("includes the explicit safety fields and preserves omitted claims as original reading", async () => {
    let generatedSources: any[] = [];
    const llm: Llm = {
      json: async (system, input: any) => {
      if (input.teachingFields && !input.sources) return {fieldTeaching: []};
        if (system.includes("審核器"))
          return {
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: true,
            })),
          };
        generatedSources = input.sources;
        const purpose = input.sources.find((p: any) => p.purposeEligible);
        return {
          status: "supported",
          claims: [
            {
              text: purpose.text,
              category: "purpose",
              citations: [{ sourceId: purpose.id }],
            },
          ],
          quiz: [],
        };
      },
    };
    const result = await grounded(llm, "合成來源理解確認", [source], {}, "bundle");
    expect(generatedSources.map((p) => p.sourceSection)).toEqual(
      expect.arrayContaining(expectedSections),
    );
    expect(result.safetyCoverage).toMatchObject({
      status: "partial",
      coveredSectionCount: 4,
      quizCoveredSectionCount: 1,
    });
    expect(result.claims).toHaveLength(5);
    expect(result.chunks).toEqual([source]);
    expect(result.claims.some((claim) => claim.text.includes("合成行政資料"))).toBe(
      false,
    );
  });
});
