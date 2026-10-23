import { describe, expect, it } from "vitest";
import type { Chunk } from "../shared/schema";
import { citationsValid, sourcePassages } from "../server/ai";

// Synthetic text only. No requests or real medication recommendations.
function source(text: string[], sourceFormat: "pdf" | "html" = "pdf"): Chunk[] {
  return text.map((value, i) => ({ id: `synthetic-exact-span-${i}`, licenseNo: "衛部藥製字第999973號", version: "synthetic-source-exact-v1", page: i + 1, start: 0, text: value, sourceFormat }));
}
describe("non-safety passages conserve literal punctuation and offsets", () => {
  it.each([
    "【適應症】合成用途甲是完整的程式測試句子。。\n合成用途乙仍保留相同文字。\n",
    "【適應症】合成用途甲完整保留！？！？\n合成用途乙也完整保留。。！\n",
    "【用法用量】。。！？合成長句只供程式測試，原始句首符號及換行保留。\n",
    "【適應症】  合成原文包含\t空白與\n換行，保留原樣。。\n\t合成後續長句完整保留！？\n ",
  ])("keeps every emitted passage an exact contiguous original span: %s", (text) => {
    const raw = source([text]), passages = sourcePassages(raw);
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.map((p) => p.quote).join("")).toBe(text);
    for (const passage of passages) {
      const chunk = raw.find((c) => c.id === passage.chunkId)!;
      const start = chunk.text.indexOf(passage.quote);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(chunk.text.slice(start, start + passage.quote.length)).toBe(passage.quote);
      expect(citationsValid({ text: "合成來源核對", citations: [{ chunkId: chunk.id, quote: passage.quote }] }, raw, passages)).toBe(true);
    }
    expect(raw[0].text).toBe(text);
  });
  it("keeps page-specific citation locations across PDF page boundaries", () => {
    const raw = source(["【適應症】合成用途第一頁完整長句。。\n", "合成用途第二頁仍保存原字原順序！？\n"]);
    const passages = sourcePassages(raw);
    expect(new Set(passages.map((p) => p.chunkId)).size).toBe(2);
    for (const passage of passages) expect(raw.find((c) => c.id === passage.chunkId)?.text.includes(passage.quote)).toBe(true);
    expect(passages.map((p) => p.quote).join("")).toBe(raw.map((c) => c.text).join(""));
  });
  it("does not normalize or correct punctuation in the original source", () => {
    const text = "【適應症】合成原文的半形句點｡和重複中文句點。。都必須原樣保留。";
    const passages = sourcePassages(source([text], "html"));
    expect(passages.map((p) => p.quote).join("")).toBe(text);
    expect(passages.some((p) => p.quote.includes("｡"))).toBe(true);
  });
});
