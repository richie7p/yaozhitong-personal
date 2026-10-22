import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import {
  completeSafetyLearning,
  safetyReadingQuestion,
  SAFETY_SECTIONS,
} from "../server/safety-learning";
import type { Chunk, GroundedResult } from "../shared/schema";
import { SOURCE_PAGE_CHAR_LIMIT } from "../shared/source";

const norm = (value: string) => value.normalize("NFKC").replace(/\s/gu, "");
function original(license: string): Chunk {
  const frozen = JSON.parse(
    readFileSync(
      new URL(`./fixtures/source-integrity/${license}.json`, import.meta.url),
      "utf8",
    ),
  );
  return {
    id: `original-${license}`,
    licenseNo: frozen.licenseNo,
    version: frozen.version,
    page: 1,
    start: 0,
    text: frozen.text,
    ...(frozen.sourceFormat ? { sourceFormat: frozen.sourceFormat } : {}),
  };
}
const approve: Llm = {
  json: async (system, input: any) => {
    if (system.includes("審核器"))
      return {
        verdicts: input.expectedIds.map((id: string) => ({
          id,
          supported: true,
        })),
      };
    const source = input.sources.find((p: any) => p.purposeEligible);
    return {
      status: "supported",
      claims: [
        {
          text: source.text,
          category: "purpose",
          citations: [{ sourceId: source.id }],
        },
      ],
      quiz: [
        {
          q: `依仿單${source.sourceSection}欄，何者符合用途？`,
          options: ["來源記載的用途", "只記載包裝"],
          answer: 0,
          claimIndex: 0,
          learningObjective: "purpose",
          sourceSection: source.sourceSection,
          requiredConditions: [],
          citations: [{ sourceId: source.id }],
        },
      ],
    };
  },
};

