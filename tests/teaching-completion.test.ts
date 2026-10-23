import { describe, expect, it } from "vitest";
import type { Chunk } from "../shared/schema";
import { sourcePassages, type Llm } from "../server/ai";
import {
  generalUseTeachingEligible,
  prepareTeachingPlan,
  reviewTeachingPlan,
  sourceQuantitativeBoundsPreserved,
  FieldTeachingDraftSchema,
  sourceActionResultOutdated,
  teachingQuizAvoidsDose,
  sourceCoverageLedger,
  sourceAbsenceExplicit,
  teachingPlanInput,
} from "../server/source-teaching";
import { completeTeachingPlan } from "../server/teaching-completion";
import { needsTeachingCompletion } from "../shared/teaching-completion";
import { purposeConditionsPreserved } from "../server/purpose-conditions";
import { warningConditionsPreserved } from "../shared/learning";

const page = (text: string, page = 1): Chunk => ({
  id: "SYNTHETIC-COMPLETION-" + page,
  licenseNo: "SYNTHETIC-COMPLETION",
  page, start: 0, text, sourceFormat: "pdf", version: "synthetic-v1",
});
const source = "【警語】請勿洗眼30秒以上。洗眼杯不可與他人共用。";
const plan = prepareTeachingPlan(sourcePassages([page(source)]));
const field = teachingPlanInput(plan)[0];
const draft = (complete = false) => ({
  fieldId: field.fieldId, status: "supported",
  lessons: [
    { text: "洗眼杯是供自己使用的器具，不可與他人共用。", spanIds: ["r0"] },
    ...(complete ? [{ text: "依警語，請勿洗眼30秒以上，這是原文明示的時間界線。", spanIds: ["r0"] }] : []),
  ],
  quiz: [{ q: "依警語，洗眼杯能否與他人共用？", options: ["不可共用", "可以共用"], answer: 0, lessonIndices: [0], spanIds: ["r0"] }],
});
const approve: Llm = { json: async (_s, input: any) => ({ verdicts: input.expectedIds.map((id: string) => ({id, supported: true})) }) };
async function original() {
  return reviewTeachingPlan({json: async (_s, input: any) => ({
    verdicts: input.expectedIds.map((id: string) => ({id, supported: !id.includes(":coverage") && !id.includes(":range-")})),
  })}, plan, [draft()], "警語", "bundle");
}

