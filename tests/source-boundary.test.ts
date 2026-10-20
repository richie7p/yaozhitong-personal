import { describe, expect, it } from "vitest";
import { completeWarningCitations } from "../server/source-boundary";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import type { Chunk, Claim } from "../shared/schema";

const warning =
  "【警語】發生合成症狀甲及合成症狀乙時，應注意。如果出現這些症狀，請依合成來源處理。";
const text = "【適應症】緩解合成症狀丙。" + warning + "【包裝】合成包裝資料。";
const chunk: Chunk = {
  id: "synthetic-page",
  licenseNo: "SYNTHETIC-LICENSE",
  version: "literal-v1",
  page: 1,
  start: 0,
  text,
};
const passages = sourcePassages([chunk]);
const sections = new Set(["警語", "附記"]);
const claim = (
  quote: string,
  category: Claim["category"] = "warning",
): Claim => ({
  text: quote,
  category,
  citations: [{ chunkId: chunk.id, quote }],
});
const check = (value: Claim) =>
  completeWarningCitations(value, [chunk], passages, sections);

describe("complete warning citation boundaries", () => {
  it("accepts the full warning and its full body without a decorative heading", () => {
    expect(check(claim(warning))).toBe(true);
    expect(check(claim(warning.replace("【警語】", "")))).toBe(true);
  });
  it.each(["warning", "other", undefined] as const)(
    "rejects an isolated symptom reference even with category %s",
    (category) => {
      const value = claim("如果出現這些症狀，請依合成來源處理。");
      value.category = category;
      expect(check(value)).toBe(false);
    },
  );
  it("rejects a quote crossing into only part of a warning", () => {
    expect(
      check(
        claim(
          "緩解合成症狀丙。【警語】發生合成症狀甲及合成症狀乙時，應注意。",
          "other",
        ),
      ),
    ).toBe(false);
  });
  it("keeps a complete unrelated purpose usable", () => {
    expect(check(claim("【適應症】緩解合成症狀丙。", "purpose"))).toBe(true);
  });
  it("accepts whole warning bodies with typographic spacing and normalization", () => {
    expect(
      check(claim(warning.replace("【警語】", "").replaceAll("。", "。\n "))),
    ).toBe(true);
  });
  it("requires every citation to preserve its warning boundary", () => {
    const value = claim(warning);
    value.citations.push({
      chunkId: chunk.id,
      quote: "如果出現這些症狀，請依合成來源處理。",
    });
    expect(check(value)).toBe(false);
  });
  it("rejects missing or noncanonical references", () => {
    const value = claim(warning);
    value.citations[0].chunkId = "missing";
    expect(check(value)).toBe(false);
    expect(check(claim("來源沒有記載的合成安全結論。"))).toBe(false);
  });
  it("retains a complete unlabelled legacy warning and rejects a partial quote", () => {
    const legacy = { ...chunk, text: "合成條件甲成立時，請遵守合成注意事項。" };
    const sources = sourcePassages([legacy]);
    expect(
      completeWarningCitations(claim(legacy.text), [legacy], sources, sections),
    ).toBe(true);
    expect(
      completeWarningCitations(
        claim("請遵守合成注意事項。"),
        [legacy],
        sources,
        sections,
      ),
    ).toBe(false);
  });
  it("does not publish a direct-quote bypass even when the model reviewer agrees", async () => {
    let reviewCalled = false;
    const llm: Llm = {
      json: async (system, input: any) => {
        if (system.includes("審核器")) {
          reviewCalled = true;
          return {
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: true,
            })),
          };
        }
        return {
          status: "supported",
          claims: [claim("如果出現這些症狀，請依合成來源處理。", "other")],
          quiz: [],
          followups: [],
        };
      },
    };
    const result = await grounded(llm, "合成來源驗收", [chunk], {}, "bundle");
    expect(
      result.claims.some(
        (claim) => claim.text === "如果出現這些症狀，請依合成來源處理。",
      ),
    ).toBe(false);
    expect(
      result.claims.every((claim) => claim.kind?.startsWith("source_exact_")),
    ).toBe(true);
    expect(
      result.claims.find((claim) => claim.category === "warning")?.citations,
    ).toEqual([
      {
        chunkId: chunk.id,
        quote: passages.find((p) => p.sourceSection === "警語")!.quote,
      },
    ]);
    expect(result.quiz.every((q) => q.id.startsWith("purpose-"))).toBe(true);
    expect(reviewCalled).toBe(false);
    expect(result.rejectedCount).toBe(1);
  });
});
