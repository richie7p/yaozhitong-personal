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
  expect(text).toContain("白話整理 1／2 個安全欄位");
  expect(text).toContain("每題只抽查一個重點");
  expect(text).toContain("尚未完整整理：注意事項");
  expect(text).toContain("模型輔助核對");
  expect(text).toContain("下方已整理部分重點");
});
