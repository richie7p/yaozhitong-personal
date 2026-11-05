import { expect, it, vi } from "vitest";
import { assisted } from "../server/assistance";
import type { Drug, Medication } from "../shared/schema";
import type { ReferencePassage } from "../shared/assistance";

const drug: Drug = {
  licenseNo: "SYNTHETIC-EYE", nameZh: "合成測試眼藥", nameEn: "Synthetic eye medicine",
  strength: "", form: "眼藥膏", ingredients: ["SYNTHETIC"], revoked: false,
};
const med = { id: "synthetic", name: drug.nameZh, licenseNo: drug.licenseNo, confirmed: false } as Medication;
const longBlock = "這是合成中文 PDF 測試原文，條件與例外必須完整保留，不是醫療建議。".repeat(80);
const warning = "使用注意：這是合成眼藥的測試資料。僅在條件甲成立時適用，若出現條件乙，須洽詢醫療人員。";
const original = "合成測試眼藥\r\n完整原文首段，包含適用範圍。\r\n\r\n" + longBlock + "\n\n" + warning;
const secondary = "另一來源的完整測試文字，不可冒充第一來源的原文依據。";
const passages: ReferencePassage[] = [
  { text: original, sourceIds: ["web-1"] },
  { text: secondary, sourceIds: ["web-2"] },
];
const claim = (evidenceIds: unknown = ["reference-1-3"], extra: object = {}) => ({
  text: "使用注意：合成眼藥僅在條件甲成立時適用；出現條件乙須洽詢醫療人員。",
  basis: "reference", sourceIds: ["web-1"], evidenceIds, ...extra,
});
async function run(claims: unknown[], review: unknown = { decisions: [{ id: "0", supported: true }] }, sourcePassages = passages) {
  const json = vi.fn(async (_prompt: string, context: any) => context.expectedIds
    ? review : { status: "answered", claims });
  const result = await assisted({ json, searchReferences: async () => ({
    state: "found", sources: [
      { id: "web-1", title: "第一合成來源", url: "https://www.cth.org.tw/synthetic-eye", kind: "hospital" },
      { id: "web-2", title: "第二合成來源", url: "https://www.ntuh.gov.tw/synthetic-eye", kind: "hospital" },
    ], passages: sourcePassages,
  }) }, "請說明一般用途與使用注意。", [med], [drug], [null]);
  return { result, json };
}

it("selects Chinese PDF evidence by stable ID without retyping it, retaining every original character and condition", async () => {
  const { result, json } = await run([claim()]);
  expect(result.assistance?.claims).toEqual([{
    text: claim().text, basis: "reference", sourceIds: ["web-1"],
  }]);
  expect(json).toHaveBeenCalledTimes(2);
  const generation = json.mock.calls[0][1], review = json.mock.calls[1][1];
  const firstSegments = generation.references.filter((r: any) => r.sourceIds.includes("web-1"));
  expect(firstSegments.map((r: any) => r.text).join("")).toBe(original);
  expect(firstSegments.map((r: any) => r.id)).toEqual(["reference-1-1", "reference-1-2", "reference-1-3"]);
  expect(firstSegments[1].text).toBe(longBlock + "\n\n");
  expect(firstSegments[1].text.length).toBeGreaterThan(1800); // An atomic block is never clipped.
  expect(review.references).toEqual(generation.references);
  expect(review.claims[0].evidenceIds).toEqual(["reference-1-3"]);
  expect(review.claims[0].evidenceQuotes).toEqual([]);
  expect(review.references.find((r: any) => r.id === "reference-1-3").text).toBe(warning);
  expect(result.assistance?.validation).toEqual({
    proposedReferenceClaims: 1, evidenceRejected: 0, submittedToReview: 1,
    reviewRejected: 0, acceptedReferenceClaims: 1, reviewContractInvalid: false,
  });
  expect(json.mock.calls[0][0]).toContain("新回答請留空");
  expect(json.mock.calls[1][0]).toContain("有效 id 或引文存在不代表解讀正確");
});

