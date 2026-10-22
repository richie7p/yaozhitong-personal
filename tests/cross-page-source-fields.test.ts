import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  citationsValid,
  grounded,
  sourcePassages,
  GROUNDING_VERSION,
  type Llm,
} from "../server/ai";
import { completeWarningCitations } from "../server/source-boundary";
import {
  passageCitations,
  sameCitationSet,
} from "../server/source-field-spans";
import {
  completeSafetyLearning,
  safetyReadingQuestion,
  SAFETY_SECTIONS,
} from "../server/safety-learning";
import type { Chunk, Claim } from "../shared/schema";

// Official, already published canonical pages only; no account or job metadata.
const originals: { licenseNo: string; chunks: Chunk[] }[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/cross-page-source-fields.json", import.meta.url),
    "utf8",
  ),
);
const original = (suffix: string) =>
  structuredClone(
    originals.find((source) => source.licenseNo.includes(suffix))!.chunks,
  );
const norm = (text: string) => text.normalize("NFKC").replace(/\s/gu, "");
const claim = (
  citations: Claim["citations"],
  category: Claim["category"] = "warning",
): Claim => ({
  text: citations.map((citation) => citation.quote).join("\n"),
  citations,
  category,
});
const approved: Llm = {
  json: async (system, input: any) => {
    if (system.includes("審核器"))
      return {
        verdicts: input.expectedIds.map((id: string) => ({
          id,
          supported: true,
        })),
      };
    const purpose = input.sources.find((source: any) => source.purposeEligible);
    return {
      status: "supported",
      claims: purpose
        ? [
            {
              text: purpose.text,
              category: "purpose",
              citations: [{ sourceId: purpose.id }],
            },
          ]
        : [],
      quiz: [],
      followups: [],
    };
  },
};
const synthetic = (texts: string[]): Chunk[] =>
  texts.map((text, index) => ({
    id: "synthetic-canonical-" + (index + 1),
    licenseNo: "SYNTHETIC-CROSS-PAGE",
    version: "literal-v1",
    page: index + 1,
    start: 0,
    sourceFormat: "pdf",
    text,
  }));
const shortTail = () =>
  synthetic([
    "【適應症】緩解合成測試症狀。\n【警語】除非有合成醫師指示，有合成風險者不得使用。請特別注",
    "意。\n【包裝】合成包裝資料。",
  ]);

