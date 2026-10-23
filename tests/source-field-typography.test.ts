import { describe, expect, it } from "vitest";
import type { Chunk } from "../shared/schema";
import { citationsValid, sourcePassages } from "../server/ai";
import { passageCitations } from "../server/source-field-spans";

// Synthetic prose only; no medicine advice, network, model, or cloud requests.
function chunks(text: string[]): Chunk[] {
  return text.map((value, index) => ({ id: `synthetic-typography-${index}`, licenseNo: "衛部藥製字第999972號", version: "synthetic-typography-version", page: index + 1,
    start: 0, text: value, sourceFormat: "pdf" }));
}
describe("source field typography preserves complete original evidence", () => {
  it("classifies halfwidth full stops while leaving original text and citations intact", () => {
    const original = "【警語】僅供合成程式測試，合成條件甲成立時不可跳過條件乙｡\n【包裝】合成包裝。";
    const raw = chunks([original]), source = sourcePassages(raw).find((p) => p.sourceSection === "警語")!;
    expect(source.quote).toContain("條件乙｡");
    expect(source.quote).not.toContain("條件乙。");
    expect(passageCitations(source)[0].quote).toBe(source.quote);
    expect(citationsValid({ text: "合成測試", category: "warning", citations: passageCitations(source) }, raw, [source])).toBe(true);
    expect(raw[0].text).toBe(original);
  });
  it.each(["「目前尚無資訊」", "『尚無資訊』", '"目前尚無資訊"。', "“目前尚無資訊。”", "(依文獻記載)\n目前尚無資訊", "【依文獻記載】\n「目前尚無資訊」"])(
    "recognizes only the whole balanced absence field %s", (body) => {
      const raw = chunks([`【交互作用】${body}\n【包裝】合成包裝。`]);
      const source = sourcePassages(raw).find((p) => p.sourceSection === "交互作用")!;
      expect(source.evidenceKind).toBe("literal_unavailable");
      expect(source.quote).toBe(`【交互作用】${body}\n`);
      expect(passageCitations(source)[0].quote).toBe(source.quote);
      expect(citationsValid({ text: "合成來源目前尚無資訊", category: "warning", citations: passageCitations(source) }, raw, [source])).toBe(true);
      expect(citationsValid({ text: "合成測試", category: "warning", citations: [{ chunkId: raw[0].id, quote: body.includes("目前") ? "目前尚無資訊" : "尚無資訊" }] }, raw, [source])).toBe(false);
    },
  );
  it.each(["「目前尚無資訊", "目前尚無資訊」", "「目前尚無資訊』", "合成條件成立時「目前尚無資訊」", "(合成其他標記)目前尚無資訊", "目前尚無資訊\n16.", "合成表格\t目前尚無資訊"])(
    "keeps incomplete or qualified field %s in review", (body) => {
      expect(() => sourcePassages(chunks([`【禁忌】${body}\n【包裝】合成包裝。`]))).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
    },
  );
  it("does not label an adjacent complete condition or table as absence", () => {
    for (const body of ["目前尚無資訊。合成條件甲成立時仍須保留條件乙。", "(依文獻記載)目前尚無資訊；合成父條件及例外需保留。", "合成表格\t目前尚無資訊。"])
      expect(sourcePassages(chunks([`【警語】${body}\n【包裝】合成包裝。`])).find((p) => p.sourceSection === "警語")?.evidenceKind).not.toBe("literal_unavailable");
  });
  it("keeps dangling fullwidth numbered-item dots and true truncated prose held", () => {
    for (const body of ["合成條件甲成立時不可使用\n１６．", "合成完整條件甲乙以及尚未完成的", "女。"])
      expect(() => sourcePassages(chunks([`【警語】${body}\n【包裝】合成包裝。`]))).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
  });
  it("retains exact cross-page spans but does not merge a short absent marker across pages", () => {
    const raw = chunks(["【警語】合成父條件甲成立時，需要同時", "保留合成例外乙與丙｡\n【包裝】合成包裝。"]);
    const source = sourcePassages(raw).find((p) => p.sourceSection === "警語")!;
    expect(passageCitations(source)).toEqual([{ chunkId: raw[0].id, quote: raw[0].text }, { chunkId: raw[1].id, quote: "保留合成例外乙與丙｡\n" }]);
    expect(source.quote).toContain("丙｡");
    expect(() => sourcePassages(chunks(["【禁忌】「目前尚", "無資訊」\n【包裝】合成包裝。"]))).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
  });
});
