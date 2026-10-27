import { createHash } from "node:crypto";
import type { GroundedResult, ProfileReference } from "../shared/schema.js";
import type { Llm } from "./ai.js";
import { passageCitations } from "./source-field-spans.js";
import {
  FieldTeachingDraftSchema, MAX_ACCUMULATED_FIELD_LESSONS,
  MAX_TOTAL_TEACHING_LESSONS, MAX_TOTAL_LESSON_TEXT_CHARS,
  prepareTeachingPlan, reviewTeachingPlan, sourceInterpretationExplicit,
  sourceQuizInterpretationExplicit, type TeachingField, type TeachingPlan,
} from "./source-teaching.js";

/** Fixed generation, context, accumulation and persistence bounds. Full fields
 * remain the only medical source, even when a request targets a few ledger IDs. */
export const MAX_FIELD_CONTEXT_CHARS = 8000;
export const MAX_BATCH_CONTEXT_CHARS = 12000;
export const MAX_TARGET_CHARS = 4000;
export { MAX_TOTAL_TEACHING_LESSONS, MAX_TOTAL_LESSON_TEXT_CHARS } from "./source-teaching.js";
type Draft = ReturnType<typeof FieldTeachingDraftSchema.parse>;
export const sourceFieldSha = (field: TeachingField) =>
  createHash("sha256").update(field.quote).digest("hex");
const sameCitations = (left: GroundedResult["claims"][number]["citations"], right: typeof left) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Explicit ledgers compare identities, never only net counts: exchanging one
 * old range for two new ranges is two added and one lost. Legacy rows without
 * identities retain conservative count baselines and are labeled reorganized. */
export function teachingProgressDelta(
  fields: NonNullable<GroundedResult["plainLanguageCoverage"]>["fields"],
  previous: GroundedResult, versions:Record<string,string>,
) {
  const oldFields=previous.plainLanguageCoverage?.fields || [];
  const progress={additionalExplainedSpans:0,additionalQuiz:0,lostExplainedSpans:0,
    legacyReorganized:oldFields.some((field)=>field && !field.lessonSpans)};
  for(const field of fields) {
    const old=oldFields.find((old)=>old?.fieldId===field.fieldId && old.licenseNo===field.licenseNo);
    // Rephrasing or replacing a question is not additional assessment scope.
    progress.additionalQuiz+=Math.max(0,field.quizIds.length-(Array.isArray(old?.quizIds)?old.quizIds.length:0));
    const sameSource=old && !!field.sourceSha256 && old.sourceSha256===field.sourceSha256 &&
      !!versions[field.licenseNo] && previous.sourceVersions?.[field.licenseNo]===versions[field.licenseNo];
    const versionMismatch=old && !!versions[field.licenseNo] && !!previous.sourceVersions?.[field.licenseNo] &&
      previous.sourceVersions[field.licenseNo]!==versions[field.licenseNo];
    if(versionMismatch) {
      progress.additionalExplainedSpans+=Array.isArray(field.explainedSpanIds)?new Set(field.explainedSpanIds).size:field.explainedSpanCount;
      progress.lostExplainedSpans+=Array.isArray(old.explainedSpanIds)?new Set(old.explainedSpanIds).size:old.explainedSpanCount;
      progress.legacyReorganized=true;
    } else if(sameSource && Array.isArray(old.explainedSpanIds) && Array.isArray(field.explainedSpanIds)) {
      const before=new Set(old.explainedSpanIds),after=new Set(field.explainedSpanIds);
      progress.additionalExplainedSpans+=[...after].filter((id)=>!before.has(id)).length;
      progress.lostExplainedSpans+=[...before].filter((id)=>!after.has(id)).length;
    } else if(old?.sourceSha256 && Array.isArray(old.explainedSpanIds) && Array.isArray(field.explainedSpanIds)) {
      // Equal position labels on a different source binding are not retained
      // evidence, even if old and new counts happen to match.
      progress.additionalExplainedSpans+=new Set(field.explainedSpanIds).size;
      progress.lostExplainedSpans+=new Set(old.explainedSpanIds).size;
      progress.legacyReorganized=true;
    } else {
      if(old)progress.legacyReorganized=true;
      const oldCount=old?.status==="complete" && !old.lessonSpans ? field.sourceSpanCount :
        old && Number.isInteger(old.explainedSpanCount) && old.explainedSpanCount>=0 ? Math.min(old.explainedSpanCount,field.sourceSpanCount) : 0;
      progress.additionalExplainedSpans+=Math.max(0,field.explainedSpanCount-oldCount);
      progress.lostExplainedSpans+=Math.max(0,oldCount-field.explainedSpanCount);
    }
  }
  for(const old of oldFields) if(old && !fields.some((field)=>field.fieldId===old.fieldId && field.licenseNo===old.licenseNo))
    progress.lostExplainedSpans+=Array.isArray(old.explainedSpanIds)?new Set(old.explainedSpanIds).size:
      Number.isInteger(old.explainedSpanCount)&&old.explainedSpanCount>0?old.explainedSpanCount:0;
  return progress;
}

