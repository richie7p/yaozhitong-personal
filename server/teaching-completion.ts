import type { Llm } from "./ai.js";
import type { ProfileReference, Claim, GroundedResult } from "../shared/schema.js";
import {
  reviewTeachingPlan,
  teachingGenerationPrompt,
  teachingPlanInput,
  type TeachingPlan,
} from "./source-teaching.js";
import { prepareProgressiveTeaching, reviewProgressiveTeaching, teachingResultAsPrevious, MAX_TOTAL_TEACHING_LESSONS } from "./teaching-progress.js";

type ReviewedTeaching = Awaited<ReturnType<typeof reviewTeachingPlan>>;
const MAX_REPAIR_FIELDS = 2;

/** One bounded repair wave, with a fresh independent review. Existing safe
 * explanations stay available if the optional repair fails or remains partial.
 * Neither original quotations nor a generator's coverage assertion count as
 * completion. All requests share the original Llm's fixed job deadline. */
export async function completeTeachingPlan(
  llm: Llm,
  plan: TeachingPlan,
  original: ReviewedTeaching,
  question: string,
  kind: "bundle" | "chat",
  facts: ProfileReference[] = [],
  sourceVersions: Record<string,string> = {},
): Promise<ReviewedTeaching> {
  if (original.refused || !original.coverage || kind !== "bundle")
    return original;
  const versions = Object.fromEntries(plan.map((item) => [item.field.licenseNo,sourceVersions[item.field.licenseNo] || "same-current-job"]));
  const previous = teachingResultAsPrevious(original,versions);
  const progressive = prepareProgressiveTeaching(plan.map((item) => item.field),previous,versions);
  const targets = progressive.generationPlan.slice(0, MAX_REPAIR_FIELDS);
  if (!targets.length) return original;
  try {
    const generated = await llm.json(
      teachingGenerationPrompt +
        "\n這是同一job唯一一次有限分段補漏。只輸出 {fieldTeaching:[...]}。讀完整 fullSourceField保留父層條件，但這次只整理targetSpanIds原文範圍的全部實質內容；已核對解說會由後端另外合併重審，不重覆輸出或改寫它們。previousVerifiedLessons只供查漏，不是新的醫療來源。repairHints 的 rejectedLessons是不可信且被拒絕的舊稿，不能當作來源，必須回完整原欄修正其條件/及或關係。每欄本次最多16條，不夠可靠時保留有據部分並維持insufficient_data。題目對應本次新增內容的不同實質重點，不以來源有無題充數。整欄是否完整由後端對所有已教內容再做獨立核對。",
      {
        question,
        kind,
        profileFacts: facts,
        teachingFields: teachingPlanInput(targets),
        previousVerifiedLessons: targets.map((item) => {
          const field = original.coverage!.fields.find(
            (candidate) => candidate.fieldId === item.fieldId,
          )!;
          return {
            fieldId: item.fieldId,
            explainedSpanCount: field.explainedSpanCount,
            sourceSpanCount: field.sourceSpanCount,
            lessons: field.claimIndices.slice(0,16).map((index) => original.claims[index].text),
            quizCount: field.quizIds.length,
          };
        }),
        repairHints: original.repairHints.filter((hint) => targets.some((item) => item.fieldId === hint.fieldId)),
      },
    );
    const drafts =
      generated && typeof generated === "object" &&
      Array.isArray((generated as { fieldTeaching?: unknown }).fieldTeaching)
        ? (generated as { fieldTeaching: unknown[] }).fieldTeaching
        : [];
    const selectedPlan=progressive.plan.map((item)=>({...item,targetSpanIds:targets.some((target)=>target.fieldId===item.fieldId)?item.targetSpanIds:[]}));
    const repaired = await reviewProgressiveTeaching(
      llm, selectedPlan, progressive.prior, drafts, previous, question, kind, facts,
    );
    if (repaired.refused || !repaired.coverage) return original;
    // A source-safety denial or invalid changed-field review is authoritative
    // even when it removes a question or makes no progress. Only ordinary
    // improvements require non-regression; those checks cannot restore content
    // that this repair has just failed closed.
    const replacements = new Set(
      repaired.coverage.fields
        .filter((field) => {
          if (field.reason === "reverification_failed") return true;
          const old=original.coverage!.fields.find((old) => old.fieldId===field.fieldId)!;
          const retained=old.claimIndices.every((index) => field.claimIndices.some((fresh) => repaired.claims[fresh].text===original.claims[index].text));
          const rangesRetained=(old.explainedSpanIds || []).every((id) => field.explainedSpanIds?.includes(id));
          return retained && rangesRetained && field.quizIds.length >= old.quizIds.length &&
            (field.explainedSpanCount>old.explainedSpanCount || field.quizIds.length>old.quizIds.length ||
              (field.status==="complete" && old.status!=="complete"));
        })
        .map((field) => field.fieldId),
    );
    if (!replacements.size) return original;
    const claims: Claim[] = [];
    const quiz: GroundedResult["quiz"] = [];
    const fields = original.coverage.fields.map((field) => {
      const result = replacements.has(field.fieldId) ? repaired : original;
      const selected = result.coverage!.fields.find(
        (candidate) => candidate.fieldId === field.fieldId,
      )!;
      const indexMap = new Map<number,number>();
      const claimIndices = selected.claimIndices.map((index) => {
        claims.push(result.claims[index]);
        indexMap.set(index,claims.length-1);
        return claims.length - 1;
      });
      quiz.push(...result.quiz.filter((item) => selected.quizIds.includes(item.id)));
      return { ...selected, claimIndices,
        ...(selected.lessonSpans ? {lessonSpans:selected.lessonSpans.map((lesson) => ({...lesson,claimIndex:indexMap.get(lesson.claimIndex)!}))} : {}),
        continuationAvailable:selected.continuationAvailable && claims.length<MAX_TOTAL_TEACHING_LESSONS,
      };
    });
    const exhausted = claims.length >= MAX_TOTAL_TEACHING_LESSONS;
    if (exhausted) fields.forEach((field) => {field.continuationAvailable=false;});
    return {
      ...original,
      refused: false,
      claims,
      quiz,
      reviewProtocolComplete: original.reviewProtocolComplete && repaired.reviewProtocolComplete,
      repairHints: original.repairHints.filter((hint) => !replacements.has(hint.fieldId))
        .concat(repaired.repairHints.filter((hint) => replacements.has(hint.fieldId))),
      denialEvidence: original.denialEvidence.filter((denial) => !replacements.has(denial.fieldId))
        .concat(repaired.denialEvidence.filter((denial) => replacements.has(denial.fieldId))),
      completeFields: plan.filter((item) => fields.some(
        (field) => field.fieldId === item.fieldId && field.status === "complete",
      )).map((item) => item.field),
      coverage: {
        ...original.coverage,
        fields,
        status: fields.every((field) => field.status === "complete")
          ? "complete" : "partial",
      },
    };
  } catch {
    // Failed optional improvement cannot erase independently verified content.
    return original;
  }
}
