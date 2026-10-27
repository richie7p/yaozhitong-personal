import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PlainLanguageStatus } from "../src/PlainLanguageStatus";
import type { GroundedResult } from "../shared/schema";
const result: GroundedResult = {
  status: "supported",
  claims: [],
  quiz: [],
  followups: [],
  chunks: [],
  sourceVersions: {},
  verification: "model_assisted",
  rejectedCount: 0,
};
it("does not label original-only reading as completed plain-language content", () => {
  expect(
    renderToStaticMarkup(createElement(PlainLanguageStatus, { result })),
  ).toBe("");
});
it("distinguishes full-field explanation from a one-key-point quiz and partial fields", () => {
  const value: GroundedResult = {
    ...result,
    plainLanguageCoverage: {
      scope: "recognized_source_fields",
      status: "partial",
      fields: [
        {
          fieldId: "a",
          licenseNo: "synthetic",
          sourceSection: "警語",
          sourceSpanCount: 2,
          explainedSpanCount: 2,
          status: "complete",
          claimIndices: [0],
          quizIds: ["q1"],
        },
        {
          fieldId: "b",
          licenseNo: "synthetic",
          sourceSection: "注意事項",
          sourceSpanCount: 3,
          explainedSpanCount: 1,
          status: "partial",
          claimIndices: [1],
          quizIds: [],
        },
      ],
    },
  };
  const text = renderToStaticMarkup(
    createElement(PlainLanguageStatus, { result: value }),
  );
  expect(text).toContain("已辨識欄位：1／2 完成白話整理");
  expect(text).toContain("每題只抽查一個重點");
  expect(text).toContain("尚未完整整理：注意事項");
  expect(text).toContain("模型輔助核對");
  expect(text).toContain("下方已整理部分重點");
});
it("explains a failed source recheck and a cosmetic carry without claiming fresh completion",()=>{
  const fields=[{fieldId:"a",licenseNo:"synthetic",sourceSection:"警語",sourceSpanCount:2,explainedSpanCount:1,status:"partial" as const,claimIndices:[],quizIds:[],reason:"reverification_failed" as const},
    {fieldId:"b",licenseNo:"synthetic",sourceSection:"注意事項",sourceSpanCount:2,explainedSpanCount:1,status:"partial" as const,claimIndices:[],quizIds:[],retainedAfterRecheck:true}];
  const text=renderToStaticMarkup(createElement(PlainLanguageStatus,{result:{...result,plainLanguageCoverage:{scope:"recognized_source_fields",status:"partial",fields}}}));
  expect(text).toContain("重新核對未通過");
  expect(text).toContain("已保留先前核對的說明與測驗");
  expect(text).toContain("已辨識欄位：0／2 完成白話整理");
});
it("reports a no-progress paid completion honestly while retaining the old record",()=>{
  const value:GroundedResult={...result,plainLanguageCoverage:{scope:"recognized_source_fields",status:"partial",
    progressFromPrevious:{additionalExplainedSpans:0,additionalQuiz:0,lostExplainedSpans:0},
    fields:[{fieldId:"a",licenseNo:"synthetic",sourceSection:"警語",sourceSpanCount:2,explainedSpanCount:1,status:"partial",claimIndices:[],quizIds:[]}]}};
  const text=renderToStaticMarkup(createElement(PlainLanguageStatus,{result:value}));
  expect(text).toContain("這次尚未增加可確認");
  expect(text).toContain("原學習與作答紀錄仍保留");
  expect(text).not.toContain("這次已補充");
});
