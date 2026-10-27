import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import { sourceCoverageLedger } from "../server/source-teaching";
import { prepareProgressiveTeaching, previousTeachingDrafts, mergeTeachingDrafts, reviewProgressiveTeaching, sourceFieldSha, MAX_TARGET_CHARS, MAX_FIELD_CONTEXT_CHARS, MAX_BATCH_CONTEXT_CHARS } from "../server/teaching-progress";
import { needsTeachingCompletion } from "../shared/teaching-completion";
import type { Chunk, GroundedResult } from "../shared/schema";

// Deliberately repetitive, non-medical source. Every generated statement is
// supported by the stated software-only limitation. Unselected ledger ranges
// still require independent coverage checks, even when their wording repeats.
const sentence="這份合成資料僅供軟體流程測試，不可作為實際醫療資訊。";
const text="【警語】\n"+sentence.repeat(190);
const chunks: Chunk[]=[{id:"SYNTHETIC-PROGRESS-1",licenseNo:"SYNTHETIC-PROGRESS",version:"frozen-v1",sourceFormat:"pdf",page:1,start:0,text}];
const explanation="這份合成資料只用於軟體流程的測試，不能拿來當作實際醫療資訊。";
function provider(options:{failRepair?:boolean; rejectFirstScope?:boolean}={}) {
  const payloads:any[]=[];
  const scopeDenials:{rangeId:string;lessonIndex:number}[]=[];
  const llm:Llm={json:async (_system,input:any) => {
    payloads.push(structuredClone(input));
    if(input.expectedIds) {
      const ranges=input.checks?.filter((c:any) => c.checkType==="coverage_range") || [];
      return {verdicts:input.expectedIds.map((id:string) => {
        const check=input.checks?.find((c:any)=>c.id===id);
        const rejectedScope=options.rejectFirstScope && check?.checkType==="source_scope" &&
          input.checks.some((lesson:any)=>lesson.checkType==="lesson" &&
            lesson.fieldId===check.fieldId && lesson.index===check.lessonIndex && lesson.spanIds.includes("r0"));
        if(rejectedScope)scopeDenials.push({rangeId:"r0",lessonIndex:check.lessonIndex});
        const supported=check?.checkType==="coverage_range" ? check.lessonIndices.length>0 :
          check?.checkType==="coverage" ? ranges.filter((r:any)=>r.fieldId===check.fieldId).every((r:any)=>r.lessonIndices.length>0) :
          // Lesson indices are remapped after the first wave rejects a row.
          // Keep denying the same source range in both reviews, rather than
          // accidentally approving r0 when it is regenerated at another index.
          !rejectedScope;
        return {id,supported};
      })};
    }
    if(options.failRepair && !input.sources) throw Error("synthetic_optional_repair_failure");
    const fieldTeaching=(input.teachingFields || []).map((f:any)=>({fieldId:f.fieldId,status:"supported",
      lessons:(f.targetSpanIds || f.coverageLedger.map((s:any)=>s.id)).map((id:string)=>({text:explanation,spanIds:[id],profileRefs:[]})),
      quiz:[{q:`依${f.sourceSection}，這份合成資料可以作為實際醫療資訊嗎？`,options:["不可以，只供軟體流程測試","可以作為實際醫療資訊"],answer:0,lessonIndices:[0],spanIds:[(f.targetSpanIds || f.coverageLedger.map((s:any)=>s.id))[0]]}],
    }));
    return input.sources ? {status:"supported",claims:[],quiz:[],followups:[],fieldTeaching} : {fieldTeaching};
  }};
  return {llm,payloads,scopeDenials};
}
const versions={"SYNTHETIC-PROGRESS":"frozen-v1"};