it.each([
  ["unknown", ["reference-99-1"]],
  ["valid plus unknown", ["reference-1-3", "reference-99-1"]],
  ["duplicate", ["reference-1-3", "reference-1-3"]],
  ["other source", ["reference-2-1"]],
  ["valid plus other source", ["reference-1-3", "reference-2-1"]],
  ["no evidence", []],
])("rejects %s evidence before independent review", async (_name, evidenceIds) => {
  const { result, json } = await run([claim(evidenceIds)]);
  expect(result.assistance?.claims).toEqual([]);
  expect(result.rejectedCount).toBe(1);
  expect(result.assistance?.validation).toMatchObject({ evidenceRejected: 1, submittedToReview: 0 });
  expect(json).toHaveBeenCalledTimes(1);
});

it.each([null, "reference-1-3", [1], [""], Array.from({ length: 13 }, () => "reference-1-3")])(
  "rejects malformed evidence identifiers: %j", async (ids) => {
    const { result, json } = await run([claim(ids)]);
    expect(result.assistance?.claims).toEqual([]);
    expect(json).toHaveBeenCalledTimes(1);
  },
);

it("requires evidence for every declared source", async () => {
  const { result, json } = await run([claim(["reference-1-3"], { sourceIds: ["web-1", "web-2"] })]);
  expect(result.assistance?.claims).toEqual([]);
  expect(json).toHaveBeenCalledTimes(1);
});

it.each([
  { sourceId: "web-1", quote: "原文沒有這段聲稱可自行增加用量的虛構文字。" },
  { sourceId: "web-2", quote: secondary },
  { sourceId: "unknown", quote: warning },
])("cannot hide an invalid extra quote behind a valid segment ID", async (quote) => {
  const { result, json } = await run([claim(["reference-1-3"], { evidenceQuotes: [quote] })]);
  expect(result.assistance?.claims).toEqual([]);
  expect(json).toHaveBeenCalledTimes(1);
});

it("retains valid legacy quotations and checks every supplied quote", async () => {
  const valid = { sourceId: "web-1", quote: warning };
  const accepted = await run([claim([], { evidenceQuotes: [valid] })]);
  expect(accepted.result.assistance?.claims).toHaveLength(1);
  const rejected = await run([claim([], { evidenceQuotes: [valid, { sourceId: "web-1", quote: "這段額外的合成引文不在任何來源原文內。" }] })]);
  expect(rejected.result.assistance?.claims).toEqual([]);
  expect(rejected.json).toHaveBeenCalledTimes(1);
});

it("still withholds a claim when the independent reviewer rejects its interpretation", async () => {
  const { result, json } = await run([claim()], { decisions: [{ id: "0", supported: false }] });
  expect(json).toHaveBeenCalledTimes(2);
  expect(result.assistance?.claims).toEqual([]);
  expect(result.assistance?.validation).toMatchObject({ evidenceRejected: 0, submittedToReview: 1, reviewRejected: 1, acceptedReferenceClaims: 0 });
});

it.each([
  { decisions: [] },
  { decisions: [{ id: "unrequested", supported: true }] },
  { decisions: [{ id: "0", supported: true }, { id: "unrequested", supported: true }] },
  { decisions: [{ id: "0", supported: true }, { id: "0", supported: true }] },
])("does not accept missing, unknown or duplicate reviewer decisions", async (review) => {
  const { result } = await run([claim()], review);
  expect(result.assistance?.claims).toEqual([]);
  expect(result.assistance?.validation?.reviewContractInvalid).toBe(true);
});

it("resolves evidence only against the current complete context", async () => {
  const { result, json } = await run([claim()], undefined, [{ text: warning, sourceIds: ["web-1"] }]);
  expect(json.mock.calls[0][1].references[0].id).toBe("reference-1-1");
  expect(result.assistance?.claims).toEqual([]); // The old reference-1-3 is absent now.
});

it("does not split or discard intervening blank lines while packing small source blocks", async () => {
  const text = "原文段落甲包含合成條件。\r\n\r\n原文段落乙包含合成例外。\n \n\n最後完整段落。\n";
  const { json } = await run([claim(["reference-1-1"])], undefined, [{ text, sourceIds: ["web-1"] }]);
  expect(json.mock.calls[0][1].references).toEqual([{ id: "reference-1-1", text, sourceIds: ["web-1"] }]);
});
