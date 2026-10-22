import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  citationsValid,
  grounded,
  OutputSchema,
  sourcePassages,
} from "../server/ai";
import { completeWarningCitations } from "../server/source-boundary";
import { passageCitations } from "../server/source-field-spans";
import {
  completeSafetyLearning,
  safetyReadingQuestion,
  SAFETY_SECTIONS,
} from "../server/safety-learning";
import type { Chunk, Claim } from "../shared/schema";
import { SOURCE_PAGE_CHAR_LIMIT } from "../shared/source";

const chunk = (text: string): Chunk => ({
  id: "synthetic-forward-scope",
  licenseNo: "SYNTHETIC-FORWARD-SCOPE",
  version: "synthetic-v1",
  page: 1,
  start: 0,
  sourceFormat: "pdf",
  text,
});
const forward =
  "【警語】\n一、除非有合成醫師指示，以下各項都只適用於未滿12歲者。" +
  "合成原文保全。".repeat(110) +
  "\n二、不得使用本藥。" +
  "合成原文保全。".repeat(110);

describe("whole safety source scope and model eligibility", () => {
  const originals: { licenseNo: string; chunks: Chunk[] }[] = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/whole-safety-field-regressions.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  it.each(["037651", "037668", "039168", "037586", "040568"])(
    "preserves genuine %s's complete brief contraindication only as exact source reading",
    async (suffix) => {
      const chunks = originals.find((source) =>
        source.licenseNo.includes(suffix),
      )!.chunks;
      const fields = sourcePassages(chunks);
      const field = fields.find((passage) => passage.sourceSection === "禁忌")!;
      expect(field.quote.replace(/\s/gu, "")).toBe("4禁忌懷孕。");
      expect(field.evidenceKind).toBe("literal_short_field");
      expect(field.modelEligible).toBe(false);
      const exact = {
        text: field.quote.trim(),
        category: "warning" as const,
        citations: passageCitations(field),
      };
      expect(citationsValid(exact, chunks, fields)).toBe(true);
      expect(
        citationsValid(
          {
            ...exact,
            citations: [{ chunkId: field.chunkId, quote: "懷孕。" }],
          },
          chunks,
          fields,
        ),
      ).toBe(false);
      for (const category of ["warning", "other", undefined] as const)
        expect(
          completeWarningCitations(
            { ...exact, category },
            chunks,
            fields,
            SAFETY_SECTIONS,
          ),
        ).toBe(false);
      const completed = completeSafetyLearning({ claims: [], quiz: [] }, [
        field,
      ]);
      expect(completed.claims[0].text).toBe(field.quote.trim());
      expect(completed.quiz).toEqual([]);
      expect(completed.safetyCoverage).toMatchObject({
        status: "partial",
        coveredSectionCount: 1,
        quizCoveredSectionCount: 0,
      });
      const result = await grounded(
        {
          json: async (system, input: any) => {
            expect(system).not.toContain("審核器");
            expect(
              input.sources.some(
                (source: any) => source.sourceSection === "禁忌",
              ),
            ).toBe(false);
            return { status: "not_found", claims: [], quiz: [] };
          },
        },
        "仿單禁忌",
        chunks,
        {},
        "chat",
      );
      expect(result.status).toBe("insufficient_data");
      expect(result).toMatchObject({
        sourceReading: {
          sections: [
            { sourceSection: "禁忌", citations: passageCitations(field) },
          ],
        },
      });
    },
  );
  it.each(["008890", "025854", "003266", "059719", "043253", "038054"])(
    "keeps genuine %s's next-line numbered safety labels within their complete parent field",
    (suffix) => {
      const chunks = originals.find((source) =>
        source.licenseNo.includes(suffix),
      )!.chunks;
      const safety = sourcePassages(chunks).filter((field) =>
        SAFETY_SECTIONS.has(field.sourceSection || ""),
      );
      expect(safety).toHaveLength(1);
      expect(safety[0].sourceSection).toBe("注意事項");
      expect(safety[0].quote).toMatch(
        /\d+\.[^\S\r\n]*\r?\n[^\S\r\n]*(?:副作用|禁忌)\s*[:：]/u,
      );
      for (const citation of passageCitations(safety[0]))
        expect(
          chunks.find((chunk) => chunk.id === citation.chunkId)!.text,
        ).toContain(citation.quote);
      const result = completeSafetyLearning({ claims: [], quiz: [] }, safety);
      expect(result.claims[0].text).toBe(safety[0].quote.trim());
      expect(result.safetyCoverage!.coveredSectionCount).toBe(1);
    },
  );
  it("preserves a numbered child's next-line label and inherited condition, but recognizes genuine new fields outside a safety parent", () => {
    const text =
      "【注意事項】除非有合成醫師指示，以下各項適用於未滿12歲者。\n2.\n副作用：可能發生合成不適。\n【包裝】合成包裝。";
    const fields = sourcePassages([chunk(text)]);
    expect(fields.map((field) => field.sourceSection)).toEqual([
      "注意事項",
      "包裝",
    ]);
    expect(fields[0].quote).toContain("2.\n副作用：可能發生合成不適。");
    expect(fields[0].requiredConditions).toContain("除非有合成醫師指示");
    const topLevel = sourcePassages([
      chunk("【適應症】緩解合成症狀。\n2.\n副作用：可能發生合成不適。"),
    ]);
    expect(topLevel.some((field) => field.sourceSection === "副作用")).toBe(
      true,
    );
  });
  it.each(["032986", "004561"])(
    "keeps genuine %s numbered headings and repeated numbers inside the complete parent field",
    (suffix) => {
      const chunks = originals.find((source) =>
        source.licenseNo.includes(suffix),
      )!.chunks;
      const fields = sourcePassages(chunks);
      const warnings = fields.filter((field) => field.sourceSection === "警語");
      expect(warnings).toHaveLength(1);
      const warning = warnings[0];
      expect(warning.modelEligible).toBe(false);
      expect(warning.originalFieldUnitCount).toBe(1);
      expect(passageCitations(warning)).toHaveLength(chunks.length);
      expect(fields.some((field) => field.sourceSection === "過量")).toBe(
        false,
      );
      if (suffix === "032986")
        expect(warning.quote).toMatch(/16\.\s*過量\s*[:：]/u);
      if (suffix === "004561")
        expect(
          (warning.quote.match(/十二/g) || []).length,
        ).toBeGreaterThanOrEqual(2);
      for (const citation of passageCitations(warning))
        expect(
          chunks.find((chunk) => chunk.id === citation.chunkId)!.text,
        ).toContain(citation.quote);
      const result = completeSafetyLearning({ claims: [], quiz: [] }, [
        warning,
      ]);
      expect(result.claims[0].text).toBe(warning.quote.trim());
      expect(result.claims[0].citations).toEqual(passageCitations(warning));
      expect(result.safetyCoverage).toMatchObject({
        status: "partial",
        coveredSectionCount: 1,
        quizCoveredSectionCount: 0,
      });
    },
  );
  it("continues to hold the genuine 060225 ambiguous lone medical fragment", () => {
    const chunks = originals.find((source) =>
      source.licenseNo.includes("060225"),
    )!.chunks;
    expect(() => sourcePassages(chunks)).toThrowError(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });
  it.each(["16.", "16 .", "十六、", "十六 .", "16)", "十六）"])(
    "does not treat the outline marker %s as a sentence boundary before a colon label",
    (marker) => {
      const text = `【警語】除非有合成醫師指示，以下內容適用於未滿12歲者。\n${marker} 過量：不得使用本藥。\n【包裝】合成包裝。`;
      const fields = sourcePassages([chunk(text)]);
      expect(fields.some((field) => field.sourceSection === "過量")).toBe(
        false,
      );
      expect(
        fields.find((field) => field.sourceSection === "警語")!.quote,
      ).toContain(`${marker} 過量：不得使用本藥。`);
    },
  );
  it("still recognizes a real colon heading after a completed sentence", () => {
    const fields = sourcePassages([
      chunk("【警語】合成條件者不得使用。過量：合成過量症狀出現時應就醫。"),
    ]);
    expect(fields.map((field) => field.sourceSection)).toEqual([
      "警語",
      "過量",
    ]);
  });
  it("preserves the demonstrated forward-scoping counterexample without exposing an unconditional second item", () => {
    const chunks = [chunk(forward)];
    const fields = sourcePassages(chunks);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      quote: forward,
      modelEligible: false,
      originalFieldUnitIndex: 0,
      originalFieldUnitCount: 1,
    });
    expect(fields[0].requiredConditions).toContain("除非有合成醫師指示");
    expect(passageCitations(fields[0])).toEqual([
      { chunkId: chunks[0].id, quote: forward },
    ]);
    const result = completeSafetyLearning({ claims: [], quiz: [] }, fields);
    expect(result.claims).toEqual([
      {
        text: forward,
        kind: "source_exact_safety",
        category: "warning",
        citations: [{ chunkId: chunks[0].id, quote: forward }],
      },
    ]);
    expect(result.quiz).toEqual([]);
    expect(result.safetyCoverage).toMatchObject({
      status: "partial",
      sourceSectionCount: 1,
      coveredSectionCount: 1,
      quizCoveredSectionCount: 0,
    });
  });

  it.each(["warning", "purpose", "use", "other", undefined] as const)(
    "rejects complete and partial raw citations from an ineligible field for category %s before semantic review",
    async (category) => {
      const chunks = [chunk("【適應症】緩解合成測試症狀。\n" + forward)];
      const fields = sourcePassages(chunks);
      const warning = fields.find((field) => field.sourceSection === "警語")!;
      for (const quote of [warning.quote, "二、不得使用本藥。"]) {
        const candidate: Claim = {
          text: "不得使用本藥。",
          category,
          // Provider-supplied kind cannot authorize backend-only source text.
          kind: "source_exact_safety",
          citations: [{ chunkId: chunks[0].id, quote }],
        };
        expect(
          completeWarningCitations(candidate, chunks, fields, SAFETY_SECTIONS),
        ).toBe(false);
        let reviewCalls = 0;
        const result = await grounded(
          {
            json: async (system, input: any) => {
              if (system.includes("審核器")) {
                reviewCalls++;
                throw new Error("ineligible source reached model review");
              }
              expect(
                input.sources.every(
                  (source: any) => source.sourceSection !== "警語",
                ),
              ).toBe(true);
              return { status: "supported", claims: [candidate], quiz: [] };
            },
          },
          "一般警語",
          chunks,
          {},
          "chat",
        );
        expect(result.claims).toEqual([]);
        expect(result.rejectedCount).toBe(1);
        expect(reviewCalls).toBe(0);
      }
    },
  );

  it("does not resolve an excluded source id even when the provider guesses a real canonical id", async () => {
    const chunks = [chunk("【適應症】緩解合成測試症狀。\n" + forward)];
    const warning = sourcePassages(chunks).find(
      (field) => field.sourceSection === "警語",
    )!;
    await expect(
      grounded(
        {
          json: async () => ({
            status: "supported",
            claims: [
              { text: "不得使用本藥。", citations: [{ sourceId: warning.id }] },
            ],
            quiz: [],
          }),
        },
        "一般警語",
        chunks,
        {},
        "chat",
      ),
    ).rejects.toMatchObject({ code: "invalid_ai_output" });
  });

  it("keeps the provider's 1500-character output limit unchanged", () => {
    expect(
      OutputSchema.safeParse({
        status: "supported",
        claims: [
          { text: forward, citations: [{ chunkId: "x", quote: forward }] },
        ],
      }).success,
    ).toBe(false);
  });

  it("deduplicates repeated references to an identical published page while rejecting conflicting duplicate ids", async () => {
    const page = chunk(forward);
    const llm = {
      json: async () => {
        throw new Error("no model-eligible sources");
      },
    };
    const result = await grounded(
      llm,
      "一般警語",
      [page, { ...page }],
      {},
      "chat",
    );
    expect(result.chunks).toEqual([page]);
    expect(result).toMatchObject({
      sourceReading: {
        sections: [{ citations: [{ chunkId: page.id, quote: forward }] }],
      },
    });
    for (const change of [
      { text: forward + "合成差異。" },
      { version: "different-v2" },
      { page: 2 },
      { licenseNo: "OTHER" },
      { sourceFormat: "html" as const },
      { start: 1 },
    ]) {
      await expect(
        grounded(llm, "一般警語", [page, { ...page, ...change }], {}, "chat"),
      ).rejects.toMatchObject({ code: "source_requires_review" });
    }
  });

  it("retains a complete source at the existing source limit and holds any larger document", () => {
    const text =
      "【警語】" +
      "合".repeat(SOURCE_PAGE_CHAR_LIMIT - "【警語】".length - 1) +
      "。";
    const fields = sourcePassages([chunk(text)]);
    expect(fields).toHaveLength(1);
    expect(fields[0].quote).toBe(text);
    expect(fields[0].modelEligible).toBe(false);
    expect(() => sourcePassages([chunk(text + "。")])).toThrowError(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });

  it("retains later exceptions and forward conditions inside each short complete template option", () => {
    const quote =
      "【警語】一、以下各項只適用於未滿12歲者。二、不得使用本藥。三、除非有合成醫師指示。";
    const passage = sourcePassages([chunk(quote)])[0];
    const question = safetyReadingQuestion(passage)!;
    expect(question).toBeDefined();
    for (const option of question.options) {
      expect(option).toContain("以下各項只適用於未滿12歲者");
      expect(option).toContain("三、除非有合成醫師指示");
    }
    expect(question.options[question.answer]).toContain("二、不得使用本藥");
    expect(question.citations).toEqual(passageCitations(passage));
  });

  it("leaves long-field assessment partial instead of keeping a short first sentence and dropping a later exception", () => {
    const quote =
      "【警語】合成情境不得使用。" +
      "合成說明。".repeat(70) +
      "但有合成醫師指示時例外。";
    const passage = sourcePassages([chunk(quote)])[0];
    expect(passage.modelEligible).toBe(true);
    expect(safetyReadingQuestion(passage)).toBeUndefined();
    const result = completeSafetyLearning({ claims: [], quiz: [] }, [passage]);
    expect(result.claims[0].text).toBe(quote);
    expect(result.safetyCoverage).toMatchObject({
      status: "partial",
      coveredSectionCount: 1,
      quizCoveredSectionCount: 0,
    });
  });

  it("does not restore backend source reading after an explicit refusal", async () => {
    const result = await grounded(
      { json: async () => ({ status: "refused", claims: [], quiz: [] }) },
      "我是否可以使用",
      [chunk("【適應症】緩解合成測試症狀。\n" + forward)],
      {},
      "bundle",
    );
    expect(result.status).toBe("refused");
    expect(result.claims).toEqual([]);
    expect(result.quiz).toEqual([]);
    expect(result.safetyCoverage).toBeUndefined();
    expect(result).not.toHaveProperty("sourceReading");
  });

  it("returns typed unassessed complete source reading without a model call when no eligible evidence remains", async () => {
    let calls = 0;
    const chunks = [chunk(forward)];
    const result = await grounded(
      {
        json: async () => {
          calls++;
          throw new Error("no eligible model source");
        },
      },
      "仿單一般警語",
      chunks,
      {},
      "chat",
    );
    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: "insufficient_data",
      claims: [],
      quiz: [],
      chunks,
      sourceReading: {
        reason: "model_source_capacity",
        sections: [
          {
            sourceSection: "警語",
            citations: [{ chunkId: chunks[0].id, quote: forward }],
          },
        ],
      },
    });
  });

  it("marks a purpose answer partial and retains every original cross-page span when a requested long warning cannot be generated", async () => {
    const split = forward.indexOf("\n二、");
    const chunks = [
      chunk("【適應症】緩解合成測試症狀。\n" + forward.slice(0, split)),
      {
        ...chunk(forward.slice(split)),
        id: "synthetic-forward-scope-page2",
        page: 2,
      },
    ];
    const warning = sourcePassages(chunks).find(
      (passage) => passage.sourceSection === "警語",
    )!;
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
          expect(
            input.sources.some(
              (source: any) => source.sourceSection === "警語",
            ),
          ).toBe(false);
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
      },
      "仿單用途與完整警語",
      chunks,
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.claims.some((claim) => claim.category === "purpose")).toBe(
      true,
    );
    expect(result.claims.some((claim) => claim.category === "warning")).toBe(
      false,
    );
    expect(result.chunks).toEqual(chunks);
    expect(result).toMatchObject({
      sourceReading: {
        reason: "model_source_capacity",
        sections: [
          { sourceSection: "警語", citations: passageCitations(warning) },
        ],
      },
    });
  });

  it.each(["short", "long", "entirely omitted"])(
    "reports a %s safety field excluded by a shared multi-leaflet budget without exposing partial or oversized raw output",
    async (mode) => {
      const body = mode === "short" ? "合成原文。" : "合成原文。".repeat(170);
      const first = chunk(
        "【成分】" +
          "合成".repeat(2000) +
          "。\n【警語】除非有合成醫師指示，以下各項只適用於未滿12歲者。" +
          body,
      );
      const second = {
        ...chunk(
          "二、不得使用本藥。" +
            body +
            "\n【包裝】" +
            "資料".repeat(7500) +
            "。",
        ),
        id: "budget-source-page2",
        page: 2,
      };
      const other = {
        ...chunk(
          "【適應症】緩解合成測試症狀。\n【成分】preferthissource。" +
            "其他".repeat(mode === "entirely omitted" ? 10000 : 6000) +
            "。",
        ),
        id: "other-leaflet-page1",
        licenseNo: "OTHER-SYNTHETIC-BUDGET",
      };
      const chunks = [first, second, other];
      let generationCalls = 0;
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
            generationCalls++;
            expect(
              input.sources.some(
                (source: any) => source.sourceSection === "警語",
              ),
            ).toBe(false);
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
              quiz: [],
            };
          },
        },
        "preferthissource",
        chunks,
        {},
        "chat",
      );
      expect(generationCalls).toBe(1);
      expect(result.status).toBe("insufficient_data");
      expect(result.claims.some((claim) => claim.category === "purpose")).toBe(
        true,
      );
      expect(result).toMatchObject({
        sourceReading: {
          reason: "model_source_capacity",
          sections: [],
          unavailableSections: [
            {
              sourceSection: "警語",
              licenseNo: first.licenseNo,
              version: first.version,
            },
          ],
        },
      });
      expect(
        result.chunks.every((chunk) => chunk.licenseNo === other.licenseNo),
      ).toBe(true);
      expect(
        result.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
      ).toBeLessThanOrEqual(SOURCE_PAGE_CHAR_LIMIT);
    },
  );
});