describe("complete safety-source education and bounded section reading", () => {
  it.each([
    ["040161", ["警語", "過量", "注意事項"], ["過量", "注意事項"]],
    ["030418", ["使用上注意事項", "警語"], ["警語"]],
    ["026087", ["副作用", "注意事項", "警語"], ["副作用", "注意事項", "警語"]],
    ["039632", ["注意事項"], []],
    ["040833", ["使用上注意事項", "警語"], ["警語"]],
    [
      "014025",
      ["禁忌", "警語及注意事項", "交互作用", "副作用/不良反應", "過量"],
      ["禁忌", "警語及注意事項", "交互作用", "副作用/不良反應", "過量"],
    ],
  ])(
    "fills every real %s safety field even when generation omits all warnings and warning quizzes",
    async (license, expected, tested) => {
      const page = original(license as string);
      const result = await grounded(
        approve,
        "完整仿單與理解確認",
        [page],
        {},
        "bundle",
      );
      const safety = sourcePassages([page]).filter((p) =>
        SAFETY_SECTIONS.has(p.sourceSection || ""),
      );
      expect(safety.map((p) => p.sourceSection)).toEqual(expected);
      expect(result.safetyCoverage).toMatchObject({
        status: expected.length === tested.length ? "complete" : "partial",
        sourceSectionCount: expected.length,
        coveredSectionCount: expected.length,
        quizCoveredSectionCount: tested.length,
        assessmentScope: "one_key_point_per_section",
      });
      expect(result.chunks).toEqual([page]);
      for (const passage of safety) {
        const section = result.safetyCoverage!.sections.find(
          (s) => s.sourceSection === passage.sourceSection,
        )!;
        expect(norm(result.claims[section.claimIndex].text)).toBe(
          norm(passage.quote),
        );
        expect(result.claims[section.claimIndex].citations).toEqual([
          { chunkId: page.id, quote: passage.quote },
        ]);
        if (!tested.includes(passage.sourceSection!)) {
          expect(section.quizIds).toEqual([]);
          continue;
        }
        const question = result.quiz.find((q) => q.id === section.quizIds[0])!;
        expect(question.assessmentScope).toBe("one_key_point");
        expect(question.citations).toEqual([
          { chunkId: page.id, quote: passage.quote },
        ]);
        expect(question.options.every((option) => option.length <= 400)).toBe(
          true,
        );
        expect(question.options[0]).not.toBe(question.options[1]);
        expect(question.q).toContain(passage.sourceSection);
        expect(question.q).not.toContain("可忽略");
        expect(question.explain).toContain(passage.quote.trim());
      }
      expect(result.rejectedCount).toBe(0);
    },
  );

  it("preserves numbered official HTML titles, both flavor branches and table ancestry", () => {
    const page = original("040833");
    const passages = sourcePassages([page]);
    expect(passages.map((p) => p.quote).join("")).toBe(page.text);
    expect(passages.some((p) => p.sourceSection === "用途(適應症)")).toBe(true);
    expect(passages.filter((p) => p.sourceSection === "警語")).toHaveLength(1);
    expect(passages.some((p) => p.sourceSection === "副作用")).toBe(false);
    const warning = passages.find((p) => p.sourceSection === "警語")!;
    expect(warning.quote).toContain("請立即停止使用");
    expect(warning.quote).toContain("排尿困難、視覺模糊");
    expect(warning.quote).toContain("喉嚨疼痛持續兩日以上");
    expect(page.text).toContain("柑橘口味");
    expect(page.text).toContain("葡萄口味");
  });

  it("keeps an independently approved concrete warning question rather than replacing it with a template", () => {
    const passage = sourcePassages([original("040161")]).find(
      (p) => p.sourceSection === "警語",
    )!;
    const citations = [{ chunkId: passage.chunkId, quote: passage.quote }];
    const reviewed: GroundedResult["quiz"][number] = {
      id: "q-reviewed",
      q: "依仿單警語，服用後若出現發疹等症狀，應如何？",
      options: ["停藥並就醫", "自行繼續使用"],
      answer: 0,
      explain: passage.quote,
      citations,
      learningObjective: "warning",
      sourceSection: "警語",
    };
    const completed = completeSafetyLearning({ claims: [], quiz: [reviewed] }, [
      passage,
    ]);
    expect(completed.quiz).toHaveLength(1);
    expect(completed.quiz[0].q).toBe(reviewed.q);
    expect(completed.safetyCoverage!.sections[0].quizIds).toEqual([
      reviewed.id,
    ]);
  });

  it("keeps a complete parent exception and causal condition in both opposing choices", () => {
    const p = {
      chunkId: "parent",
      sourceSection: "警語",
      quote: "警語：除非有醫師指示，氣喘所引起之咳嗽病人請勿自行使用。",
    };
    const question = safetyReadingQuestion(p)!;
    expect(
      question.options.every(
        (option) =>
          option.includes("除非有醫師指示") && option.includes("所引起之咳嗽"),
      ),
    ).toBe(true);
    expect(question.options[question.answer]).toContain("請勿自行使用");
    expect(question.options[1 - question.answer]).toContain("可以自行使用");
    expect(safetyReadingQuestion(p)?.id).toBe(question.id);
    expect(
      safetyReadingQuestion({ ...p, chunkId: "other-version" })?.id,
    ).not.toBe(question.id);
  });

  it("cleans a proven TAB-separated adverse-reaction subheading without clipping decimal doses or conditions", () => {
    const quote =
      "8 副作用/不良反應\n8.1\t臨床重要副作用/不良反應\n\t8.1.1\t偶有噁心、腹瀉、口乾、食慾增加等副作用。\n";
    const q = safetyReadingQuestion({
      chunkId: "numbered-html",
      sourceSection: "副作用/不良反應",
      quote,
    })!;
    expect(q.options[q.answer]).toBe(
      "偶有噁心、腹瀉、口乾、食慾增加等副作用。",
    );
    expect(q.citations[0].quote).toBe(quote);
    expect(q.explain).toContain(quote.trim());
    for (const body of [
      "8.1mg之合成劑量不得使用。",
      "8.1\n合成條件者不得使用。",
      "8.1 臨床重要副作用/不良反應\n8.1.1\t偶有合成副作用。",
      "8.1\t臨床重要副作用/不良反應\n8.2.1\t偶有合成副作用。",
    ]) {
      const original = "8 副作用/不良反應\n" + body;
      const preserved = safetyReadingQuestion({
        chunkId: "negative",
        sourceSection: "副作用/不良反應",
        quote: original,
      })!;
      expect(preserved.options[preserved.answer]).toContain(
        body.includes("8.2.1") ? "8.2.1" : "8.1",
      );
      expect(preserved.citations[0].quote).toBe(original);
    }
  });

  it("marks an uncertain or overlong first point untested instead of manufacturing a question", () => {
    const p = {
      chunkId: "unknown",
      sourceSection: "警語",
      quote: "警語：合成情境是否適用尚不明確。",
    };
    const complete = completeSafetyLearning({ claims: [], quiz: [] }, [p]);
    expect(complete.claims[0].text).toBe(p.quote);
    expect(complete.quiz).toEqual([]);
    expect(complete.safetyCoverage).toMatchObject({
      status: "partial",
      coveredSectionCount: 1,
      quizCoveredSectionCount: 0,
    });
    expect(
      safetyReadingQuestion({
        ...p,
        quote: "警語：" + "合成條件".repeat(100) + "請勿自行使用。",
      }),
    ).toBeUndefined();
  });

  it("retains an immediate second-sentence exception and rejects uncertain modal phrasing", () => {
    const passage = {
      chunkId: "exception",
      sourceSection: "警語",
      quote: "警語：合成情境甲不得使用。但有醫師明確指示者除外。",
    };
    const q = safetyReadingQuestion(passage)!;
    expect(
      q.options.every((option) => option.includes("但有醫師明確指示者除外")),
    ).toBe(true);
    expect(
      safetyReadingQuestion({
        ...passage,
        quote: "警語：本品可能發生之副作用尚不明確。",
      }),
    ).toBeUndefined();
    expect(
      safetyReadingQuestion({ ...passage, quote: "警語：目前尚無資訊。" })
        ?.options,
    ).toContain("目前已有完整資訊。");
  });

  it("does not fabricate warning fields for an official source without recognized safety sections", () => {
    const completed = completeSafetyLearning({ claims: [], quiz: [] }, [
      {
        chunkId: "none",
        sourceSection: "適應症",
        quote: "適應症：緩解合成症狀。",
      },
    ]);
    expect(completed.claims).toEqual([]);
    expect(completed.quiz).toEqual([]);
    expect(completed.safetyCoverage?.status).toBe("no_sections");
  });

  it("never bypasses an explicit refusal to publish source material", async () => {
    const page = original("040161");
    for (const refuse of [true]) {
      const llm: Llm = {
        json: async (system, input: any) =>
          refuse
            ? { status: "refused", claims: [], quiz: [] }
            : system.includes("審核器")
              ? {
                  verdicts: input.expectedIds.map((id: string) => ({
                    id,
                    supported: false,
                  })),
                }
              : approve.json(system, input),
      };
      const result = await grounded(llm, "完整仿單", [page], {}, "bundle");
      expect(result.claims).toEqual([]);
      expect(result.quiz).toEqual([]);
      expect(result.safetyCoverage).toBeUndefined();
    }
  });

  it("recovers the real 014025 canonical Bl/Bl2 purpose after the model's changed B1/B12 wording is rejected", async () => {
    const page = original("014025");
    let reviewed: any;
    const llm: Llm = {
      json: async (system, input: any) => {
        if (system.includes("審核器")) {
          reviewed = input;
          return {
            verdicts: input.claims.map((check: any) => ({
              id: check.id,
              supported: true,
            })),
          };
        }
        const purpose = input.sources.find(
          (source: any) => source.purposeEligible,
        );
        const warning = input.sources.find(
          (source: any) => source.sourceSection === "警語及注意事項",
        );
        return {
          status: "supported",
          claims: [
            {
              text: "仿單適應症記載：維生素B1、B6、B12等缺乏所引起的神經痛、肌肉痛、腰痛、肩膀酸痛及腳氣病。",
              category: "purpose",
              citations: [{ sourceId: purpose.id }],
            },
            {
              text: warning.text,
              category: "warning",
              citations: [{ sourceId: warning.id }],
            },
          ],
          quiz: [
            {
              q: "依仿單適應症欄記載的用途，哪些疾患可由維生素B1、B6、B12等缺乏引起？",
              claimIndex: 0,
              learningObjective: "purpose",
              sourceSection: "適應症",
              requiredConditions: [],
              options: [
                "神經痛、肌肉痛、腰痛、肩膀酸痛及腳氣病",
                "氣喘及高血壓",
              ],
              answer: 0,
              citations: [{ sourceId: purpose.id }],
            },
          ],
        };
      },
    };
    const result = await grounded(
      llm,
      "完整用途與安全理解",
      [page],
      {},
      "bundle",
    );
    const exact = result.claims.find(
      (claim) => claim.kind === "source_exact_purpose",
    )!;
    expect(exact.text).toContain("維生素Bl、B6、Bl2");
    expect(exact.text).toContain("妊娠授乳期");
    expect(exact.text).not.toContain("維生素B1、B6、B12");
    expect(result.rejectedCount).toBe(1);
    expect(
      reviewed.claims.every(
        (claim: any) =>
          claim.category !== "purpose" && claim.learningObjective !== "purpose",
      ),
    ).toBe(true);
    expect(result.quiz.some((q) => q.q.includes("哪些疾患可由維生素B1"))).toBe(
      false,
    );
    expect(result.status).toBe("supported");
    expect(result.safetyCoverage).toMatchObject({
      status: "complete",
      coveredSectionCount: 5,
      quizCoveredSectionCount: 5,
    });
    const question = result.quiz.find(
      (q) => q.learningObjective === "purpose",
    )!;
    expect(question.options[question.answer]).toContain("維生素Bl、B6、Bl2");
    expect(question.options[question.answer]).toContain("妊娠授乳期");
    expect(question.options[1 - question.answer]).toMatch(
      /^原文明確未記載以下用途：/,
    );
    expect(exact.citations[0].quote).toBe(question.citations[0].quote);
    expect(page.text).toContain(exact.citations[0].quote);
  });

  it("replaces a missing approved purpose quiz with a short whole-field reading question, keeping later restrictions", async () => {
    const page = {
      ...original("014025"),
      id: "purpose-conditions",
      text: "【適應症】緩解合成症狀甲。僅限成人。除非有合成指示，兒童不可使用。\n【包裝】合成包裝。",
    };
    const result = await grounded(
      {
        json: async (system, input: any) => {
          if (system.includes("審核器"))
            return {
              verdicts: input.expectedIds.map((id: string) => ({
                id,
                supported: true,
              })),
            };
          const purpose = input.sources.find(
            (source: any) => source.purposeEligible,
          );
          return {
            status: "supported",
            claims: [
              {
                text: purpose.text,
                category: "purpose",
                citations: [{ sourceId: purpose.id }],
              },
            ],
            quiz: [
              {
                q: "本品主要功效為何？",
                options: ["合成症狀甲", "包裝"],
                answer: 0,
                claimIndex: 0,
                learningObjective: "purpose",
                sourceSection: "適應症",
                requiredConditions: [],
                citations: [{ sourceId: purpose.id }],
              },
            ],
          };
        },
      },
      "合成理解",
      [page],
      {},
      "bundle",
    );
    const purpose = result.claims.find(
      (claim) => claim.kind === "source_exact_purpose",
    )!;
    const question = result.quiz.find(
      (q) => q.learningObjective === "purpose",
    )!;
    expect(purpose.text).toContain("僅限成人");
    expect(norm(question.options[question.answer])).toContain(
      norm("除非有合成指示，兒童不可使用"),
    );
    expect(result.quiz.some((q) => q.q === "本品主要功效為何？")).toBe(false);
  });

  it("keeps an approved purpose and its own approved question unchanged", async () => {
    const page = { ...original("014025"), text: "【適應症】緩解合成症狀甲。" };
    const result = await grounded(approve, "合成理解", [page], {}, "bundle");
    expect(result.claims[0].kind).toBeUndefined();
    expect(result.claims[0].text).toBe(page.text);
    expect(result.quiz[0].id).toBe("q0");
    expect(result.quiz[0].options).toEqual(["來源記載的用途", "只記載包裝"]);
    expect(result.quiz.some((q) => q.id.startsWith("purpose-"))).toBe(false);
  });

  it.each([
    "【效能】增加合成受體活性與吸收濃度。",
    "【作用機轉】用於促進合成受體活性。",
  ])(
    "does not manufacture a clinical purpose from a mechanism: %s",
    async (text) => {
      const result = await grounded(
        { json: async () => ({ status: "not_found", claims: [], quiz: [] }) },
        "用途",
        [{ ...original("014025"), text }],
        {},
        "bundle",
      );
      expect(result.claims).toEqual([]);
      expect(result.quiz).toEqual([]);
      expect(result.status).not.toBe("supported");
    },
  );

  it("reports insufficient data when the whole eligible field is too long for a clear short reading question", async () => {
    const page = {
      ...original("014025"),
      text: "【適應症】緩解合成症狀甲。" + "完整合成條件。".repeat(80),
    };
    const result = await grounded(
      { json: async () => ({ status: "not_found", claims: [], quiz: [] }) },
      "用途",
      [page],
      {},
      "bundle",
    );
    expect(
      result.claims.some((claim) => claim.kind === "source_exact_purpose"),
    ).toBe(true);
    expect(result.quiz).toEqual([]);
    expect(result.status).toBe("insufficient_data");
  });

  it("does not use canonical recovery to bypass malformed model output or missing review verdicts", async () => {
    const page = original("014025");
    await expect(
      grounded(
        { json: async () => ({ status: "invalid", claims: [], quiz: [] }) },
        "用途",
        [page],
        {},
        "bundle",
      ),
    ).rejects.toMatchObject({ code: "invalid_ai_output" });
    await expect(
      grounded(
        {
          json: async (system, input) =>
            system.includes("審核器")
              ? { verdicts: [] }
              : approve.json(system, input),
        },
        "用途",
        [page],
        {},
        "bundle",
      ),
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("refuses an over-budget full bundle before any model call instead of silently dropping a page", async () => {
    let calls = 0;
    const page = original("040161");
    const pages = [
      page,
      {
        ...page,
        id: "too-long",
        page: 2,
        text: "合成".repeat(SOURCE_PAGE_CHAR_LIMIT),
      },
    ];
    await expect(
      grounded(
        {
          json: async () => {
            calls++;
            return {};
          },
        },
        "完整仿單",
        pages,
        {},
        "bundle",
      ),
    ).rejects.toMatchObject({ code: "source_requires_review" });
    expect(calls).toBe(0);
  });
});
