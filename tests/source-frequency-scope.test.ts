import {describe,expect,it} from "vitest";
import observed from "./fixtures/frequency-scope-031505.json";
import nmsProse from "./fixtures/frequency-prose-nms-20261024.json";
import {sourceFrequencyScopePreserved,sourceInterpretationExplicit,sourceQuizInterpretationExplicit,sourceActionResultOutdated,prepareTeachingPlan,reviewTeachingPlan} from "../server/source-teaching";
import {sourcePassages} from "../server/ai";
import type {Chunk,GroundedResult} from "../shared/schema";

const quotes=observed.citations.map(c=>c.quote);
const source="【副作用】肝臟：有時出現肝障害。外錐體症狀：巴金森氏症候群。眼：有時出現眼的調節障害。";
const result=(text:string):GroundedResult=>({status:"supported",claims:[{text,citations:observed.citations}],quiz:[],chunks:[],sourceVersions:{},followups:[],rejectedCount:0,verification:"model_assisted"});

describe("literal frequency scope across labelled source items",()=>{
  it("does not interpret a prose 'symptoms may include' clause as an unqualified nominal frequency label",()=>{
    const quotes=nmsProse.citations.map(c=>c.quote);
    expect(sourceFrequencyScopePreserved(nmsProse.text,quotes)).toBe(true);
    expect(sourceInterpretationExplicit(nmsProse.text,quotes)).toBe(true);
    expect(sourceActionResultOutdated({...result(nmsProse.text),claims:[{text:nmsProse.text,citations:nmsProse.citations}]})).toBe(false);
  });
  it.each([
    ["胃腸道：噁心（常見）、腹痛。","常見腹痛","腹痛"],
    ["胃腸道：常見噁心；皮膚：罕見皮疹。","常見皮疹","皮疹"],
    ["常見頭痛，若伴隨皮疹應停藥；其他：皮疹。","常見皮疹","皮疹"],
    ["常見：噁心，其他：皮疹。","常見皮疹","皮疹"],
    ["其他（頻率不明）：皮疹、搔癢。","常見皮疹","皮疹"],
    ["常見：嚴重皮疹；其他：皮疹。","常見皮疹","皮疹"],
    ["其他：皮疹（含蕁麻疹）。","常見皮疹","皮疹"],
  ])("keeps a local source frequency attached to its own exact item: %s",(quote,text,answer)=>{
    expect(sourceFrequencyScopePreserved(text,[quote])).toBe(false);
    expect(sourceInterpretationExplicit(text,[quote])).toBe(false);
    expect(sourceQuizInterpretationExplicit("依原文，下列哪種反應常見？",answer,[quote])).toBe(false);
    const citations=[{chunkId:"FREQUENCY-LOCAL-SOURCE",quote}];
    const base={...result(text),claims:[{text,citations}]};
    expect(sourceActionResultOutdated(base)).toBe(true);
    expect(sourceActionResultOutdated({...base,claims:[],quiz:[{id:"frequency-q",q:"依原文，下列哪種反應常見？",options:[answer,"另一項反應"],answer:0,explain:"原文所列頻次。",citations}]})).toBe(true);
    expect(sourceFrequencyScopePreserved(quote,[quote])).toBe(true);
    expect(sourceActionResultOutdated({...base,claims:[{text:quote,citations,kind:"source_exact_safety"}]})).toBe(false);
  });
  it.each([
    ["胃腸道：常見噁心、腹痛。","常見腹痛"],
    ["胃腸道：噁心（常見）、腹痛。","常見噁心"],
    ["胃腸道：噁心（常見）、腹痛。","噁心（常見）、腹痛"],
    ["常見：嚴重皮疹；其他：皮疹。","常見嚴重皮疹"],
    ["皮膚（罕見）：皮疹。","罕見皮疹"],
    ["胃腸道：常見噁心；皮膚：罕見皮疹。","常見噁心，罕見皮疹。"],
  ])("retains a legitimate shared list or exact qualified item: %s",(quote,text)=>{
    expect(sourceFrequencyScopePreserved(text,[quote])).toBe(true);
    expect(sourceInterpretationExplicit(text,[quote])).toBe(true);
    expect(sourceActionResultOutdated({...result(text),claims:[{text,citations:[{chunkId:"FREQUENCY-LOCAL-SOURCE",quote}]}]})).toBe(false);
  });
  it("rejects the actual native merged sentence without assigning a replacement frequency",()=>{
    expect(sourceFrequencyScopePreserved(observed.generatedText,quotes)).toBe(false);
    expect(sourceInterpretationExplicit(observed.generatedText,quotes)).toBe(false);
    expect(sourceActionResultOutdated(result(observed.generatedText))).toBe(true);
  });
  it.each(["有時","偶爾","常見","罕見","不常見"])("does not spread %s from other source items onto an unqualified nominal item",frequency=>{
    expect(sourceFrequencyScopePreserved(`${frequency}會出現肝障害、巴金森氏症候群或眼睛調節障害。`,[source])).toBe(false);
  });
  it("keeps distinct labelled statements, exact source reading, and supported single-item frequency",()=>{
    expect(sourceFrequencyScopePreserved(source,[source])).toBe(true);
    expect(sourceFrequencyScopePreserved("肝臟方面有時出現肝障害；外錐體症狀包括巴金森氏症候群；眼部有時出現眼的調節障害。",[source])).toBe(true);
    expect(sourceFrequencyScopePreserved("有時會出現肝障害或眼的調節障害。",[source])).toBe(true);
    expect(sourceFrequencyScopePreserved("原文列有巴金森氏症候群，該項未列出發生頻率。",[source])).toBe(true);
    expect(sourceActionResultOutdated(result(quotes[0]))).toBe(false);
  });
  it("permits the same literal frequency when the source explicitly supplies it for that item",()=>{
    const explicit=source.replace("外錐體症狀：巴金森氏症候群", "外錐體症狀：有時出現巴金森氏症候群");
    expect(sourceFrequencyScopePreserved("有時會出現肝障害、巴金森氏症候群或眼的調節障害。",[explicit])).toBe(true);
  });
  it("does not equate different frequency words in a separate explicit source occurrence",()=>{
    const repeated=source+"另列：罕見巴金森氏症候群。";
    expect(sourceFrequencyScopePreserved("有時會出現巴金森氏症候群。",[repeated])).toBe(false);
    expect(sourceFrequencyScopePreserved("罕見巴金森氏症候群。",[repeated])).toBe(true);
    expect(sourceFrequencyScopePreserved("常見巴金森氏症候群。",[source+"另列：不常見巴金森氏症候群。"]) ).toBe(false);
  });
  it("does not attach another item's frequency to unrelated statements",()=>{
    expect(sourceFrequencyScopePreserved("本欄列有巴金森氏症候群。另有時出現眼的調節障害。",[source])).toBe(true);
    expect(sourceFrequencyScopePreserved("若有心電圖異狀，原文寫明要減量或停用。",quotes)).toBe(true);
  });
  it("checks the combined question and indexed correct answer, without rejecting a false distractor",()=>{
    expect(sourceQuizInterpretationExplicit("下列哪些有時會出現？","巴金森氏症候群",[source])).toBe(false);
    expect(sourceQuizInterpretationExplicit("依副作用欄，原文是否列有巴金森氏症候群？","有列出",[source])).toBe(true);
    const value={...result("仿單副作用欄列有巴金森氏症候群。"),quiz:[{id:"q",q:"依原文，下列哪些有時會出現？",options:["巴金森氏症候群","肝障害"],answer:0,explain:"依原文列出。",citations:observed.citations}]};
    expect(sourceActionResultOutdated(value)).toBe(true);
    expect(sourceActionResultOutdated({...value,quiz:[{...value.quiz[0],answer:1}]})).toBe(false);
  });
  it("filters the observed bad lesson before review and does not mark its field complete after optimistic review",async()=>{
    const chunks:Chunk[]=[{id:observed.citations[0].chunkId,licenseNo:"SYNTHETIC-FREQUENCY",version:"v1",page:1,start:0,sourceFormat:"html",text:"【副作用】"+quotes[0]}];
    const plan=prepareTeachingPlan(sourcePassages(chunks));
    const item=plan.find(p=>p.field.sourceSection==="副作用")!;
    const safe="對光線過敏者，仿單記載宜停藥。";
    const reviewed=await reviewTeachingPlan({json:async(_s,input:any)=>({verdicts:input.expectedIds.map((id:string)=>({id,supported:true}))})},[item],[{fieldId:item.fieldId,status:"supported",lessons:[{text:observed.generatedText,spanIds:[item.ledger[0].id]},{text:safe,spanIds:[item.ledger[0].id]}],quiz:[]}],"整理副作用","bundle");
    expect(reviewed.claims.some(c=>c.text===observed.generatedText)).toBe(false);
    expect(reviewed.claims.some(c=>c.text===safe)).toBe(true);
    expect(reviewed.coverage?.fields[0].status).not.toBe("complete");
    expect(reviewed.coverage?.fields[0].explainedSpanCount).toBe(0);
  });
});
