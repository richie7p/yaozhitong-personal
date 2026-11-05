import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { GroundedResult, Medication } from "../shared/schema";
import {
  MedicationEducation,
  medicationEducationTopics,
} from "../src/MedicationEducation";
import { Evidence } from "../src/Evidence";

const empty: GroundedResult = {
  status: "supported",
  claims: [],
  quiz: [],
  followups: [],
  chunks: [],
  sourceVersions: {},
  verification: "model_assisted",
  rejectedCount: 0,
};
const citation = { chunkId: "synthetic", quote: "合成測試文字" };
const medicine = {
  id: "synthetic-ointment",
  name: "合成軟膏",
  strength: "1%",
  form: "軟膏劑",
  confirmed: false,
  doseAmount: null,
  doseUnit: "",
  frequencyRaw: "",
} as Medication;

it("indexes side effects and storage by source fields, without interpreting claim text", () => {
  const result: GroundedResult = {
    ...empty,
    claims: [
      { text: "合成用途", category: "purpose", citations: [citation] },
      { text: "合成操作", category: "use", citations: [citation] },
      { text: "合成內容甲", category: "warning", citations: [citation] },
      { text: "合成內容乙", category: "warning", citations: [citation] },
      { text: "合成一般提醒", category: "warning", citations: [citation] },
      { text: "沒有依據的副作用字詞", category: "warning", citations: [] },
    ],
    plainLanguageCoverage: {
      scope: "recognized_source_fields",
      status: "partial",
      fields: [
        ["不良反應", [2, 2, 999]],
        ["儲存", [3]],
      ].map(([sourceSection, claimIndices], index) => ({
        fieldId: `field-${index}`,
        licenseNo: "synthetic",
        sourceSection: sourceSection as string,
        sourceSpanCount: 2,
        explainedSpanCount: 1,
        status: "partial" as const,
        claimIndices: claimIndices as number[],
        quizIds: [],
      })),
    },
  };
  expect(
    medicationEducationTopics(result).map((topic) => topic.claimIndices),
  ).toEqual([[0], [1], [4], [2], [3]]);
});

it("does not invent storage or side-effect advice from an ointment name or generic warning", () => {
  const result: GroundedResult = {
    ...empty,
    claims: [{ text: "合成警語", category: "warning", citations: [citation] }],
  };
  const markup = renderToStaticMarkup(
    createElement(MedicationEducation, {
      result,
      medications: [medicine],
      onReadClaim: () => {},
    }),
  );
  expect(markup).toContain("合成軟膏");
  expect(markup).toContain("不需要先填每天使用次數");
  expect(markup.match(/尚無可核對說明/g)).toHaveLength(4);
  expect(markup).toContain("沒有列出某主題，不代表沒有相關風險或限制");
  expect(markup).not.toContain("薄擦");
  expect(markup).not.toContain("每日一次");
});

it("shows education without calling missing personal dosing confirmed", () => {
  const markup = renderToStaticMarkup(
    createElement(Evidence, {
      result: empty,
      medications: [medicine],
      showQuiz: false,
    }),
  );
  expect(markup).toContain("個人用法可稍後補充");
  expect(markup).toContain("仍可閱讀藥品用途與衛教");
  expect(markup).not.toContain("你已確認的用法");
  expect(markup).not.toContain("每次 null");
});

it("shows the complete supported purpose first without dropping its conditions", () => {
  const text = "僅供合成情境甲且符合條件乙的讀者使用；不包含情境丙。";
  const markup = renderToStaticMarkup(createElement(MedicationEducation, {
    result: { ...empty, claims: [{ text, category: "purpose", citations: [citation] }] },
    medications: [medicine], onReadClaim: () => {},
  }));
  expect(markup).toContain(text);
  expect(markup.indexOf(text)).toBeLessThan(markup.indexOf("medication-education-topics"));
  expect(markup).toContain("對照這段用途的依據");
});

it("keeps pending source-review results behind the existing guard", () => {
  const markup = renderToStaticMarkup(
    createElement(Evidence, {
      result: {
        ...empty,
        status: "insufficient_data",
        sourceReview: { reason: "safety_sections_pending", sources: [] },
      },
      medications: [medicine],
    }),
  );
  expect(markup).not.toContain("藥品衛教導覽");
  expect(markup).toContain("個人用法可稍後補充");
});