describe("canonical cross-page safety fields", () => {
  it.each(["other", undefined] as const)(
    "retains the full boundary inventory when chat budget hides a cross-page unit (%s)",
    async (category) => {
      const partial = "有合成風險者不得使用。";
      const chunks = synthetic([
        "【成分】" +
          "合成".repeat(2000) +
          "。\n【警語】" +
          partial +
          "另應注意",
        "合成症狀持續時請洽合成專業人員。\n【包裝】" +
          "資料".repeat(8000) +
          "。",
      ]);
      chunks.push({
        ...chunks[0],
        id: "other-leaflet",
        licenseNo: "OTHER-SYNTHETIC",
        page: 1,
        text: "【成分】合成風險說明。" + "其他".repeat(6000) + "。",
      });
      let reviewCalls = 0;
      const result = await grounded(
        {
          json: async (system, input: any) => {
            if (system.includes("審核器")) {
              reviewCalls++;
              return { verdicts: [] };
            }
            expect(
              input.sources.some(
                (source: any) => source.sourceSection === "警語",
              ),
            ).toBe(false);
            return {
              status: "supported",
              claims: [
                {
                  text: partial,
                  category,
                  citations: [{ chunkId: chunks[0].id, quote: partial }],
                },
              ],
              quiz: [],
            };
          },
        },
        "合成風險說明",
        chunks,
        {},
        "chat",
      );
      expect(result.claims).toEqual([]);
      expect(result.rejectedCount).toBe(1);
      expect(reviewCalls).toBe(0);
    },
  );
  it("does not mistake a dangling numbered-item dot for a completed warning sentence", () => {
    expect(() =>
      sourcePassages(
        synthetic([
          "【警語】合成條件成立時，請勿使用\n16. \n【過量】合成來源尚待核對。",
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
  });
  it.each(["無", "無。", "NA", "NA.", "N/A", "尚無資訊"])(
    "keeps the exact unavailable marker %s consistent through the citation gate",
    (marker) => {
      const chunks = synthetic([`【過量】${marker}\n【包裝】合成包裝。`]);
      const sources = sourcePassages(chunks);
      const source = sources.find(
        (passage) => passage.sourceSection === "過量",
      )!;
      expect(source.evidenceKind).toBe("literal_unavailable");
      expect(source.quote).toContain(marker);
      expect(
        citationsValid(claim(passageCitations(source)), chunks, sources),
      ).toBe(true);
      expect(
        citationsValid(
          claim([{ chunkId: chunks[0].id, quote: marker }]),
          chunks,
          sources,
        ),
      ).toBe(false);
    },
  );
  it("does not treat a punctuated unknown short medical fragment as unavailable", () => {
    expect(() =>
      sourcePassages(synthetic(["【禁忌】女。\n【包裝】合成包裝。"])),
    ).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
  });
  it("distinguishes structural empty containers and exact unavailable markers from unknown medical fragments", () => {
    const sources = sourcePassages(
      synthetic([
        "【注意事項】\n禁忌：合成風險者不得使用。\n【過量】NA\n【包裝】合成包裝。",
      ]),
    );
    const container = sources.find(
      (source) => source.sourceSection === "注意事項",
    )!;
    const unavailable = sources.find(
      (source) => source.sourceSection === "過量",
    )!;
    expect(container.evidenceKind).toBe("structural_container");
    expect(unavailable.evidenceKind).toBe("literal_unavailable");
    expect(
      citationsValid(
        claim(passageCitations(unavailable)),
        synthetic([
          "【注意事項】\n禁忌：合成風險者不得使用。\n【過量】NA\n【包裝】合成包裝。",
        ]),
        sources,
      ),
    ).toBe(true);
    const result = completeSafetyLearning({ claims: [], quiz: [] }, sources);
    expect(
      result.claims.some((value) => value.text === container.quote.trim()),
    ).toBe(false);
    expect(
      result.claims.find((value) => value.text === unavailable.quote.trim())
        ?.citations,
    ).toEqual(passageCitations(unavailable));
    expect(() =>
      sourcePassages(synthetic(["【禁忌】女\n【包裝】合成包裝。"])),
    ).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
    expect(() => sourcePassages(synthetic(["【警語】"]))).toThrowError(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });
  it("retains original display text while measuring model eligibility with whitespace normalization", () => {
    const original = "【警語】" + "合成    原文".repeat(190) + "。";
    const chunks = synthetic([original]);
    const sources = sourcePassages(chunks);
    const result = completeSafetyLearning({ claims: [], quiz: [] }, sources);
    expect(original.length).toBeGreaterThan(1500);
    expect(result.claims[0].text).toBe(original);
    expect(sources[0].modelEligible).toBe(true);
    expect(norm(result.claims[0].text)).toBe(norm(original));
    expect(result.claims[0].citations[0].quote).toBe(original);
  });
  it("counts the whole 051528 field as readable while explicitly leaving its assessment partial", () => {
    const safety = sourcePassages(original("051528")).filter(
      (source) => source.sourceSection === "警語及注意事項",
    );
    const result = completeSafetyLearning({ claims: [], quiz: [] }, safety);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe(safety[0].quote.trim());
    expect(result.quiz).toEqual([]);
    expect(result.safetyCoverage).toMatchObject({
      status: "partial",
      sourceSectionCount: 1,
      coveredSectionCount: 1,
      quizCoveredSectionCount: 0,
    });
    expect(result.safetyCoverage!.sections[0].claimIndices).toEqual([0]);
    expect(result.safetyCoverage!.sections[0].quizIds).toEqual([]);
  });
  it("retains complete 010332 fields but creates a template only for its bounded complete adverse-effect field", () => {
    const sources = sourcePassages(original("010332"));
    for (const section of ["注意事項", "交互作用"]) {
      const source = sources.find(
        (passage) => passage.sourceSection === section,
      )!;
      expect(safetyReadingQuestion(source)).toBeUndefined();
    }
    const result = completeSafetyLearning({ claims: [], quiz: [] }, sources);
    expect(result.safetyCoverage).toMatchObject({
      status: "partial",
      sourceSectionCount: 3,
      coveredSectionCount: 3,
      quizCoveredSectionCount: 1,
    });
    expect(result.quiz[0].sourceSection).toBe("副作用");
  });
  it("holds a field exceeding the existing six-origin citation limit before generation", () => {
    expect(() =>
      sourcePassages(
        synthetic([
          "【警語】合成條件",
          "甲",
          "乙",
          "丙",
          "丁",
          "戊",
          "成立時，請勿自行使用。",
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
  });
  it("assembles real 051528 as one complete field retaining all 14 items and cross-page words", () => {
    const chunks = original("051528");
    const passages = sourcePassages(chunks);
    const warning = passages.filter(
      (passage) => passage.sourceSection === "警語及注意事項",
    );
    expect(warning).toHaveLength(1);
    expect(
      new Set(warning.map((passage) => passage.originalFieldId)).size,
    ).toBe(1);
    const document = chunks.map((chunk) => chunk.text).join("\n");
    const expected = document.slice(
      document.indexOf("【警語及注意事項】"),
      document.indexOf("【賦形劑】"),
    );
    expect(norm(warning.map((passage) => passage.quote).join(""))).toBe(
      norm(expected),
    );
    expect(expected.replace(/\s+/gu, " ").trim()).toHaveLength(1610);
    expect(warning[0].modelEligible).toBe(false);
    expect(warning[0].originalFieldUnitCount).toBe(1);
    expect(warning[0].quote).toContain("請遵循下列情況服用");
    expect(warning[0].quote).toContain("曾經因藥物引起過敏症狀者不得使用");
    expect(warning[0].requiredConditions).toContain("除非有醫師藥師藥劑生指示");
    expect(warning[0].quote).toContain("4,000");
    const overdose = warning[0];
    expect(passageCitations(overdose)).toHaveLength(2);
    expect(passageCitations(overdose)[0].quote.trim()).toMatch(/專$/u);
    expect(passageCitations(overdose)[1].quote.trim()).toMatch(/^家。/u);
    for (const passage of warning)
      for (const citation of passageCitations(passage))
        expect(
          chunks.find((chunk) => chunk.id === citation.chunkId)!.text,
        ).toContain(citation.quote);
    expect(
      completeWarningCitations(
        claim(passageCitations(overdose)),
        chunks,
        passages,
        SAFETY_SECTIONS,
      ),
    ).toBe(false);
    for (const category of ["warning", "other", undefined] as const)
      for (const citation of passageCitations(overdose))
        expect(
          completeWarningCitations(
            claim([citation], category),
            chunks,
            passages,
            SAFETY_SECTIONS,
          ),
        ).toBe(false);
  });
  it("keeps real 010332's under-cap whole field and ends inherited scope at the next heading", () => {
    const chunks = original("010332"),
      passages = sourcePassages(chunks);
    const attention = passages.filter(
      (passage) => passage.sourceSection === "注意事項",
    );
    expect(attention).toHaveLength(1);
    expect(attention[0].quote.replace(/\s+/gu, " ").trim()).toHaveLength(1380);
    expect(passageCitations(attention[0])).toHaveLength(2);
    expect(attention[0].quote).toContain("FDA Pregnancy Category");
    expect(attention[0].quote).not.toContain("【交互作用】");
    expect(
      passages.filter((passage) => passage.sourceSection === "交互作用"),
    ).toHaveLength(1);
    expect(
      passages.filter((passage) => passage.sourceSection === "副作用"),
    ).toHaveLength(1);
  });
  it.each(["051528", "010332", "018498"])(
    "runs genuine %s offline end to end and groups complete field coverage",
    async (suffix) => {
      const chunks = original(suffix),
        passages = sourcePassages(chunks);
      if (suffix === "018498") expect(passages).toHaveLength(14);
      const result = await grounded(
        approved,
        "仿單用途、完整警語與理解確認",
        chunks,
        {},
        "bundle",
      );
      const safety = passages.filter((passage) =>
        SAFETY_SECTIONS.has(passage.sourceSection || ""),
      );
      for (const passage of safety) {
        const exact = result.claims.find(
          (value) =>
            value.kind === "source_exact_safety" &&
            sameCitationSet(value.citations, passageCitations(passage)),
        );
        expect(exact?.text).toBe(passage.quote.trim());
        expect(norm(exact!.text)).toBe(norm(passage.quote));
        expect(citationsValid(exact!, chunks, passages)).toBe(true);
      }
      expect(result.safetyCoverage!.sourceSectionCount).toBe(
        new Set(safety.map((passage) => passage.originalFieldId)).size,
      );
      expect(result.safetyCoverage!.coveredSectionCount).toBe(
        result.safetyCoverage!.sourceSectionCount,
      );
      if (suffix === "051528") {
        expect(result.safetyCoverage!.sourceSectionCount).toBe(1);
        expect(result.safetyCoverage!.sections[0].claimIndices).toHaveLength(1);
        expect(result.safetyCoverage!.status).toBe("partial");
        expect(result.safetyCoverage!.sections[0].quizIds).toEqual([]);
        expect(
          result.quiz.some(
            (question) => question.learningObjective === "purpose",
          ),
        ).toBe(true);
        expect(
          result.quiz
            .filter((question) => question.learningObjective === "warning")
            .every(
              (question) =>
                question.coverageSectionId ===
                result.safetyCoverage!.sections[0].id,
            ),
        ).toBe(true);
      }
    },
  );
  it("allows an actual short page tail only as part of its exact complete canonical support", async () => {
    const chunks = shortTail(),
      passages = sourcePassages(chunks);
    const warning = passages.find(
      (passage) => passage.sourceSection === "警語",
    )!;
    const citations = passageCitations(warning);
    expect(norm(citations[1].quote).length).toBeLessThan(7);
    expect(citationsValid(claim(citations), chunks, passages)).toBe(true);
    expect(citationsValid(claim([citations[1]]), chunks, passages)).toBe(false);
    expect(citationsValid(claim(citations), chunks)).toBe(false);
    expect(
      completeWarningCitations(
        claim([...citations].reverse()),
        chunks,
        passages,
        SAFETY_SECTIONS,
      ),
    ).toBe(false);
    expect(
      completeWarningCitations(
        claim([...citations, citations[1]]),
        chunks,
        passages,
        SAFETY_SECTIONS,
      ),
    ).toBe(false);
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
          const source = input.sources.find(
            (source: any) => source.sourceSection === "警語",
          );
          return {
            status: "supported",
            claims: [
              {
                text: source.text,
                category: "warning",
                citations: [{ sourceId: source.id }],
              },
            ],
            quiz: [],
          };
        },
      },
      "一般警語",
      chunks,
      {},
      "chat",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].citations).toEqual(citations);
  });
  it("inherits a condition split inside its words, preserving it in the generator and rejecting its omission", async () => {
    const chunks = synthetic([
      "【適應症】緩解合成測試症狀。\n【警語】除非有合成醫",
      "師指示，有合成風險者請勿使用。",
    ]);
    const passage = sourcePassages(chunks).find(
      (source) => source.sourceSection === "警語",
    )!;
    expect(passage.requiredConditions).toEqual(["除非有合成醫師指示"]);
    const result = await grounded(
      {
        json: async (system, input: any) => {
          if (system.includes("審核器"))
            throw new Error("incomplete condition reached model review");
          const source = input.sources.find(
            (source: any) => source.sourceSection === "警語",
          );
          expect(norm(source.requiredConditions[0])).toBe("除非有合成醫師指示");
          return {
            status: "supported",
            claims: [
              {
                text: "有合成風險者請勿使用。",
                category: "warning",
                citations: [{ sourceId: source.id }],
              },
            ],
            quiz: [],
          };
        },
      },
      "一般警語",
      chunks,
      {},
      "chat",
    );
    expect(result.claims).toHaveLength(0);
  });
  it.each([
    "missing-first",
    "gap",
    "license",
    "version",
    "overlap",
    "duplicate-id",
    "duplicate-page",
    "fake-format",
  ])("fails closed for %s canonical bindings", (mode) => {
    const chunks = shortTail();
    if (mode === "missing-first") chunks.shift();
    if (mode === "gap") chunks[1].page = 3;
    if (mode === "license") chunks[1].licenseNo = "OTHER-LICENSE";
    if (mode === "version") chunks[1].version = "other-version";
    if (mode === "overlap") chunks[1].start = 2;
    if (mode === "duplicate-id") chunks[1].id = chunks[0].id;
    if (mode === "duplicate-page") chunks[1].page = 1;
    if (mode === "fake-format") chunks[1].sourceFormat = "html";
    expect(() => sourcePassages(chunks)).toThrowError(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });
  it("canonicalizes caller relevance order without reversing citation order", () => {
    const chunks = original("010332");
    expect(sourcePassages([...chunks].reverse())).toEqual(
      sourcePassages(chunks),
    );
  });
  it.each([
    "intro",
    "not-consecutive",
    "decimal",
    "unfinished",
    "unit-too-long",
    "dependent-item",
    "internal-cross-reference",
    "unresolved-first-sentence",
    "malformed-tenth",
  ])(
    "preserves over-cap %s fields whole without inferring numbered-item independence",
    (mode) => {
      let first = "合成原文".repeat(190) + "。";
      let text = `【警語】\n一、${first}\n二、${first}`;
      if (mode === "intro")
        text = text.replace(
          "【警語】",
          "【警語】所有下列情況除非合成醫師指示：",
        );
      if (mode === "not-consecutive") text = text.replace("二、", "三、");
      if (mode === "decimal")
        text = text.replace("一、", "1.5mg ").replace("二、", "2.5mg ");
      if (mode === "dependent-item")
        text = text.replace("二、", "二、但上述情況只有在合成條件成立時，");
      if (mode === "internal-cross-reference")
        text = text.replace("二、", "二、請依照前述條件，");
      if (mode === "unresolved-first-sentence")
        text = text.replace("二、", "二、若發生這些症狀，");
      if (mode === "malformed-tenth")
        text =
          "【警語】\n" +
          ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十十"]
            .map((number) => number + "、" + "合成原文".repeat(50) + "。")
            .join("\n");
      if (mode === "unfinished") text = text.slice(0, -1);
      if (mode === "unit-too-long")
        text = text.replace(first, "合成原文".repeat(400) + "。");
      if (mode === "unfinished") {
        expect(() => sourcePassages(synthetic([text]))).toThrowError(
          expect.objectContaining({ code: "source_requires_review" }),
        );
      } else {
        const fields = sourcePassages(synthetic([text]));
        expect(fields).toHaveLength(1);
        expect(fields[0].quote).toBe(text);
        expect(fields[0].modelEligible).toBe(false);
        expect(safetyReadingQuestion(fields[0])).toBeUndefined();
      }
    },
  );
  it("bumps generated-cache semantics", () =>
    expect(GROUNDING_VERSION).toBe(
      "grounded-v17-requested-chat-safety-coverage",
    ));
});