/** Historical counts are insufficient to resume. Only exact source bytes,
 * versions, citations and explicit lesson/range associations can be drafted
 * again. Changed fields receive a fresh full-field review; unchanged fields
 * retain prior approval only after current deterministic source checks. */
export function previousTeachingDrafts(
  plan: TeachingPlan,
  previous: GroundedResult | undefined,
  versions: Record<string, string>,
) {
  const drafts = new Map<string, Draft>();
  if (!previous || previous.sourceReview || !Array.isArray(previous.claims) ||
      !Array.isArray(previous.quiz) || !Array.isArray(previous.plainLanguageCoverage?.fields) ||
      !["supported", "insufficient_data"].includes(previous.status)) return drafts;
  let total = 0;
  let textChars = 0;
  for (const item of plan) {
    const field = previous.plainLanguageCoverage.fields.find((f) => f?.fieldId === item.fieldId);
    if (!field || field.licenseNo!==item.field.licenseNo || field.sourceSection!==item.field.sourceSection ||
        !["complete","partial","unavailable"].includes(field.status) || field.sourceSha256 !== sourceFieldSha(item.field) ||
        !versions[item.field.licenseNo] || previous.sourceVersions?.[item.field.licenseNo] !== versions[item.field.licenseNo] ||
        !Array.isArray(field.lessonSpans) || !Array.isArray(field.explainedSpanIds) || !Array.isArray(field.claimIndices) || !Array.isArray(field.quizIds) ||
        field.lessonSpans.some((span)=>!span || !Number.isInteger(span.claimIndex) || !Array.isArray(span.spanIds) || span.spanIds.some((id)=>typeof id!=="string")) ||
        field.sourceSpanCount !== item.ledger.length || field.explainedSpanCount !== field.explainedSpanIds.length ||
        (field.status === "complete" && field.explainedSpanIds.length !== item.ledger.length) ||
        field.lessonSpans.length !== field.claimIndices.length ||
        field.claimIndices.length > MAX_ACCUMULATED_FIELD_LESSONS ||
        total + field.claimIndices.length > MAX_TOTAL_TEACHING_LESSONS ||
        new Set(field.claimIndices).size !== field.claimIndices.length ||
        new Set(field.explainedSpanIds).size !== field.explainedSpanIds.length ||
        field.explainedSpanIds.some((id) => !item.ledger.some((span) => span.id === id))) continue;
    const lessons: Draft["lessons"] = [];
    let valid = true;
    for (const index of field.claimIndices) {
      const claim = previous.claims[index];
      const spans = field.lessonSpans.filter((s) => s.claimIndex === index);
      if (!claim || typeof claim.text!=="string" || !claim.text.length || claim.text.length>1500 || claim.kind !== "source_plain_language" || spans.length !== 1 ||
          !spans[0].spanIds.length || new Set(spans[0].spanIds).size !== spans[0].spanIds.length ||
          spans[0].spanIds.some((id) => !item.ledger.some((span) => span.id === id)) ||
          !sameCitations(claim.citations, passageCitations(item.field)) ||
          !sourceInterpretationExplicit(claim.text, [item.field.quote])) { valid = false; break; }
      lessons.push({text:claim.text,spanIds:[...spans[0].spanIds],profileRefs:claim.profileRefs || []});
    }
    if (!valid || !lessons.length || textChars + lessons.reduce((n,l) => n+l.text.length,0) > MAX_TOTAL_LESSON_TEXT_CHARS) continue;
    const quiz: Draft["quiz"] = [];
    for (const id of field.quizIds) {
      const q = previous.quiz.find((q) => q?.id === id);
      if (!q || typeof q.q!=="string" || typeof q.explain!=="string" || !Array.isArray(q.options) || q.options.length !== 2 || ![0,1].includes(q.answer) ||
          !sameCitations(q.citations, passageCitations(item.field)) ||
          !sourceQuizInterpretationExplicit(q.q,q.options[q.answer],[item.field.quote])) continue;
      const indices:number[]=[];let remainder=q.explain;
      for(const [index,lesson] of lessons.entries()) {
        if(remainder===lesson.text) {indices.push(index);remainder="";break;}
        if(remainder.startsWith(lesson.text+"\n\n")) {indices.push(index);remainder=remainder.slice(lesson.text.length+2);}
      }
      if (!indices.length || remainder || indices.map((index) => lessons[index].text).join("\n\n") !== q.explain) continue;
      quiz.push({q:q.q,options:[...q.options],answer:q.answer,lessonIndices:indices,
        spanIds:[...new Set(indices.flatMap((index) => lessons[index].spanIds))]});
    }
    drafts.set(item.fieldId,{fieldId:item.fieldId,status:"supported",lessons,quiz:quiz.slice(0,2)});
    total += lessons.length;
    textChars += lessons.reduce((n,l) => n+l.text.length,0);
  }
  return drafts;
}

