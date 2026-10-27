import {expect,it,describe} from "vitest";
import observed from "./fixtures/bilingual-population-scope-031505.json";
import {sourceActionResultOutdated,sourceBilingualConditions,sourceBilingualConditionsPreserved,sourceInterpretationExplicit,sourceQuizInterpretationExplicit,prepareTeachingPlan,reviewTeachingPlan,teachingScopeLiterals} from "../server/source-teaching";
import {sourcePassages} from "../server/ai";
import type {Chunk,GroundedResult} from "../shared/schema";
const citations=[{chunkId:"BILINGUAL-SOURCE",quote:observed.sourceQuote}];
const result=(text:string):GroundedResult=>({status:"supported",claims:[{text,citations}],quiz:[],chunks:[],sourceVersions:{},followups:[],rejectedCount:0,verification:"model_assisted"});
const explicit=observed.firstText.replace("老年失智症病患","老年失智症病患（dementia-related psychosis）");
describe("bounded bilingual source qualification",()=>{
  it("finds the original adjacent population descriptor without treating trial design or general names as that qualifier",()=>{
    expect(sourceBilingualConditions(observed.sourceQuote)).toEqual([{anchor:"老年失智症病患",triggers:["老年失智症病患","老年失智症"],qualifier:"dementia-related psychosis"}]);
    expect(teachingScopeLiterals(sourcePassages([{id:"BILINGUAL-SOURCE",licenseNo:"BILINGUAL-SOURCE",version:"v1",page:1,start:0,sourceFormat:"html",text:observed.sourceQuote}])[0])).toContain("dementia-related psychosis");
  });
  it("rejects the observed first statement and the unproven Chinese-only rewrite instead of guessing translation equivalence",()=>{
    expect(sourceBilingualConditionsPreserved(observed.firstText,[observed.sourceQuote])).toBe(false);
    expect(sourceInterpretationExplicit(observed.firstText,[observed.sourceQuote])).toBe(false);
    expect(sourceBilingualConditionsPreserved(observed.chineseOnlyResumeText,[observed.sourceQuote])).toBe(false);
    expect(sourceActionResultOutdated(result(observed.firstText))).toBe(true);
    expect(sourceActionResultOutdated(result(observed.chineseOnlyResumeText))).toBe(true);
  });
  it("accepts preservation of the original bilingual qualification, including case/spacing without changing the words",()=>{
    expect(sourceBilingualConditionsPreserved(explicit,[observed.sourceQuote])).toBe(true);
    expect(sourceInterpretationExplicit(explicit,[observed.sourceQuote])).toBe(true);
    expect(sourceBilingualConditionsPreserved(explicit.replace("dementia-related psychosis","Dementia-related   psychosis"),[observed.sourceQuote])).toBe(true);
    expect(sourceActionResultOutdated(result(explicit))).toBe(false);
  });
  it("does not attach an unrelated population qualifier to another statement in the same field or to full exact source reading",()=>{
    expect(sourceBilingualConditionsPreserved(observed.unrelatedText,[observed.sourceQuote])).toBe(true);
    expect(sourceActionResultOutdated(result(observed.unrelatedText))).toBe(false);
    expect(sourceBilingualConditionsPreserved(observed.sourceQuote,[observed.sourceQuote])).toBe(true);
    expect(sourceActionResultOutdated({...result(observed.sourceQuote),claims:[{text:observed.sourceQuote,kind:"source_exact_safety",citations}]})).toBe(false);
  });
  it.each([
    ["某病患者(patients with condition A)","某病患者","patients with condition A"],
    ["某病患者(patients without condition B)","某病患者","patients without condition B"],
    ["相關疾病(drug-associated disease)","相關疾病","drug-associated disease"],
    ["誘發某症(drug-induced syndrome)","誘發某症","drug-induced syndrome"],
    ["兒童(children with condition A)","兒童","children with condition A"],
  ])("preserves a structurally explicit source qualification: %s",(source,anchor,qualifier)=>{
    const quote=`【警語】${source}，有原文明示風險。`;
    expect(sourceBilingualConditionsPreserved(`${anchor}有原文明示風險。`,[quote])).toBe(false);
    expect(sourceBilingualConditionsPreserved(`${anchor}（${qualifier}）有原文明示風險。`,[quote])).toBe(true);
    expect(sourceBilingualConditionsPreserved("本欄另提醒避免飲酒。",[quote])).toBe(true);
  });
  it.each([
    "某藥品(Rifampin)會影響另一藥品。",
    "臨床試驗(Randomized controlled trial)與回溯性研究。",
    "傳統(Conventional)與非典型(Atypical)藥品。",
    "研究資料(associated study data)記載原文內容。",
  ])("does not make an ordinary English name or unrelated referent a population restriction: %s",(quote)=>{
    expect(sourceBilingualConditions(quote)).toEqual([]);
    expect(sourceBilingualConditionsPreserved(quote.split("(")[0]+"另有原文明示內容。",[quote])).toBe(true);
  });
  it("requires the qualifier in the question plus correct answer rather than relying on an explanation elsewhere",()=>{
    const q="依警語，老年失智症病患的研究風險方向為何？",correct="與安慰劑組相比，死亡的相對危險性較高。";
    expect(sourceQuizInterpretationExplicit(q,correct,[observed.sourceQuote])).toBe(false);
    expect(sourceQuizInterpretationExplicit(q.replace("老年失智症病患","老年失智症病患（dementia-related psychosis）"),correct,[observed.sourceQuote])).toBe(true);
    const value={...result(explicit),quiz:[{id:"q",q,options:[correct,"相對危險性較低。"],answer:0,explain:explicit,citations}]};
    expect(sourceActionResultOutdated(value)).toBe(true);
  });
  it("rejects the real omitted qualification before publication even when a synthetic reviewer optimistically approves all checks",async()=>{
    const chunks:Chunk[]=[{id:"BILINGUAL-SOURCE",licenseNo:"BILINGUAL-SOURCE",version:"v1",page:1,start:0,sourceFormat:"html",text:observed.sourceQuote}];
    const field=sourcePassages(chunks)[0],plan=prepareTeachingPlan([field]);
    const approve={json:async(_system:string,input:any)=>({verdicts:input.expectedIds.map((id:string)=>({id,supported:true}))})};
    const draft=(text:string)=>[{fieldId:plan[0].fieldId,status:"supported",lessons:[{text,spanIds:plan[0].ledger.map(r=>r.id)}],quiz:[]}];
    const rejected=await reviewTeachingPlan(approve,plan,draft(observed.firstText),"整理警語","bundle");
    expect(rejected.claims).toHaveLength(0);
    expect(rejected.coverage?.fields[0].status).not.toBe("complete");
    const accepted=await reviewTeachingPlan(approve,plan,draft(explicit),"整理警語","bundle");
    expect(accepted.claims.some(c=>c.text===explicit)).toBe(true);
    expect(accepted.coverage?.fields[0].status).toBe("partial");
  });
});
