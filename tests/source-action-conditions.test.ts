import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  prepareTeachingPlan,
  reviewTeachingPlan,
  sourceActionConditionsExplicit,
  sourceActionResultOutdated,
  SOURCE_TEACHING_VERSION,
  sourceInterpretationExplicit,
  sourceQuizInterpretationExplicit,
} from "../server/source-teaching.js";
import type { GroundedResult } from "../shared/schema.js";

const source = "本藥可能引起嗜睡，勿駕車或操作危險性機械。";

describe("recorded prohibitions do not acquire new symptom thresholds", () => {
  it("rejects the actual 028248 correct option while retaining its original full field and explanation", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/source-action-condition-028248.json", import.meta.url), "utf8"));
    expect(fixture.fullSourceField).toContain("可能引起嗜睡，勿駕車或操作危險性機械。");
    expect(sourceQuizInterpretationExplicit(fixture.question, fixture.options[fixture.answer], [fixture.fullSourceField])).toBe(false);
    expect(sourceInterpretationExplicit(fixture.correctExplanation, [fixture.fullSourceField])).toBe(true);
  });

  it("selectively retires a stored unsafe correct option, not complete originals or safe results", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/source-action-condition-028248.json", import.meta.url), "utf8"));
    const citation = { chunkId: "actual-source", quote: fixture.fullSourceField };
    const base: GroundedResult = {
      status: "supported", chunks: [], followups: [], rejectedCount: 0,
      sourceVersions: {}, verification: "model_assisted",
      claims: [{ text: fixture.fullSourceField.trim(), category: "warning", kind: "source_exact_safety", citations: [citation] }],
      quiz: [{ id: "actual-unsafe-question", q: fixture.question, options: fixture.options, answer: fixture.answer, explain: fixture.correctExplanation, citations: [citation] }],
    };
    expect(SOURCE_TEACHING_VERSION).toBe("source-teaching-v2-unconditional-actions");
    expect(sourceActionResultOutdated(base)).toBe(true);
    const safe = structuredClone(base);
    safe.quiz[0].options[0] = fixture.correctExplanation;
    expect(sourceActionResultOutdated(safe)).toBe(false);
    safe.quiz = [];
    expect(sourceActionResultOutdated(safe)).toBe(false);
    safe.claims.push({ text: fixture.options[0], category: "warning", kind: "source_plain_language", citations: [citation] });
    expect(sourceActionResultOutdated(safe)).toBe(true);
    expect(sourceActionResultOutdated(null)).toBe(false);
    expect(sourceActionResultOutdated(undefined)).toBe(false);
    expect(sourceActionResultOutdated({ deleted: true } as unknown as GroundedResult)).toBe(false);
  });
  it.each([
    "可能嗜睡時勿駕車或操作危險性機械。",
    "只有感到嗜睡時才勿駕車。",
    "如果感到嗜睡，請勿駕車。",
    "當出現嗜睡時不得駕車。",
    "頭暈時才不要操作危險性機械。",
    "嗜睡才不要駕車。",
    "頭暈時避免駕車。",
    "不得併服含酒精飲料，且可能嗜睡時勿駕車或操作危險性機械。",
    "使用時若嗜睡則勿駕車。",
    "服用時如果感到嗜睡，請勿駕車。",
    "使用時，出現嗜睡時勿駕車。",
    "只有出現嗜睡時，使用本藥才不要駕車。",
    "使用高劑量時勿駕車。",
    "嗜睡時，使用時勿駕車。",
    "頭暈時，服用時勿駕車。",
    "嗜睡時，正在使用本藥時請勿駕車。",
    "嗜睡時，使用時，服用時勿駕車。",
  ])("rejects a new gate in a lesson and correct answer: %s", (text) => {
    expect(sourceActionConditionsExplicit(text, [source])).toBe(false);
    expect(sourceInterpretationExplicit(text, [source])).toBe(false);
    expect(sourceQuizInterpretationExplicit("服用本藥期間應注意什麼？", text, [source])).toBe(false);
  });

  it.each([
    "本藥可能引起嗜睡，因此勿駕車或操作危險性機械。",
    "本藥可能引起嗜睡，請勿駕車。",
    "本藥可能引起嗜睡。所以不要駕車。",
    "服用本藥時勿駕車。",
    "正在使用本藥時請勿駕車。",
    "用藥期間請勿駕車或操作危險性機械。",
    "使用時勿駕車。",
    "服用時勿駕車。",
    "使用時，服用時勿駕車。",
    "本藥可能引起嗜睡，使用時勿駕車。",
  ])("retains risk explanations and ordinary treatment context: %s", (text) => {
    expect(sourceActionConditionsExplicit(text, [source])).toBe(true);
  });

  it.each([
    ["若感到嗜睡，請勿駕車。", "感到嗜睡時請勿駕車。"],
    ["出現嗜睡時，勿駕車。", "如果出現嗜睡，請勿駕車。"],
    ["有下列情形者，請勿使用本藥：曾因成分過敏。", "若曾因成分過敏，請勿使用本藥。"],
    ["本藥可能引起嗜睡，勿駕車；若出現噁心，勿飲酒。", "噁心時不要飲酒。"],
  ])("leaves explicit original conditions to whole-field scope checks", (quote, text) => {
    expect(sourceActionConditionsExplicit(text, [quote])).toBe(true);
  });

  it("does not infer a source action from a different action or missing evidence", () => {
    expect(sourceActionConditionsExplicit("發燒時請勿飲酒。", [source])).toBe(true);
    expect(sourceActionConditionsExplicit("發燒時請勿駕車。", [])).toBe(true);
  });

  it("retains the actual saved chat's bare treatment context without changing its source or text", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/source-action-context-saved-chat.json", import.meta.url), "utf8"));
    expect(fixture.text).toContain("使用時避免陽光直射");
    expect(sourceActionConditionsExplicit(fixture.text, fixture.citations.map((c: {quote: string}) => c.quote))).toBe(true);
    expect(sourceInterpretationExplicit(fixture.text, fixture.citations.map((c: {quote: string}) => c.quote))).toBe(true);
    expect(sourceActionResultOutdated({ claims: [fixture], quiz: [] } as unknown as GroundedResult)).toBe(false);
  });

  it("filters a newly gated lesson before a permissive model reviewer", async () => {
    const field = { licenseNo: "合成測試", chunkId: "c", quote: source, sourceSection: "警語" };
    const plan = prepareTeachingPlan([field]);
    let calls = 0;
    const result = await reviewTeachingPlan(
      { json: async () => { calls++; return { verdicts: [] }; } },
      plan,
      [{ fieldId: plan[0].fieldId, status: "supported", lessons: [{ text: "本藥可能嗜睡時勿駕車或操作危險性機械。", spanIds: ["r0"] }], quiz: [] }],
      "說明警語", "bundle",
    );
    expect(result.claims).toEqual([]);
    expect(result.quiz).toEqual([]);
    expect(result.coverage?.fields[0].status).toBe("unavailable");
    expect(calls).toBe(0);
  });
});
