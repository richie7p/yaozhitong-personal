import { describe, expect, it } from "vitest";
import malformed from "./fixtures/legacy-quiz-missing-answer-028248.json";
import rateFailure from "./fixtures/quantitative-rate-assertion-031505.json";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import { prepareProgressiveTeaching, reviewProgressiveTeaching, sourceFieldSha, teachingProgressDelta } from "../server/teaching-progress";
import { prepareTeachingPlan, sourceCoverageLedger, sourceInterpretationExplicit, sourceQuantitativeBoundsPreserved, sourceQuantitativeRatesPreserved, sourceActionResultOutdated, teachingPlanInput } from "../server/source-teaching";
import { passageCitations } from "../server/source-field-spans";
import { needsTeachingCompletion } from "../shared/teaching-completion";
import type { Chunk, GroundedResult } from "../shared/schema";

const approve=(input:any)=>({verdicts:input.expectedIds.map((id:string)=>({id,supported:true}))});
function frozenGeneration(output:unknown) {
  const calls:any[]=[];
  const llm:Llm={json:async(_system,input:any)=>{calls.push(input);return input.expectedIds?approve(input):input.sources?structuredClone(output):{fieldTeaching:[]};}};
  return {llm,calls};
}

describe("individual legacy quiz format isolation",()=>{
  it("replays the actual missing-answer output without discarding supported teaching or widening fresh16",async()=>{
    expect(malformed.modelOutput.quiz[0]).not.toHaveProperty("answer");
    expect(malformed.modelOutput.fieldTeaching[1].lessons).toHaveLength(17);
    const {llm,calls}=frozenGeneration(malformed.modelOutput);
    const result=await grounded(llm,"請完整整理仿單白話說明、一般操作注意事項、警語與理解測驗，不提供個人用量建議。",malformed.chunks as Chunk[],{},"bundle");
    expect(result.claims.some((c)=>c.category==="purpose")).toBe(true);
    expect(result.claims.some((c)=>c.kind==="source_plain_language")).toBe(true);
    expect(result.quiz.some((q)=>q.q===malformed.modelOutput.quiz[0].q)).toBe(false);
    expect(result.rejectedCount).toBeGreaterThanOrEqual(1);
    expect(result.plainLanguageCoverage?.status).toBe("partial");
    expect(result.plainLanguageCoverage?.fields.find((f)=>f.sourceSection==="警語")?.status).not.toBe("complete");
    expect(needsTeachingCompletion(result)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
  });
  it.each(["missing-answer","invalid-options","unknown-source"])("rejects only the %s question and retains its independently reviewed valid sibling",async(failure)=>{
    const raw:any=structuredClone(malformed.modelOutput);
    const valid={...raw.quiz[0],q:raw.quiz[0].q+"請選一項。",answer:0};
    const invalid={...valid,q:"這一題格式故障，不能猜答案。"};
    if(failure==="missing-answer")delete invalid.answer;
    if(failure==="invalid-options")invalid.options=["只有一項"];
    if(failure==="unknown-source")invalid.citations=[{sourceId:"not-a-provided-source"}];
    raw.quiz=[invalid,valid];
    const result=await grounded(frozenGeneration(raw).llm,"整理仿單",malformed.chunks as Chunk[],{},"bundle");
    expect(result.quiz.some((q)=>q.q===invalid.q)).toBe(false);
    expect(result.quiz.some((q)=>q.q===valid.q)).toBe(true);
    expect(result.claims.some((c)=>c.kind==="source_plain_language")).toBe(true);
    expect(result.rejectedCount).toBeGreaterThanOrEqual(1);
  });
  it("keeps malformed claim citations strict instead of silently accepting the entire response",async()=>{
    const raw:any=structuredClone(malformed.modelOutput);raw.claims[0].citations=[{sourceId:"not-a-provided-source"}];
    await expect(grounded(frozenGeneration(raw).llm,"整理仿單",malformed.chunks as Chunk[],{},"bundle")).rejects.toMatchObject({code:"invalid_ai_output"});
  });
});

const sentence="這份合成資料僅供軟體流程測試，不可作為實際醫療資訊。";
const chunks:Chunk[]=[{id:"RECHECK-SYNTHETIC",licenseNo:"RECHECK-SYNTHETIC",version:"v1",sourceFormat:"html",page:1,start:0,text:"【警語】\n"+sentence.repeat(190)}];
const field=sourcePassages(chunks)[0],plan=prepareTeachingPlan([field]),ledger=sourceCoverageLedger(field);
const oldText="這份合成資料只用於軟體流程的測試，不能拿來當作實際醫療資訊。";
const newText="這份資料的用途是測試軟體流程，無法當成實際的醫療資訊。";
const versions={"RECHECK-SYNTHETIC":"v1"};
function previous(withQuiz=false):GroundedResult {
  const quiz=withQuiz?[{id:"old-question",q:"依警語，這份合成資料可以作為實際醫療資訊嗎？",options:["不可以，只供軟體流程測試","可以作為實際醫療資訊"],answer:0,explain:oldText,citations:passageCitations(field),explanationKind:"verified_plain_language" as const}]:[];
  return {status:"supported",claims:[{text:oldText,kind:"source_plain_language",category:"warning",citations:passageCitations(field)}],quiz,chunks,followups:[],rejectedCount:0,sourceVersions:versions,verification:"model_assisted",
    plainLanguageCoverage:{scope:"recognized_source_fields",status:"partial",fields:[{fieldId:plan[0].fieldId,licenseNo:field.licenseNo,sourceSection:"警語",sourceSpanCount:ledger.length,explainedSpanCount:1,status:"partial",claimIndices:[0],quizIds:quiz.map(q=>q.id),sourceSha256:sourceFieldSha(field),explainedSpanIds:["r0"],lessonSpans:[{claimIndex:0,spanIds:["r0"]}],continuationAvailable:true,verificationMode:"current_model_review"}]}};
}
async function recheck(reason:string|undefined,options:{quiz?:boolean;rangeOnly?:boolean;malformedReview?:boolean;incompleteSafetyDenial?:boolean;malformedSibling?:boolean;invalidReason?:boolean}={}) {
  const before=previous(options.quiz),prepared=prepareProgressiveTeaching([field],before,versions);
  const llm:Llm={json:async(_system,input:any)=>options.malformedReview?{verdicts:[]}:options.incompleteSafetyDenial?
    {verdicts:[{id:input.checks.find((check:any)=>check.checkType==="lesson"&&check.text===oldText).id,supported:false,reason:"unsupported"}]}:{verdicts:input.expectedIds.map((id:string)=>{
    const check=input.checks.find((c:any)=>c.id===id);
    if(!options.rangeOnly && !options.quiz && check.checkType==="coverage_range" && check.rangeId==="r0")return {id,supported:false,...(reason?{reason:reason==="not_plain_language"?"coverage_gap":reason}:{})};
    const denied=options.rangeOnly?check.checkType==="coverage_range"&&check.rangeId==="r0":options.quiz?check.checkType==="quiz":check.checkType==="lesson"&&check.text===oldText;
    return {id,supported:!denied,...(denied&&reason?{reason:options.invalidReason?{invalid:"reason"}:reason}:{})};
  }).concat(options.malformedSibling?[{id:"malformed-sibling",supported:"invalid"}]:[])}};
  const result=await reviewProgressiveTeaching(llm,prepared.plan,prepared.prior,[{fieldId:plan[0].fieldId,status:"supported",lessons:[{text:newText,spanIds:["r1"]}],quiz:[]}],before,"整理警語","bundle");
  return {before,result};
}
describe("source-bound main-wave non-regression",()=>{
  it.each(["not_plain_language","coverage_gap"])("retains safe previous content only after a complete review proves a cosmetic/range %s failure",async(reason)=>{
    const {before,result}=await recheck(reason,{rangeOnly:reason==="coverage_gap"});
    expect(result.claims.map(c=>c.text)).toEqual([oldText]);
    expect(result.coverage?.fields[0]).toMatchObject({explainedSpanIds:["r0"],verificationMode:"source_bound_carry",retainedAfterRecheck:true});
    expect(teachingProgressDelta(result.coverage!.fields,before,versions)).toMatchObject({additionalExplainedSpans:0,lostExplainedSpans:0});
    expect(before.claims[0].text).toBe(oldText);
  });
  it.each(["empty","malformed-sibling","invalid-reason"])("fails closed for a changed-field %s protocol instead of using format carry",async(failure)=>{
    const {result}=await recheck("unsupported",{malformedReview:failure==="empty",malformedSibling:failure==="malformed-sibling",invalidReason:failure==="invalid-reason"});
    expect(result.reviewProtocolComplete).toBe(false);
    expect(result.claims).toHaveLength(0);
    expect(result.coverage?.fields[0]).toMatchObject({reason:"reverification_failed",continuationAvailable:false});
    expect(result.coverage?.fields[0].retainedAfterRecheck).not.toBe(true);
  });
  it.each(["unsupported","scope","condition","negation","contradiction",undefined])("never hides a fresh old-claim safety denial (%s) by carrying previous approval",async(reason)=>{
    const {before,result}=await recheck(reason);
    expect(result.claims.some(c=>c.text===oldText)).toBe(false);
    expect(result.coverage?.fields[0]).toMatchObject({reason:"reverification_failed",continuationAvailable:false,verificationMode:"current_model_review"});
    expect(result.coverage?.fields[0].retainedAfterRecheck).not.toBe(true);
    expect(teachingProgressDelta(result.coverage!.fields,before,versions).lostExplainedSpans).toBe(1);
    expect(before.claims[0].text).toBe(oldText);
  });
  it("fails closed for an old quiz ambiguity while retaining independently safe statements",async()=>{
    const {before,result}=await recheck("ambiguous_quiz",{quiz:true});
    expect(result.quiz).toHaveLength(0);
    expect(result.coverage?.fields[0]).toMatchObject({reason:"reverification_failed",continuationAvailable:false});
    expect(result.claims.some(c=>c.text===oldText)).toBe(true);
    expect(before.quiz).toHaveLength(1);
  });
  it.each(["scope","unsupported",undefined])("never treats a range-only safety or unknown denial (%s) as a cosmetic gap",async(reason)=>{
    const {result}=await recheck(reason,{rangeOnly:true});
    expect(result.coverage?.fields[0]).toMatchObject({reason:"reverification_failed",verificationMode:"current_model_review",continuationAvailable:false});
    expect(result.coverage?.fields[0].retainedAfterRecheck).not.toBe(true);
    expect(result.coverage?.fields[0].explainedSpanIds).not.toContain("r0");
  });
  it("does not hide an explicit old-claim safety denial inside an incomplete review protocol",async()=>{
    const {result}=await recheck(undefined,{incompleteSafetyDenial:true});
    expect(result.reviewProtocolComplete).toBe(false);
    expect(result.claims).toHaveLength(0);
    expect(result.coverage?.fields[0]).toMatchObject({reason:"reverification_failed",continuationAvailable:false});
    expect(result.coverage?.fields[0].retainedAfterRecheck).not.toBe(true);
  });
  it.each(["unsupported",undefined])("keeps duplicate text with different range identity from masking an old safety denial (%s)",async(reason)=>{
    const before=previous();before.claims.push(structuredClone(before.claims[0]));
    const old=before.plainLanguageCoverage!.fields[0];old.claimIndices=[0,1];old.lessonSpans=[{claimIndex:0,spanIds:["r0"]},{claimIndex:1,spanIds:["r1"]}];old.explainedSpanIds=["r0","r1"];old.explainedSpanCount=2;
    const prepared=prepareProgressiveTeaching([field],before,versions);
    const result=await reviewProgressiveTeaching({json:async(_system,input:any)=>({verdicts:input.expectedIds.map((id:string)=>{
      const check=input.checks.find((c:any)=>c.id===id),denied=check.checkType==="lesson"&&check.index===0 || check.checkType==="coverage_range"&&check.rangeId==="r0";
      return {id,supported:!denied,...(denied&&reason?{reason}:{})};
    })})},prepared.plan,prepared.prior,[{fieldId:plan[0].fieldId,status:"supported",lessons:[{text:newText,spanIds:["r2"]}],quiz:[]}],before,"整理警語","bundle");
    expect(result.coverage?.fields[0]).toMatchObject({reason:"reverification_failed",verificationMode:"current_model_review",continuationAvailable:false});
    expect(result.coverage?.fields[0].retainedAfterRecheck).not.toBe(true);
    expect(result.coverage?.fields[0].explainedSpanIds).not.toContain("r0");
    expect(result.coverage?.fields[0].explainedSpanIds).toContain("r1");
    expect(before.claims).toHaveLength(2);
  });
  it("counts exchanged range identities, not the net difference in their sizes",()=>{
    const before=previous();const old=before.plainLanguageCoverage!.fields[0];old.explainedSpanIds=["r0","r5"];old.explainedSpanCount=2;
    const current={...old,explainedSpanIds:["r0","r6","r7"],explainedSpanCount:3};
    expect(teachingProgressDelta([current],before,versions)).toMatchObject({additionalExplainedSpans:2,lostExplainedSpans:1});
    expect(teachingProgressDelta([{...current,sourceSha256:"different-source"}],before,versions)).toMatchObject({additionalExplainedSpans:3,lostExplainedSpans:2,legacyReorganized:true});
    expect(teachingProgressDelta([current],before,{"RECHECK-SYNTHETIC":"v2"})).toMatchObject({additionalExplainedSpans:3,lostExplainedSpans:2,legacyReorganized:true});
    expect(teachingProgressDelta([],before,versions).lostExplainedSpans).toBe(2);
  });
  it("does not claim legacy equal-position counts establish retained evidence",()=>{
    const before=previous(),old=before.plainLanguageCoverage!.fields[0];delete old.sourceSha256;delete old.lessonSpans;delete old.explainedSpanIds;
    expect(teachingProgressDelta([{...old,sourceSha256:sourceFieldSha(field),explainedSpanIds:["r1"]}],before,versions)).toMatchObject({additionalExplainedSpans:0,lostExplainedSpans:0,legacyReorganized:true});
    expect(teachingProgressDelta([{...old,sourceSha256:sourceFieldSha(field),explainedSpanIds:["r1"]}],before,{"RECHECK-SYNTHETIC":"v2"})).toMatchObject({additionalExplainedSpans:1,lostExplainedSpans:1,legacyReorganized:true});
  });
});

describe("complete quantitative rate units",()=>{
  it("rejects the actual extra bare-quantity assertion even when an earlier phrase has the right daily unit",()=>{
    expect(sourceQuantitativeRatesPreserved(rateFailure.text,rateFailure.quotes)).toBe(false);
    expect(sourceInterpretationExplicit(rateFailure.text,rateFailure.quotes)).toBe(false);
    expect(sourceActionResultOutdated({...previous(),claims:[{text:rateFailure.text,citations:rateFailure.quotes.map(quote=>({chunkId:"rate-source",quote}))}],quiz:[]})).toBe(true);
  });
  it.each([
    ["ketoconazole400mg/day與paroxetine20mg/day的研究。",true],
    ["ketoconazole每天400mg與paroxetine每日20mg的研究。",true],
    ["ketoconazole每天400毫克與paroxetine每日20毫克的研究。",true],
    ["ketoconazole400mg與paroxetine20mg的研究。",false],
    ["ketoconazole400mg/day與paroxetine20mg/day；原文另列400mg及20mg。",false],
  ])("checks each complete unit: %s",(text,expected)=>{
    expect(sourceQuantitativeRatesPreserved(text as string,["ketoconazole(400 mg/day)與paroxetine(20 mg/day)的研究。"])).toBe(expected);
  });
  it("preserves body-weight and time denominators without turning a source quantity into a personal dose",()=>{
    expect(sourceQuantitativeRatesPreserved("研究使用2mg/kg/day。",["研究使用2mg/kg/day。"])) .toBe(true);
    expect(sourceQuantitativeRatesPreserved("研究使用每天每公斤2mg。",["研究使用2mg/kg/day。"])) .toBe(true);
    expect(sourceQuantitativeRatesPreserved("研究使用每天2mg。",["研究使用2mg/kg/day。"])) .toBe(false);
    expect(sourceQuantitativeRatesPreserved("研究使用2mg。",["研究使用2mg/kg/day。"])) .toBe(false);
    const input=teachingPlanInput(prepareTeachingPlan(sourcePassages([{...chunks[0],text:"【交互作用】ketoconazole(400 mg/day)與paroxetine(20 mg/day)的研究。"}])))[0];
    expect(input.requiredScopeLiterals).toContain("400mg/day");
    expect(input.requiredScopeLiterals).not.toContain("400mg");
  });
  it.each([["4,000","4000"],["4000","4,000"]])("treats a complete thousands group as the same quantity without losing its rate or boundary (%s→%s)",(sourceNumber,shownNumber)=>{
    const quote=`超過${sourceNumber}mg/day時，需接受來源明示處理。`;
    expect(sourceQuantitativeRatesPreserved(`超過${shownNumber}mg時，需接受來源明示處理。`,[quote])).toBe(false);
    expect(sourceQuantitativeRatesPreserved(`每天超過${shownNumber}mg時，需接受來源明示處理。`,[quote])).toBe(true);
    expect(sourceQuantitativeBoundsPreserved(`${shownNumber}mg/day時，需接受來源明示處理。`,[quote])).toBe(false);
    expect(sourceQuantitativeBoundsPreserved(`每天超過${shownNumber}mg時，需接受來源明示處理。`,[quote])).toBe(true);
    expect(sourceQuantitativeBoundsPreserved(`超過${shownNumber}mg/day時需處理。`,[`${sourceNumber}mg/day以上時需處理。`])).toBe(false);
  });
});