export function prepareProgressiveTeaching(
  fields: TeachingField[], previous: GroundedResult | undefined,
  versions: Record<string,string>,
) {
  const baseline = prepareTeachingPlan(fields);
  const prior = previousTeachingDrafts(baseline,previous,versions);
  let contextChars = 0, targetChars = 0, count = 0;
  const priorLessons = [...prior.values()].reduce((n,d) => n+d.lessons.length,0);
  const priorTextChars = [...prior.values()].reduce((n,d) => n+d.lessons.reduce((m,l)=>m+l.text.length,0),0);
  const legacyPriority=(item:TeachingPlan[number])=>{
    const old=Array.isArray(previous?.plainLanguageCoverage?.fields) ? previous.plainLanguageCoverage.fields.find((f)=>f?.fieldId===item.fieldId && f.licenseNo===item.field.licenseNo) : undefined;
    return !prior.has(item.fieldId) && old?.status==="complete" && previous?.sourceVersions?.[item.field.licenseNo]===versions[item.field.licenseNo] ? 1 : 0;
  };
  const selected = [...baseline].sort((a,b)=>legacyPriority(a)-legacyPriority(b)).map((item) => {
    const eligible = item.reason !== "source_not_interpretable" && item.field.quote.length <= MAX_FIELD_CONTEXT_CHARS;
    const old = prior.get(item.fieldId);
    const oldField = Array.isArray(previous?.plainLanguageCoverage?.fields) ? previous.plainLanguageCoverage.fields.find((f) => f?.fieldId === item.fieldId) : undefined;
    const remaining = item.ledger.filter((span) => !old || !oldField?.explainedSpanIds?.includes(span.id));
    const needsQuiz = !!old && old.quiz.length === 0;
    const capacity = priorLessons < MAX_TOTAL_TEACHING_LESSONS && priorTextChars<MAX_TOTAL_LESSON_TEXT_CHARS && (!old || old.lessons.length < MAX_ACCUMULATED_FIELD_LESSONS);
    const targets: string[] = [];
    if (eligible && capacity && count < 4 && contextChars + item.field.quote.length <= MAX_BATCH_CONTEXT_CHARS) {
      for (const span of remaining.length ? remaining : needsQuiz ? item.ledger : []) {
        if (targetChars + span.text.length > MAX_TARGET_CHARS) break;
        targets.push(span.id);targetChars += span.text.length;
        if (targets.reduce((n,id) => n+item.ledger.find((s) => s.id===id)!.text.length,0) >= 2000) break;
      }
      if (targets.length) {count++;contextChars += item.field.quote.length;}
    }
    return {...item,
      reason: eligible && (old || targets.length) ? undefined : item.reason === "source_not_interpretable" ? item.reason : "job_budget" as const,
      targetSpanIds: targets,
      continuationAvailable: eligible && capacity,
    };
  });
  const plan=baseline.map((item)=>selected.find((selected)=>selected.fieldId===item.fieldId)!);
  return {plan,prior,generationPlan:plan.filter((item) => !item.reason && item.targetSpanIds.length)};
}

