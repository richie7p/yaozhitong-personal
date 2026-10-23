import {expect,it} from "vitest";
import {grounded,sourcePassages,type Llm} from "../server/ai";
import type {Chunk} from "../shared/schema";

it("allows a regenerated range only after the optional wave freshly approves its new lesson against the complete source",async()=>{
  const sentence="這份合成資料僅供軟體流程測試，不可作為實際醫療資訊。";
  const chunks:Chunk[]=[{id:"SYNTHETIC-REAPPROVAL",licenseNo:"SYNTHETIC-REAPPROVAL",version:"v1",page:1,start:0,sourceFormat:"pdf",text:"【警語】\n"+sentence.repeat(190)}];
  const oldText="這份合成資料只用於軟體流程的測試，不能拿來當作實際醫療資訊。";
  const newText="這份合成資料僅為軟體流程的測試內容，不能拿來當作實際醫療資訊。";
  const create=(denyMainR0=false)=>{
    let reviews=0;
    const payloads:any[]=[],r0Reviews:{wave:number;index:number;supported:boolean;text:string}[]=[];
    const llm:Llm={json:async(_system,input:any)=>{
      payloads.push(structuredClone(input));
      if(input.expectedIds){
        const wave=++reviews;
        const ranges=input.checks.filter((check:any)=>check.checkType==="coverage_range");
        return {verdicts:input.expectedIds.map((id:string)=>{
          const check=input.checks.find((check:any)=>check.id===id);
          const lesson=check?.checkType==="source_scope" && input.checks.find((candidate:any)=>candidate.checkType==="lesson" && candidate.fieldId===check.fieldId && candidate.index===check.lessonIndex);
          const r0=lesson?.spanIds?.includes("r0");
          const supported=check?.checkType==="coverage_range" ? check.lessonIndices.length>0 : check?.checkType==="coverage" ? ranges.every((range:any)=>range.lessonIndices.length>0) : !(denyMainR0 && wave===1 && r0);
          if(r0)r0Reviews.push({wave,index:check.lessonIndex,supported,text:lesson.text});
          return {id,supported,...(!supported?{reason:"scope"}:{})};
        })};
      }
      const fieldTeaching=input.teachingFields.map((field:any)=>({fieldId:field.fieldId,status:"supported",lessons:field.targetSpanIds.map((span:string)=>({text:denyMainR0 && !input.sources && span==="r0"?newText:oldText,spanIds:[span]})),quiz:[]}));
      return input.sources?{status:"supported",claims:[],quiz:[],followups:[],fieldTeaching}:{fieldTeaching};
    }};
    return {llm,payloads,r0Reviews};
  };
  const first=await grounded(create().llm,"整理警語",chunks,{},"bundle");
  const before=JSON.stringify(first),provider=create(true);
  const after=await grounded(provider.llm,"整理警語",chunks,{previousTeaching:first},"bundle");
  expect(provider.r0Reviews).toHaveLength(2);
  expect(provider.r0Reviews[0]).toMatchObject({wave:1,supported:false,text:oldText});
  expect(provider.r0Reviews[1]).toMatchObject({wave:2,supported:true,text:newText});
  expect(provider.r0Reviews[1].index).not.toBe(provider.r0Reviews[0].index);
  const original=sourcePassages(chunks)[0].quote;
  const reviews=provider.payloads.filter(input=>input.expectedIds);
  for(const input of reviews){
    expect(input.fields[0].fullSourceField).toBe(original);
    expect(input.fields.reduce((n:number,field:any)=>n+field.fullSourceField.length,0)).toBeLessThanOrEqual(12000);
  }
  const secondWave=provider.payloads.find(input=>!input.expectedIds && !input.sources);
  expect(secondWave.teachingFields[0].targetSpanIds).toContain("r0");
  const field=after.plainLanguageCoverage!.fields[0];
  expect(field.explainedSpanIds).toContain("r0");
  expect(field.lessonSpans!.filter(mapping=>mapping.spanIds.includes("r0")).map(mapping=>after.claims[mapping.claimIndex].text)).toEqual([newText]);
  expect(field.verificationMode).toBe("current_model_review");
  expect(JSON.stringify(first)).toBe(before);
});