describe("bounded source-bound teaching progress",()=>{
  it("makes real partial progress across two bounded jobs and freshly rechecks retained explanations",async()=>{
    const firstProvider=provider();
    const first=await grounded(firstProvider.llm,"請整理警語與理解題",chunks,{},"bundle");
    const field=first.plainLanguageCoverage!.fields[0];
    expect(text.length).toBeGreaterThan(4000);
    expect(text.length).toBeLessThan(MAX_FIELD_CONTEXT_CHARS);
    expect(field.status).toBe("partial");
    expect(field.explainedSpanCount).toBeGreaterThan(0);
    expect(field.explainedSpanCount).toBeLessThan(field.sourceSpanCount);
    expect(field.explainedSpanIds).toHaveLength(field.explainedSpanCount);
    expect(needsTeachingCompletion(first)).toBe(true);
    expect(firstProvider.payloads.length).toBeLessThanOrEqual(5);
    const frozen=JSON.stringify(first);
    const secondProvider=provider();
    const second=await grounded(secondProvider.llm,"請整理警語與理解題",chunks,{previousTeaching:first},"bundle");
    expect(JSON.stringify(first)).toBe(frozen);
    const completed=second.plainLanguageCoverage!.fields[0];
    expect(completed.status).toBe("complete");
    expect(completed.explainedSpanCount).toBe(completed.sourceSpanCount);
    expect(completed.explainedSpanCount).toBeGreaterThan(field.explainedSpanCount);
    expect(second.plainLanguageCoverage!.progressFromPrevious!.additionalExplainedSpans).toBeGreaterThan(0);
    expect(secondProvider.payloads.length).toBeLessThanOrEqual(5);
    for(const p of [...firstProvider.payloads,...secondProvider.payloads]) {
      expect(p.context?.previousTeaching).toBeUndefined();
      expect(p.previousTeaching).toBeUndefined();
      for(const f of p.teachingFields || p.fields || []) expect(f.fullSourceField).toBe(sourcePassages(chunks)[0].quote);
      const targets=(p.teachingFields || []).flatMap((f:any)=>(f.coverageLedger || []).filter((s:any)=>f.targetSpanIds.includes(s.id)));
      expect(targets.reduce((n:number,s:any)=>n+s.text.length,0)).toBeLessThanOrEqual(MAX_TARGET_CHARS);
    }
    const review=secondProvider.payloads.find((p)=>p.checks?.some((c:any)=>c.checkType==="lesson"));
    expect(review.checks.filter((c:any)=>c.checkType==="lesson").length).toBeGreaterThan(field.claimIndices.length);
    for(const mapping of completed.lessonSpans!) {
      expect(completed.claimIndices).toContain(mapping.claimIndex);
      expect(second.claims[mapping.claimIndex].text).toBe(explanation);
      expect(mapping.spanIds.every((id)=>completed.explainedSpanIds!.includes(id))).toBe(true);
    }
    expect(new Set(second.quiz.map((q)=>q.id)).size).toBe(second.quiz.length);
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(900_000);
  });
  it("keeps a failed second wave's independently verified partial content",async()=>{
    const {llm,payloads}=provider({failRepair:true});
    const result=await grounded(llm,"請整理警語",chunks,{},"bundle");
    expect(payloads.length).toBeLessThanOrEqual(5);
    expect(result.plainLanguageCoverage!.status).toBe("partial");
    expect(result.claims.some((c)=>c.text===explanation)).toBe(true);
    expect(result.quiz.some((q)=>q.explanationKind==="verified_plain_language")).toBe(true);
    expect(result.plainLanguageCoverage!.fields[0].explainedSpanCount).toBeGreaterThan(0);
  });
  it("keeps an oversized historical chunk payload out of every provider request",async()=>{
    const first=await grounded(provider().llm,"警語",chunks,{},"bundle");
    const previous={...first,chunks:[{...chunks[0],text:"NEVER_SEND_OLD_PAYLOAD_".repeat(100_000)}]};
    const {llm,payloads}=provider();
    await grounded(llm,"警語",chunks,{previousTeaching:previous},"bundle");
    for(const p of payloads) {
      const serialized=JSON.stringify(p);
      expect(serialized).not.toContain("NEVER_SEND_OLD_PAYLOAD");
      expect(Buffer.byteLength(serialized)).toBeLessThan(200_000);
    }
  });
  it("stops offering repeated paid completion after a fixed attempt makes no actual progress",async()=>{
    const first=await grounded(provider().llm,"警語",chunks,{},"bundle");
    const ordinary=provider();
    const unchanged:Llm={json:async(system,input:any)=>{
      if(input.expectedIds) return ordinary.llm.json(system,input);
      if(input.sources) return {status:"supported",claims:[],quiz:[],followups:[],fieldTeaching:[]};
      throw Error("synthetic_repair_failed_no_progress");
    }};
    const next=await grounded(unchanged,"警語",chunks,{previousTeaching:first},"bundle");
    expect(next.plainLanguageCoverage!.progressFromPrevious).toMatchObject({additionalExplainedSpans:0,additionalQuiz:0});
    expect(next.claims.some((claim)=>claim.text===explanation)).toBe(true);
    expect(next.plainLanguageCoverage!.fields.every((field)=>field.continuationAvailable===false)).toBe(true);
    expect(needsTeachingCompletion(next)).toBe(false);
  });
  it.each(["source-hash","version","citation","missing-ledger","forged-count"])("does not reuse old metadata after %s",async(mutation)=>{
    const first=await grounded(provider().llm,"警語",chunks,{},"bundle");
    const altered=structuredClone(first),f=altered.plainLanguageCoverage!.fields[0];
    if(mutation==="source-hash") f.sourceSha256="0".repeat(64);
    if(mutation==="version") altered.sourceVersions["SYNTHETIC-PROGRESS"]="other";
    if(mutation==="citation") altered.claims[f.claimIndices[0]].citations[0].quote+="變更";
    if(mutation==="missing-ledger") delete f.lessonSpans;
    if(mutation==="forged-count") {f.explainedSpanIds=["not-a-real-range"];f.explainedSpanCount=999;}
    const current=prepareProgressiveTeaching(sourcePassages(chunks),undefined,versions);
    expect(previousTeachingDrafts(current.plan,altered,versions).size).toBe(0);
    expect(prepareProgressiveTeaching(sourcePassages(chunks),altered,versions).generationPlan[0].targetSpanIds[0]).toBe("r0");
  });
  it("does not let old complete flags override a fresh failed source-scope review",async()=>{
    const first=await grounded(provider().llm,"警語",chunks,{},"bundle");
    const {llm,scopeDenials}=provider({rejectFirstScope:true});
    const result=await grounded(llm,"警語",chunks,{previousTeaching:first},"bundle");
    expect(result.plainLanguageCoverage!.fields[0].status).toBe("partial");
    expect(result.plainLanguageCoverage!.fields[0].explainedSpanIds).not.toContain("r0");
    expect(scopeDenials).toHaveLength(2);
    expect(scopeDenials.map((denial)=>denial.rangeId)).toEqual(["r0","r0"]);
    expect(scopeDenials[0].lessonIndex).not.toBe(scopeDenials[1].lessonIndex);
  });
  it("does not offer a futile paid continuation for source/context holds or exhausted capacity",async()=>{
    const first=await grounded(provider().llm,"警語",chunks,{},"bundle");
    const exhausted=structuredClone(first);exhausted.plainLanguageCoverage!.fields.forEach((f)=>f.continuationAvailable=false);
    expect(needsTeachingCompletion(exhausted)).toBe(false);
    const tooLong=sourcePassages([{...chunks[0],text:"【警語】"+sentence.repeat(310)}]);
    const prepared=prepareProgressiveTeaching(tooLong,undefined,versions);
    expect(prepared.generationPlan).toEqual([]);
    expect(prepared.plan[0].continuationAvailable).toBe(false);
    expect(prepared.plan[0].field.quote).toBe(tooLong[0].quote);
  });
  it("keeps the whole byte-aligned source across long accounting cuts, including emoji",()=>{
    const raw={...sourcePassages(chunks)[0],quote:"【警語】"+"連續原文🧪".repeat(550)+"。"};
    const ledger=sourceCoverageLedger(raw);
    expect(ledger.map((s)=>s.text).join("")).toBe(raw.quote);
    expect(ledger.every((s)=>s.text.length<=1200)).toBe(true);
    for(const s of ledger) expect(raw.quote.slice(s.start,s.end)).toBe(s.text);
    expect(createHash("sha256").update(raw.quote).digest("hex")).toHaveLength(64);
  });
  it("reserves every later safe prior field before adding fresh lessons, independent of field order/license",()=>{
    const fields=["SYNTHETIC-NEW","SYNTHETIC-OLD-A","SYNTHETIC-OLD-B"].map((licenseNo)=>({...sourcePassages(chunks)[0],licenseNo,originalFieldId:licenseNo}));
    const base=prepareProgressiveTeaching(fields,undefined,{}).plan.map((item)=>({...item,reason:undefined}));
    const oldA={fieldId:base[1].fieldId,status:"supported" as const,lessons:Array.from({length:48},(_,i)=>({text:"原先已核對的合成教學甲"+i,spanIds:["r0"]})),quiz:[]};
    const oldB={fieldId:base[2].fieldId,status:"supported" as const,lessons:Array.from({length:2},(_,i)=>({text:"原先已核對的合成教學乙"+i,spanIds:["r0"]})),quiz:[]};
    const fresh={fieldId:base[0].fieldId,status:"supported",lessons:Array.from({length:16},(_,i)=>({text:"本輪新增的合成教學"+i,spanIds:["r0"]})),quiz:[]};
    const prior=new Map([[oldA.fieldId,oldA],[oldB.fieldId,oldB]]);
    for(const order of [base,[base[2],base[0],base[1]],[base[1],base[2],base[0]]]) {
      const merged=mergeTeachingDrafts(order,prior,[fresh]);
      expect(merged.reduce((n,d)=>n+d.lessons.length,0)).toBe(64);
      expect(merged.find((d)=>d.fieldId===oldA.fieldId)!.lessons.map((l)=>l.text)).toEqual(oldA.lessons.map((l)=>l.text));
      expect(merged.find((d)=>d.fieldId===oldB.fieldId)!.lessons.map((l)=>l.text)).toEqual(oldB.lessons.map((l)=>l.text));
      expect(merged.find((d)=>d.fieldId===fresh.fieldId)!.lessons).toHaveLength(14);
    }
  });
  it("stops targeting another paid generation at the accumulated text boundary, including fewer than64 lessons",async()=>{
    const previous=await grounded(provider().llm,"警語",chunks,{},"bundle");
    const field=previous.plainLanguageCoverage!.fields[0];
    previous.claims=Array.from({length:16},()=>({text:"這是合成軟體流程的詳細說明。".repeat(100).slice(0,750),kind:"source_plain_language",category:"warning",citations:[{chunkId:chunks[0].id,quote:sourcePassages(chunks)[0].quote}]}));
    previous.quiz=[];field.quizIds=[];field.claimIndices=previous.claims.map((_,i)=>i);
    field.lessonSpans=field.claimIndices.map((claimIndex)=>({claimIndex,spanIds:["r0"]}));
    field.explainedSpanIds=["r0"];field.explainedSpanCount=1;
    const capped=prepareProgressiveTeaching(sourcePassages(chunks),previous,versions);
    expect(capped.prior.get(field.fieldId)!.lessons).toHaveLength(16);
    expect(capped.generationPlan).toEqual([]);
    expect(capped.plan[0].continuationAvailable).toBe(false);
    previous.claims.forEach((claim)=>{claim.text=claim.text.slice(0,749);});
    expect(prepareProgressiveTeaching(sourcePassages(chunks),previous,versions).generationPlan.length).toBeGreaterThan(0);
  });
  it("finishes deferred sibling fields without losing their source identity, lesson offsets or quizzes",async()=>{
    const labels=["警語","注意事項","禁忌","副作用","交互作用","過量"];
    const many=[{...chunks[0],text:labels.map((label)=>`【${label}】\n`+sentence.repeat(11)).join("\n")}];
    const first=await grounded(provider().llm,"請整理全部安全資訊",many,{},"bundle");
    expect(first.plainLanguageCoverage!.fields).toHaveLength(6);
    expect(first.plainLanguageCoverage!.fields.every((f)=>f.status==="complete"),JSON.stringify(first.plainLanguageCoverage!.fields)).toBe(true);
    expect(first.plainLanguageCoverage!.fields.every((f)=>f.quizIds.length>0)).toBe(true);
    expect(new Set(first.quiz.map((q)=>q.id)).size).toBe(first.quiz.length);
    for(const f of first.plainLanguageCoverage!.fields) for(const lesson of f.lessonSpans!) {
      expect(f.claimIndices).toContain(lesson.claimIndex);
      expect(first.claims[lesson.claimIndex].kind).toBe("source_plain_language");
      expect(first.claims[lesson.claimIndex].citations[0].quote).toContain(f.sourceSection);
    }
  });
  it("bounds fresh review for four4.4k prior fields and carries only unchanged source-verified siblings",async()=>{
    const fields=Array.from({length:4},(_,i)=>{
      const quote="【警語】"+sentence.repeat(150),chunkId="SYNTHETIC-CARRY-"+i;
      return {...sourcePassages(chunks)[0],licenseNo:chunkId,chunkId,originalFieldId:chunkId,quote,citations:[{chunkId,quote}]};
    });
    const currentVersions=Object.fromEntries(fields.map((f)=>[f.licenseNo,"frozen-v1"]));
    const baseline=prepareProgressiveTeaching(fields,undefined,currentVersions);
    const previous:GroundedResult={status:"supported",claims:fields.map((field)=>({text:explanation,kind:"source_plain_language",category:"warning",citations:field.citations})),chunks:[],quiz:fields.map((field,i)=>({id:"old-q"+i,q:"依警語，這份合成資料可以作為實際醫療資訊嗎？",options:["不可以，只供軟體流程測試","可以作為實際醫療資訊"],answer:0,explain:explanation,citations:field.citations,learningObjective:"warning"})),followups:[],rejectedCount:0,sourceVersions:currentVersions,verification:"model_assisted",
      plainLanguageCoverage:{scope:"recognized_source_fields",status:"partial",fields:baseline.plan.map((item,i)=>({fieldId:item.fieldId,licenseNo:item.field.licenseNo,sourceSection:"警語",sourceSpanCount:item.ledger.length,explainedSpanCount:1,status:"partial",claimIndices:[i],quizIds:["old-q"+i],sourceSha256:sourceFieldSha(item.field),explainedSpanIds:["r0"],lessonSpans:[{claimIndex:i,spanIds:["r0"]}],continuationAvailable:true}))}};
    expect(fields.reduce((n,f)=>n+f.quote.length,0)).toBeGreaterThan(MAX_BATCH_CONTEXT_CHARS);
    const prepared=prepareProgressiveTeaching(fields,previous,currentVersions);
    const raw=prepared.generationPlan.map((item)=>({fieldId:item.fieldId,status:"supported",lessons:item.targetSpanIds.map((id)=>({text:explanation,spanIds:[id]})),quiz:[]}));
    const {llm,payloads}=provider();
    const reviewed=await reviewProgressiveTeaching(llm,prepared.plan,prepared.prior,raw,previous,"警語","bundle");
    for(const request of payloads)expect((request.fields || []).reduce((n:number,f:any)=>n+f.fullSourceField.length,0)).toBeLessThanOrEqual(MAX_BATCH_CONTEXT_CHARS);
    expect(reviewed.coverage!.fields.filter((f)=>f.verificationMode==="current_model_review")).toHaveLength(2);
    expect(reviewed.coverage!.fields.filter((f)=>f.verificationMode==="source_bound_carry")).toHaveLength(2);
    expect(reviewed.coverage!.fields).toHaveLength(4);
    for(const field of reviewed.coverage!.fields)for(const index of field.claimIndices)
      expect(reviewed.claims[index].citations[0].chunkId).toBe(field.licenseNo);
    const changed=structuredClone(previous);changed.claims[2].citations[0].quote+="改變";
    const invalid=prepareProgressiveTeaching(fields,changed,currentVersions);
    expect(invalid.prior.has(prepared.plan[2].fieldId)).toBe(false);
    const sourceChanged=structuredClone(previous);sourceChanged.plainLanguageCoverage!.fields[3].sourceSha256="0".repeat(64);
    expect(prepareProgressiveTeaching(fields,sourceChanged,currentVersions).prior.has(prepared.plan[3].fieldId)).toBe(false);
    expect(JSON.stringify(previous)).not.toContain("改變");
  });
  it("offers one legacy20-field upgrade and prioritizes its unassessed fields without trusting old coverage as source evidence",()=>{
    const fields=Array.from({length:20},(_,i)=>{
      const quote="【警語】"+sentence.repeat(8),chunkId="SYNTHETIC-LEGACY-"+i;
      return {...sourcePassages(chunks)[0],licenseNo:"SYNTHETIC-PROGRESS",chunkId,originalFieldId:chunkId,quote,citations:[{chunkId,quote}]};
    });
    const baseline=prepareProgressiveTeaching(fields,undefined,versions);
    const legacy:GroundedResult={status:"supported",claims:[],quiz:[],chunks:[],followups:[],rejectedCount:0,sourceVersions:versions,verification:"model_assisted",plainLanguageCoverage:{scope:"recognized_source_fields",status:"partial",fields:baseline.plan.map((item,i)=>({fieldId:item.fieldId,licenseNo:item.field.licenseNo,sourceSection:"警語",sourceSpanCount:item.ledger.length,explainedSpanCount:i<4?item.ledger.length:0,status:i<4?"complete":"unavailable",claimIndices:[],quizIds:[],...(i<4?{}:{reason:"job_budget" as const})}))}};
    expect(needsTeachingCompletion(legacy)).toBe(true);
    const prepared=prepareProgressiveTeaching(fields,legacy,versions);
    expect(prepared.prior.size).toBe(0);
    expect(prepared.generationPlan).toHaveLength(4);
    expect(prepared.generationPlan.every((item)=>baseline.plan.findIndex((old)=>old.fieldId===item.fieldId)>=4)).toBe(true);
    const stopped=structuredClone(legacy);stopped.plainLanguageCoverage!.progressFromPrevious={additionalExplainedSpans:0,additionalQuiz:0,lostExplainedSpans:0};
    expect(needsTeachingCompletion(stopped)).toBe(false);
  });
  it("does not call every regenerated legacy range new when upgrading a mixed saved result",async()=>{
    const labels=["警語","注意事項","禁忌","副作用","交互作用","過量"];
    const many=[{...chunks[0],text:labels.map((label)=>`【${label}】\n`+sentence.repeat(11)).join("\n")}];
    const legacy=await grounded(provider().llm,"安全說明",many,{},"bundle");
    for(const [index,field]of legacy.plainLanguageCoverage!.fields.entries()) {
      delete field.sourceSha256;delete field.explainedSpanIds;delete field.lessonSpans;delete field.continuationAvailable;
      if(index>=4){field.status="unavailable";field.reason="job_budget";field.claimIndices=[];field.quizIds=[];field.explainedSpanCount=0;}
    }
    legacy.plainLanguageCoverage!.status="partial";
    const frozen=JSON.stringify(legacy),next=await grounded(provider().llm,"安全說明",many,{previousTeaching:legacy},"bundle");
    const pending=legacy.plainLanguageCoverage!.fields.slice(4).reduce((n,f)=>n+f.sourceSpanCount,0);
    expect(next.plainLanguageCoverage!.progressFromPrevious!.legacyReorganized).toBe(true);
    expect(next.plainLanguageCoverage!.progressFromPrevious!.additionalExplainedSpans).toBe(pending);
    expect(next.plainLanguageCoverage!.fields.every((f)=>f.status==="complete")).toBe(true);
    expect(JSON.stringify(legacy)).toBe(frozen);
  });
});
