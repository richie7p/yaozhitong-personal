import type { GroundedResult } from "./schema.js";

/** Only readable, partially taught material can request a new explanation.
 * Source-review holds need source work, not repeated paid generation. */
export function needsTeachingCompletion(result: GroundedResult) {
  const progress=result.plainLanguageCoverage?.progressFromPrevious;
  if(progress && progress.additionalExplainedSpans===0 && progress.additionalQuiz===0) return false;
  const fields = result.plainLanguageCoverage?.fields;
  if (fields?.length && !fields.some((field) => field.continuationAvailable !== false &&
    (field.status === "partial" ||
    (field.status === "complete" && !field.quizIds.length && result.safetyCoverage?.status === "partial") ||
    (field.status === "unavailable" && (field.continuationAvailable === true ||
      (field.reason === "job_budget" && field.continuationAvailable === undefined) ||
      (field.reason !== "job_budget" && field.reason !== "source_not_interpretable"))))))
    return false;
  return !result.sourceReview &&
    (result.status === "supported" || result.status === "insufficient_data") &&
    (result.plainLanguageCoverage?.status === "partial" ||
      result.safetyCoverage?.status === "partial" ||
      (!result.plainLanguageCoverage && result.claims.some(
        (claim) => claim.kind === "source_exact_safety",
      )));
}