/** Merge only bounded, schema-valid new drafts with source-bound server drafts.
 * Index remapping is mechanical; no medical text or question is manufactured. */
export function mergeTeachingDrafts(plan: TeachingPlan, prior: Map<string,Draft>, raw: unknown[]) {
  const output: Draft[] = [];
  let total = 0;
  let textChars = 0;
  const retained=[...prior.values()].filter((draft)=>plan.some((item)=>!item.reason && item.fieldId===draft.fieldId));
  let remainingNewLessons=MAX_TOTAL_TEACHING_LESSONS-retained.reduce((n,draft)=>n+draft.lessons.length,0);
  let remainingNewText=MAX_TOTAL_LESSON_TEXT_CHARS-retained.reduce((n,draft)=>n+draft.lessons.reduce((m,lesson)=>m+lesson.text.length,0),0);
  for (const item of plan) {
    if (item.reason) continue;
    const old = prior.get(item.fieldId);
    const candidates = raw.filter((d) => d && typeof d === "object" && (d as {fieldId?:unknown}).fieldId === item.fieldId);
    const parsed = candidates.length === 1 ? FieldTeachingDraftSchema.safeParse(candidates[0]) : undefined;
    const fresh = parsed?.success ? parsed.data : undefined;
    if (fresh?.status === "refused") {output.push(fresh);continue;}
    if (!old && !fresh) continue;
    const lessons = old ? old.lessons.map((l) => ({...l,spanIds:[...l.spanIds]})) : [];
    const remap = new Map<number,number>();
    for (const [index,lesson] of (fresh?.lessons || []).entries()) {
      const existing = lessons.findIndex((l) => l.text === lesson.text && JSON.stringify(l.spanIds) === JSON.stringify(lesson.spanIds));
      if (existing >= 0) {remap.set(index,existing);continue;}
      if (lessons.length >= MAX_ACCUMULATED_FIELD_LESSONS || remainingNewLessons<=0 || remainingNewText<lesson.text.length) break;
      remap.set(index,lessons.length);lessons.push(lesson);
      remainingNewLessons--;remainingNewText-=lesson.text.length;
    }
    const quiz = old ? old.quiz.map((q) => ({...q})) : [];
    for (const q of fresh?.quiz || []) {
      if (quiz.length >= 2 || q.lessonIndices.some((i) => !remap.has(i)) || quiz.some((old) => old.q === q.q)) continue;
      quiz.push({...q,lessonIndices:q.lessonIndices.map((i) => remap.get(i)!)});
    }
    total += lessons.length;
    textChars += lessons.reduce((n,l) => n+l.text.length,0);
    output.push({fieldId:item.fieldId,status:fresh?.status || old!.status,lessons,quiz});
  }
  return output;
}

/** A fresh reviewer sees only changed fields, each in its entirety, within the
 * same12k source-context batch. Unchanged fields can retain prior approval only
 * after exact server-owned provenance and all current deterministic gates have
 * passed. This is explicit carry, never a claim of a new model review. */
