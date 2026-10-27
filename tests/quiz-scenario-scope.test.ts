import { describe, expect, it } from "vitest";
import { sourceQuizInterpretationExplicit, sourceActionResultOutdated } from "../server/source-teaching";
import { sourceFieldClassificationOutdated } from "../server/ai";
const source = "服用本藥可能引起嗜睡，因此勿駕車或操作危險性機械。";
const answer = "勿駕車或操作危險性機械";
describe("source-bound question scenario", () => {
  it.each([
    "關於使用上注意事項，服用本藥可能嗜睡時，哪項符合仿單提醒？",
    "依警語，若感到嗜睡，哪項提醒符合？",
    "依警語，只有感到嗜睡時，哪個選項正確？",
    "依警語，出現嗜睡後才需要注意時，哪個選項正確？",
  ])("rejects a new symptom threshold in the stem: %s", (q) => {
    expect(sourceQuizInterpretationExplicit(q, answer, [source])).toBe(false);
  });
  it.each([
    "依使用上注意事項，服用本藥期間，關於駕駛哪項符合提醒？",
    "依使用上注意事項，服用本藥時，關於駕駛哪項符合提醒？",
    "本藥可能引起嗜睡。依使用上注意事項，關於駕駛哪項符合提醒？",
  ])("keeps treatment context and risk description: %s", (q) => {
    expect(sourceQuizInterpretationExplicit(q, answer, [source])).toBe(true);
  });
  it("keeps a scenario explicitly stated by its own source", () => {
    expect(sourceQuizInterpretationExplicit("依警語，若感到嗜睡時應怎麼做？", answer,
      ["若感到嗜睡時，勿駕車或操作危險性機械。"])).toBe(true);
    expect(sourceQuizInterpretationExplicit("依警語，出現發疹時應怎麼做？", "請立即停止使用並諮詢醫師。",
      ["若出現發疹時，請立即停止使用並諮詢醫師。"])).toBe(true);
  });
  it("keeps negative questions and original age, pregnancy and AND/OR conditions", () => {
    expect(sourceQuizInterpretationExplicit("依警語，服用本藥期間，哪個行為不符合提醒？", "駕車並不符合勿駕車的要求。", [source])).toBe(true);
    const q="依警語，患有心臟病且年齡65歲以上的人，哪項符合提醒？";
    const sourceAnd="患有心臟病且年齡65歲以上的人，請勿使用本品。";
    expect(sourceQuizInterpretationExplicit(q,"請勿使用本品",[sourceAnd])).toBe(true);
    expect(sourceQuizInterpretationExplicit(q.replace("且","或"),"請勿使用本品",[sourceAnd])).toBe(false);
    expect(sourceQuizInterpretationExplicit(q.replace("65歲以上","超過65歲"),"請勿使用本品",[sourceAnd])).toBe(false);
    expect(sourceQuizInterpretationExplicit("依警語，懷孕或可能懷孕的人應怎麼做？","請先諮詢醫師。",["懷孕或可能懷孕的人，請先諮詢醫師。"])) .toBe(true);
    expect(sourceQuizInterpretationExplicit("依警語，飲酒後才需注意時哪項符合？",answer,[source])).toBe(false);
    expect(sourceQuizInterpretationExplicit("依警語，可能嗜睡時，哪個行為不符合提醒？","駕車",[source])).toBe(false);
    expect(sourceQuizInterpretationExplicit("依警語，服藥期間，哪個行為不符合提醒？","駕車",[source])).toBe(true);
  });
  it("selectively rejects a legacy warning citation taken from a parenthetical cross-reference",()=>{
    const quote="【警語及注意事項】)此段說明作用機轉。";
    const chunk={id:"synthetic",licenseNo:"synthetic",version:"v1",page:1,start:0,text:"【藥理作用】請參閱(請參見"+quote};
    const base={status:"supported" as const,claims:[{category:"warning" as const,text:"舊分類警語",citations:[{chunkId:chunk.id,quote}]}],chunks:[chunk],quiz:[],followups:[],rejectedCount:0,sourceVersions:{},verification:"model_assisted" as const};
    expect(sourceFieldClassificationOutdated(base)).toBe(true);
    expect(sourceFieldClassificationOutdated({...base,chunks:[{...chunk,text:quote}]})).toBe(false);
    expect(sourceFieldClassificationOutdated({...base,claims:[{...base.claims[0],category:"purpose"}]})).toBe(false);
    expect(sourceFieldClassificationOutdated({...base,chunks:[]})).toBe(false);
    for(const malformed of [{chunks:{}},{chunks:[null],claims:[null],quiz:[null]},{...base,claims:[{category:"warning",citations:null}]}])
      expect(()=>sourceFieldClassificationOutdated(malformed as any)).not.toThrow();
    expect(sourceActionResultOutdated({...base,claims:[{text:"broken"}]} as any)).toBe(true);
    expect(sourceActionResultOutdated({status:"succeeded",medications:[]} as any)).toBe(false);
  });
  it("selectively flags saved ambiguous questions without expiring clear ones", () => {
    const base = {status:"supported" as const, claims:[],chunks:[],followups:[],rejectedCount:0,sourceVersions:{},verification:"model_assisted" as const};
    const quiz = {id:"synthetic",q:"服用本藥可能嗜睡時，哪項符合提醒？",options:[answer,"可以照常駕車或操作危險性機械"],answer:0,explain:source,citations:[{chunkId:"synthetic",quote:source}]};
    expect(sourceActionResultOutdated({...base,quiz:[quiz]})).toBe(true);
    expect(sourceActionResultOutdated({...base,quiz:[{...quiz,q:"服用本藥期間，哪項符合提醒？"}]})).toBe(false);
  });
});