describe("bounded whole-field teaching completion", () => {
  it("repairs actual missing content only after a fresh full-field independent review", async () => {
    const before = await original(); let calls = 0;
    const completed = await completeTeachingPlan({json: async (system, input: any) => {
      calls++;
      if (input.expectedIds) return approve.json(system, input);
      expect(input.previousVerifiedLessons[0].lessons).toEqual([draft().lessons[0].text]);
      expect(input.teachingFields[0].fullSourceField).toBe(source);
      return {fieldTeaching: [draft(true)]};
    }}, plan, before, "警語", "bundle");
    expect(calls).toBe(2);
    expect(before.coverage!.status).toBe("partial");
    expect(before.claims).toHaveLength(1);
    expect(completed.coverage!.status).toBe("complete");
    expect(completed.claims).toHaveLength(2);
    expect(completed.quiz).toHaveLength(1);
  });
  it.each(["network", "malformed", "duplicate", "changed-bound", "review-rejected"])("keeps safe prior content and answers recoverable after %s", async (failure) => {
    const before = await original();
    const after = await completeTeachingPlan({json: async (system, input: any) => {
      if (failure === "network") throw new Error("offline");
      if (input.expectedIds) return failure === "review-rejected"
        ? {verdicts: input.expectedIds.map((id: string) => ({id, supported: false}))}
        : approve.json(system, input);
      const replacement = draft(true);
      if (failure === "changed-bound") replacement.lessons[1].text = "洗眼不要超過30秒，這是操作的時間限制。";
      return {fieldTeaching: failure === "malformed" ? [{...replacement, status: "complete"}] : failure === "duplicate" ? [replacement, replacement] : [replacement]};
    }}, plan, before, "警語", "bundle");
    expect(after).toBe(before);
    expect(after.claims).toEqual(before.claims);
    expect(after.quiz).toEqual(before.quiz);
    expect(after.coverage!.status).toBe("partial");
  });
  it("does not spend another model call on complete teaching or a chat answer", async () => {
    const complete = await reviewTeachingPlan(approve, plan, [draft(true)], "警語", "bundle");
    const never: Llm = {json: async () => {throw new Error("unexpected repair");}};
    expect(await completeTeachingPlan(never, plan, complete, "警語", "bundle")).toBe(complete);
    const partial = await original();
    expect(await completeTeachingPlan(never, plan, partial, "警語", "chat")).toBe(partial);
  });
  it("can add a genuinely reviewed quiz to complete white text without pretending its teaching was partial", async () => {
    const completeDraft = {...draft(true), quiz: []};
    const before = await reviewTeachingPlan(approve, plan, [completeDraft], "警語", "bundle");
    expect(before.coverage!.status).toBe("complete");
    expect(before.quiz).toEqual([]);
    let calls = 0;
    const after = await completeTeachingPlan({json: async (system, input: any) => {
      calls++;
      return input.expectedIds ? approve.json(system, input) : {fieldTeaching: [draft(true)]};
    }}, plan, before, "警語", "bundle");
    expect(calls).toBe(2);
    expect(after.coverage!.status).toBe("complete");
    expect(after.claims).toEqual(before.claims);
    expect(after.quiz).toHaveLength(1);
    expect(before.quiz).toEqual([]);
  });
  it.each([
    ["請勿洗眼30秒以上。", "請勿洗眼30秒以上。", true],
    ["洗眼不要超過30秒。", "請勿洗眼30秒以上。", false],
    ["不要洗眼30秒或更久。", "請勿洗眼30秒以上。", false],
    ["請存放於25℃以下。", "請存放於25℃以下。", true],
    ["請存放於25℃。", "請存放於25℃以下。", false],
    ["杯子不可共用。", "請勿洗眼30秒以上。", true],
    ["4,000毫克時需就醫。", "超過4,000毫克時需就醫。", false],
    ["超過4,000毫克時需就醫。", "超過4,000毫克時需就醫。", true],
    ["1,000毫升。", "至少1,000毫升。", false],
    ["至少1,000毫升。", "至少1,000毫升。", true],
  ])("preserves quantitative boundary: %s", (text, original, allowed) => {
    expect(sourceQuantitativeBoundsPreserved(text as string, [original as string])).toBe(allowed);
  });
  it("recognizes whole general handling fields across pages without treating pure dosage as education", () => {
    const fields = sourcePassages([
      page("【使用方法】\n洗眼杯先洗淨，使用過的液體"),
      page("不可再用於另一眼。請勿洗眼30秒以上。\n【諮詢專線】\n0800-000-000", 2),
    ]);
    const instructions = fields.find((item) => item.sourceSection === "使用方法")!;
    expect(instructions.quote).toContain("使用過的液體\n不可再用於另一眼");
    expect(instructions.citations).toHaveLength(2);
    expect(instructions.quote).not.toContain("0800");
    expect(generalUseTeachingEligible(instructions)).toBe(true);
    expect(generalUseTeachingEligible({sourceSection: "用法用量", quote: "一天3次，每次一錠。"})).toBe(false);
    expect(generalUseTeachingEligible({sourceSection: "用法用量", quote: "用前洗淨杯子，用後再洗淨。"})).toBe(true);
  });
  it("offers explicit completion only for readable partial material", () => {
    const base = {status: "supported" as const, claims: [], chunks: [], quiz: [], followups: [], rejectedCount: 0, sourceVersions: {}, verification: "model_assisted" as const};
    const partial = {...base, plainLanguageCoverage: {scope: "recognized_source_fields" as const, status: "partial" as const, fields: []}};
    expect(needsTeachingCompletion(partial)).toBe(true);
    expect(needsTeachingCompletion({...partial, sourceReview: {reason: "safety_sections_pending", sources: []}})).toBe(false);
    expect(needsTeachingCompletion({...partial, plainLanguageCoverage: {...partial.plainLanguageCoverage, status: "complete"}})).toBe(false);
    const unavailable = {fieldId: "synthetic-budget", licenseNo: "SYNTHETIC", sourceSection: "警語", sourceSpanCount: 4, explainedSpanCount: 0, status: "unavailable" as const, claimIndices: [], quizIds: [], reason: "job_budget" as const};
    expect(needsTeachingCompletion({...partial, plainLanguageCoverage: {...partial.plainLanguageCoverage, fields: [unavailable]}})).toBe(false);
    expect(needsTeachingCompletion({...partial, plainLanguageCoverage: {...partial.plainLanguageCoverage, fields: [{...unavailable, reason: "source_not_interpretable"}]}})).toBe(false);
    expect(needsTeachingCompletion({...partial, plainLanguageCoverage: {...partial.plainLanguageCoverage, fields: [{...unavailable, status: "partial", reason: "verification_incomplete"}]}})).toBe(true);
    expect(needsTeachingCompletion({...partial,
      plainLanguageCoverage: {...partial.plainLanguageCoverage, status: "complete", fields: [{...unavailable, status: "complete", reason: undefined}]},
      safetyCoverage: {scope: "recognized_source_sections", assessmentScope: "one_key_point_per_section", status: "partial", sourceSectionCount: 1, coveredSectionCount: 1, quizCoveredSectionCount: 0, sections: []},
    })).toBe(true);
  });
  it("normalizes only exact text-only option wrappers while retaining answer order and medical wording", () => {
    const wrapped = draft(true);
    const valid = FieldTeachingDraftSchema.parse({...wrapped, quiz: [{...wrapped.quiz[0], options: [{text: "不可共用"}, {text: "可以共用"}]}]});
    expect(valid.quiz[0].options).toEqual(["不可共用", "可以共用"]);
    expect(valid.quiz[0].answer).toBe(0);
    expect(FieldTeachingDraftSchema.safeParse({...wrapped, quiz: [{...wrapped.quiz[0], options: [{text: "不可共用", correct: true}, {text: "可以共用"}]}]}).success).toBe(false);
    expect(FieldTeachingDraftSchema.safeParse({...wrapped, quiz: [{...wrapped.quiz[0], options: [{label: "不可共用"}, {text: "可以共用"}]}]}).success).toBe(false);
  });
  it("selectively withholds an old changed quantitative boundary without expiring unchanged source reading", () => {
    const base = {status: "supported" as const, claims: [], chunks: [], quiz: [], followups: [], rejectedCount: 0, sourceVersions: {}, verification: "model_assisted" as const};
    const citation = {chunkId: "SYNTHETIC-TIME", quote: "請勿洗眼30秒以上。"};
    expect(sourceActionResultOutdated({...base, claims: [{text: "洗眼不要超過30秒。", citations: [citation]}]})).toBe(true);
    expect(sourceActionResultOutdated({...base, claims: [{text: "請勿洗眼30秒以上。", citations: [citation]}]})).toBe(false);
  });
  it("does not assess dosage or frequency while allowing source-grounded handling limits", () => {
    expect(teachingQuizAvoidsDose("依用法用量欄，使用前如何清洗洗眼杯？", ["先洗淨", "不用洗"])).toBe(true);
    expect(teachingQuizAvoidsDose("依使用方法欄，30秒以上的洗眼時間是否符合限制？", ["不符合", "符合"])).toBe(true);
    expect(teachingQuizAvoidsDose("每次使用多少毫升？", ["5mL", "10mL"])).toBe(false);
    expect(teachingQuizAvoidsDose("一天使用幾次？", ["3次", "6次"])).toBe(false);
    expect(teachingQuizAvoidsDose("哪一項用法符合？", ["每次5mL", "每次10mL"])).toBe(false);
  });
  it("does not count trailing formatting whitespace as an unexplained medical fact", () => {
    const original = sourcePassages([page("【警語】" + "原文合成內容請保持完整。".repeat(30) + "\n\t\n")])[0];
    const ledger = sourceCoverageLedger(original);
    expect(ledger.every((span) => span.text.trim().length > 0)).toBe(true);
    expect(ledger.map((span) => span.text).join("")).toBe(original.quote);
    expect(ledger.at(-1)!.end).toBe(original.quote.length);
    for (const span of ledger) expect(original.quote.slice(span.start, span.end)).toBe(span.text);
  });
  it.each([
    ["暫時緩解因眼睛乾澀所引起的灼熱感與刺激感", true],
    ["暫時緩解因眼睛乾澀所引起灼熱感與刺激感", true],
    ["暫時緩解因感染所引起的灼熱感與刺激感", false],
    ["暫時緩解所引起的灼熱感與刺激感", false],
    ["暫時緩解因眼睛乾澀所引起的灼熱感", false],
    ["暫時緩解因眼睛乾澀所引起的紅腫與刺激感", false],
  ])("allows only an unchanged complete purpose causal span with an inserted grammatical 的: %s", (text, valid) => {
    const quote = "用途(適應症)：暫時緩解因眼睛乾澀所引起灼熱感與刺激感";
    expect(purposeConditionsPreserved(text as string, [quote])).toBe(valid);
    if ((text as string).includes("所引起的")) expect(warningConditionsPreserved(text as string, [quote])).toBe(false);
  });
  it("never replaces original 之/的 or removes an independent age/exception condition", () => {
    expect(purposeConditionsPreserved("因合成病所引起的疼痛", ["因合成病所引起之疼痛"])).toBe(false);
    expect(purposeConditionsPreserved("因合成病所引起的疼痛", ["除非有醫師指示，因合成病所引起疼痛"])).toBe(false);
    expect(purposeConditionsPreserved("暫時緩解因合成病所引起的疼痛", ["用途(適應症)：僅限未滿12歲兒童，暫時緩解因合成病所引起疼痛"])).toBe(false);
    expect(purposeConditionsPreserved("僅限未滿12歲兒童，暫時緩解因合成病所引起的疼痛", ["用途(適應症)：僅限未滿12歲兒童，暫時緩解因合成病所引起疼痛"])).toBe(true);
  });
  it("rejects an invented claim that no other source instructions were listed", () => {
    expect(sourceAbsenceExplicit("仿單沒有在這裡另列其他保管方式。", ["為防止兒童誤食請妥善保管。避免陽光直射。"])).toBe(false);
    expect(sourceAbsenceExplicit("本欄未另列其他用法。", ["請依照藥品標示使用。"])) .toBe(false);
    expect(sourceAbsenceExplicit("為防止兒童誤食，請妥善保管並避免陽光直射。", ["為防止兒童誤食請妥善保管。避免陽光直射。"])).toBe(true);
  });
});
