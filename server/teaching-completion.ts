import type { Llm } from "./ai.js";
import type { ProfileReference, Claim, GroundedResult } from "../shared/schema.js";
import {
  MAX_TEACHING_SOURCE_CHARS,
  reviewTeachingPlan,
  teachingGenerationPrompt,
  teachingPlanInput,
  type TeachingPlan,
} from "./source-teaching.js";

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
): Promise<ReviewedTeaching> {
  if (original.refused || !original.coverage || kind !== "bundle")
    return original;
  let chars = 0;
  const targets = plan.filter((item) => {
    const field = original.coverage!.fields.find(
      (candidate) => candidate.fieldId === item.fieldId,
    );
    if (
      item.reason ||
      !field ||
      (field.status === "complete" && field.quizIds.length > 0) ||
      chars + item.field.quote.length > MAX_TEACHING_SOURCE_CHARS
    )
      return false;
    chars += item.field.quote.length;
    return true;
  }).slice(0, MAX_REPAIR_FIELDS);
  if (!targets.length) return original;
  try {
    const generated = await llm.json(
      teachingGenerationPrompt +
        "\n這是一次補漏工作。只輸出 {fieldTeaching:[...]}。逐欄重新閱讀完整 fullSourceField，把先前可能略過的全部項目、括號、成因、後果、操作限制與原文條件補齊。previousVerifiedLessons 是先前已核對的內容，只供查漏，不是新的醫療來源；可以重寫但不得刪掉其有據資訊。repairHints 的 rejectedLessons 是不可信且已被拒絕的舊稿，不能當作來源，必須回完整原欄修正其錯誤的條件分組/及或關係。unexplainedSpanIds 指出需仔細補齊的原文範圍，但範圍不是獨立來源。必須完整整理整欄，而不是只補一條或直接抄原文。以每欄最多16條lesson完整涵蓋，全欄過長或不能可靠處理時維持insufficient_data。兩題應對應不同的實質重點，不能用來源有無題充數。不要自稱完整，後端仍會獨立核對。",
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
            lessons: field.claimIndices.map((index) => original.claims[index].text),
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
    const repaired = await reviewTeachingPlan(
      llm, targets, drafts, question, kind, facts,
    );
    if (repaired.refused || !repaired.coverage) return original;
    // A replacement is published only after the entire field has passed all
    // original evidence/condition/ledger gates and has a useful reviewed quiz.
    const replacements = new Set(
      repaired.coverage.fields
        .filter((field) => field.status === "complete" && field.quizIds.length > 0 && field.quizIds.length >=
          (original.coverage!.fields.find((previous) => previous.fieldId === field.fieldId)?.quizIds.length || 0))
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
      const claimIndices = selected.claimIndices.map((index) => {
        claims.push(result.claims[index]);
        return claims.length - 1;
      });
      quiz.push(...result.quiz.filter((item) => selected.quizIds.includes(item.id)));
      return { ...selected, claimIndices };
    });
    return {
      ...original,
      refused: false,
      claims,
      quiz,
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