export async function reviewProgressiveTeaching(
  llm:Llm, plan:TeachingPlan, prior:Map<string,Draft>, raw:unknown[],
  previous:GroundedResult|undefined, question:string, kind:"bundle"|"chat",
  facts:ProfileReference[]=[],
) {
  const merged=mergeTeachingDrafts(plan,prior,raw);
  const targets=plan.filter((item)=>!item.reason && item.targetSpanIds?.length);
  if(targets.reduce((n,item)=>n+item.field.quote.length,0)>MAX_BATCH_CONTEXT_CHARS)
    throw Error("bounded_teaching_review_context_exceeded");
  const fresh=await reviewTeachingPlan(llm,targets,
    merged.filter((draft)=>targets.some((item)=>item.fieldId===draft.fieldId)),
    question,kind,facts,{mergedServerDrafts:true});
  if(fresh.refused) return fresh;
  const empty=await reviewTeachingPlan({json:async()=>{throw Error("deferred_field_must_not_call_provider");}},
    plan.map((item)=>({...item,reason:item.reason || "job_budget" as const})),[],question,kind,facts);
  const claims:GroundedResult["claims"]=[],quiz:GroundedResult["quiz"]=[];
  const fields=plan.map((item)=>{
    let reviewed=fresh.coverage?.fields.find((field)=>field.fieldId===item.fieldId);
    const old=prior.get(item.fieldId);
    const oldField=old && Array.isArray(previous?.plainLanguageCoverage?.fields) ? previous.plainLanguageCoverage.fields.find((field)=>field?.fieldId===item.fieldId) : undefined;
    let retainedAfterRecheck=false,sourceRecheckFailed=false;
    if(reviewed && old && oldField && previous) {
      const spanKey=(ids:string[])=>JSON.stringify([...ids].sort());
      const lostClaims=oldField.claimIndices.map((index)=>previous.claims[index])
        .filter((claim)=>{
          const oldIndex=oldField.claimIndices.find((index)=>previous.claims[index]===claim)!;
          const oldSpans=oldField.lessonSpans!.find((lesson)=>lesson.claimIndex===oldIndex)!.spanIds;
          return !reviewed!.claimIndices.some((index)=>fresh.claims[index].text===claim.text && sameCitations(fresh.claims[index].citations,claim.citations) &&
            spanKey(reviewed!.lessonSpans?.find((lesson)=>lesson.claimIndex===index)?.spanIds || [])===spanKey(oldSpans));
        });
      const lostRanges=(oldField.explainedSpanIds || []).filter((id)=>!reviewed!.explainedSpanIds?.includes(id));
      const currentQuiz=fresh.quiz.filter((q)=>reviewed!.quizIds.includes(q.id));
      const lostQuiz=previous.quiz.filter((q)=>oldField.quizIds.includes(q.id) && old.quiz.some((candidate)=>candidate.q===q.q))
        .filter((q)=>!currentQuiz.some((current)=>current.q===q.q && current.answer===q.answer && current.explain===q.explain && JSON.stringify(current.options)===JSON.stringify(q.options) && sameCitations(current.citations,q.citations)));
      if(lostClaims.length || lostRanges.length || lostQuiz.length) {
        const hint=fresh.repairHints.find((hint)=>hint.fieldId===item.fieldId);
        const evidence=fresh.denialEvidence.filter((denial)=>denial.fieldId===item.fieldId);
        // Any matching old statement's safety denial is conservative evidence,
        // even if an identical text with another range association survived.
        const unsafeOldDenial=evidence.some((denial)=>denial.kind==="lesson"
          ? oldField.claimIndices.some((index)=>previous.claims[index].text===denial.text) && denial.reason!=="not_plain_language"
          : denial.kind==="quiz" ? previous.quiz.some((q)=>oldField.quizIds.includes(q.id)&&q.q===denial.text) && denial.reason!=="not_plain_language"
          : oldField.explainedSpanIds!.includes(denial.rangeId!) && denial.reason!=="coverage_gap");
        const cosmeticClaims=lostClaims.every((claim)=>hint?.rejectedLessons.some((rejected)=>rejected.text===claim.text && rejected.reason==="not_plain_language"));
        const cosmeticQuiz=lostQuiz.every((q)=>hint?.rejectedQuiz.some((rejected)=>rejected.q===q.q &&
          (rejected.reason==="not_plain_language" || (rejected.reason==="linked_lesson_rejected" && lostClaims.length>0 && cosmeticClaims && lostClaims.some((claim)=>q.explain.includes(claim.text))))));
        // A changed field's invalid protocol always fails closed. Only a
        // complete identified review proving a readability-only denial or an
        // explicit coverage gap may preserve the previous source-bound field.
        const coverageOnly=lostRanges.every((id)=>evidence.some((denial)=>denial.kind==="range" && denial.rangeId===id && denial.reason==="coverage_gap"));
        if(fresh.reviewProtocolComplete && !unsafeOldDenial && cosmeticClaims && cosmeticQuiz && coverageOnly) {
          reviewed=undefined;
          retainedAfterRecheck=true;
        } else {
          sourceRecheckFailed=true;
        }
      }
    }
    const field=structuredClone(reviewed || (old && oldField ? oldField : empty.coverage!.fields.find((field)=>field.fieldId===item.fieldId)!));
    if(reviewed) {
      const remap=new Map<number,number>();
      field.claimIndices=reviewed.claimIndices.map((index)=>{remap.set(index,claims.length);claims.push(fresh.claims[index]);return claims.length-1;});
      field.lessonSpans=reviewed.lessonSpans?.map((lesson)=>({...lesson,claimIndex:remap.get(lesson.claimIndex)!}));
      quiz.push(...fresh.quiz.filter((q)=>field.quizIds.includes(q.id)));
      field.verificationMode="current_model_review";
    } else if(old && oldField && previous) {
      const remap=new Map<number,number>();
      field.claimIndices=oldField.claimIndices.map((index)=>{remap.set(index,claims.length);claims.push(structuredClone(previous.claims[index]));return claims.length-1;});
      field.lessonSpans=oldField.lessonSpans!.map((lesson)=>({...lesson,claimIndex:remap.get(lesson.claimIndex)!}));
      const retained=previous.quiz.filter((q)=>oldField.quizIds.includes(q.id) && old.quiz.some((draft)=>draft.q===q.q && draft.answer===q.answer && JSON.stringify(draft.options)===JSON.stringify(q.options)));
      field.quizIds=retained.map((q)=>q.id);quiz.push(...retained.map((q)=>structuredClone(q)));
      field.verificationMode="source_bound_carry";
    }
    if(retainedAfterRecheck) field.retainedAfterRecheck=true;
    if(sourceRecheckFailed) {
      field.reason="reverification_failed";
      field.status=field.claimIndices.length?"partial":"unavailable";
    }
    field.continuationAvailable=item.continuationAvailable && !sourceRecheckFailed;
    return field;
  });
  const capacity=claims.length<MAX_TOTAL_TEACHING_LESSONS && claims.reduce((n,claim)=>n+claim.text.length,0)<MAX_TOTAL_LESSON_TEXT_CHARS;
  for(const field of fields)field.continuationAvailable=!!field.continuationAvailable && capacity && field.claimIndices.length<MAX_ACCUMULATED_FIELD_LESSONS;
  return {refused:false,claims,quiz,
    completeFields:plan.filter((item)=>fields.some((field)=>field.fieldId===item.fieldId && field.status==="complete")).map((item)=>item.field),
    coverage:{scope:"recognized_source_fields" as const,status:!fields.length?"no_fields" as const:fields.every((field)=>field.status==="complete")?"complete" as const:"partial" as const,fields},
    repairHints:fresh.repairHints,reviewProtocolComplete:fresh.reviewProtocolComplete,denialEvidence:fresh.denialEvidence};
}

/** This operation's already-reviewed safe result becomes the draft for its
 * optional second wave, using the same exact mapping rules as another job. */
export function teachingResultAsPrevious(result: {
  claims: GroundedResult["claims"]; quiz: GroundedResult["quiz"];
  coverage?: GroundedResult["plainLanguageCoverage"];
}, versions: Record<string,string>): GroundedResult {
  return {status:"supported",claims:result.claims,quiz:result.quiz,chunks:[],followups:[],
    rejectedCount:0,sourceVersions:versions,verification:"model_assisted",plainLanguageCoverage:result.coverage};
}
