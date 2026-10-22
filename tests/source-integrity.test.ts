import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { citationsValid, grounded, sourcePassages } from "../server/ai";
import type { Chunk } from "../shared/schema";

// Frozen original PDF text (040161) and independently checked full-page visual
// transcription (030418). Each fixture retains its official URL and PDF hash.
// These are software source-integrity regressions, not clinical approval.
function originalPage(license: string): Chunk {
  const source = JSON.parse(
    readFileSync(
      new URL(`./fixtures/source-integrity/${license}.json`, import.meta.url),
      "utf8",
    ),
  );
  return {
    id: `original-page-${license}`,
    licenseNo: source.licenseNo,
    version: source.version,
    page: source.page,
    start: 0,
    text: source.text,
  };
}
const syntheticPage = (text: string): Chunk => ({
  id: "synthetic-integrity",
  licenseNo: "SYNTHETIC-INTEGRITY",
  version: "test-v1",
  page: 1,
  start: 0,
  text,
});
const compact = (text: string) => text.normalize("NFKC").replace(/\s/g, "");

describe("complete atomic warning source passages", () => {
  it("keeps the real Anti-phen cross-1000 liver warning and symptom antecedents whole", () => {
    const page = originalPage("040161");
    expect(page.text).toHaveLength(2951);
    expect(page.text.slice(0, 1000)).toMatch(/大部份發$/u);
    const passages = sourcePassages([page]);
    const warnings = passages.filter(
      (source) => source.sourceSection === "警語",
    );
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    expect(warning.quote).toHaveLength(1249);
    expect(compact(warning.quote)).toContain(
      "大部份發生肝臟損害之病例係因使用超過每日4,000毫克",
    );
    expect(compact(warning.quote)).toContain(
      "臨床表徵包括臉、口及喉嚨腫脹、呼吸窘迫、蕁麻疹、皮疹、搔癢以及嘔吐",
    );
    expect(compact(warning.quote)).toContain("如果發生這些症狀");
    expect(warning.quote).toContain("酒精警語");
    expect(compact(warning.quote)).toContain("病人應瞭解並被告知嚴重皮膚反應");
    expect(warning.quote).not.toContain("過   量：");
    expect(
      passages.filter((source) => source.sourceSection === "過量").length,
    ).toBeGreaterThan(0);
    expect(passages.map((source) => source.quote).join("")).toBe(page.text);
  });

  it("keeps real Bubdel parent lists and inline 酒精警語 in the original field", () => {
    const page = originalPage("030418");
    const passages = sourcePassages([page]);
    const usage = passages.filter(
      (source) => source.sourceSection === "使用上注意事項",
    );
    const warnings = passages.filter(
      (source) => source.sourceSection === "警語",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].quote).toHaveLength(486);
    expect(usage[0].quote).toContain("一、有下列情形者，請勿使用");
    expect(usage[0].quote).toContain("四、其他使用上注意事項");
    expect(usage[0].quote).toContain("5. 酒精警語");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].quote).toContain("若有發生以下副作用");
    expect(warnings[0].quote).toContain("皮膚\t發疹、發紅");
    expect(warnings[0].quote).toContain("臉、口及喉嚨腫脹");
    expect(passages.map((source) => source.quote).join("")).toBe(page.text);
  });

  it("does not prepend an unusably short prior field to an atomic warning", () => {
    const page = syntheticPage(
      "效能：甲。\n警語：若出現合成症狀，請洽醫師。\n包裝：合成包裝。",
    );
    const warning = sourcePassages([page]).find(
      (source) => source.sourceSection === "警語",
    )!;
    expect(warning.quote).toBe("警語：若出現合成症狀，請洽醫師。\n");
    expect(warning.quote).not.toContain("效能");
  });

  it("keeps real Kemelon dotted use heading out of purpose and numbered side effects inside the warning field", () => {
    const page = originalPage("039632");
    const passages = sourcePassages([page]);
    const use = passages.filter(
      (source) => source.sourceSection === "用法用量",
    );
    expect(use.some((source) => source.quote.includes("【用法‧用量】"))).toBe(
      true,
    );
    expect(
      passages
        .filter((source) => source.sourceSection === "適應症")
        .every((source) => !source.quote.includes("每天早、晚")),
    ).toBe(true);
    const warnings = passages.filter(
      (source) => source.sourceSection === "注意事項",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].quote).toContain("2.   【副作用】");
    expect(warnings[0].quote).toContain("3.   妊孕婦女");
    expect(warnings[0].quote).toContain("除非在治療上有益性之場合方得使用");
    expect(passages.some((source) => source.sourceSection === "副作用")).toBe(
      false,
    );
  });

  it("preserves a real complete seven-character purpose without borrowing a dosing field", () => {
    const page = originalPage("026087");
    const purpose = sourcePassages([page]).filter(
      (source) => source.sourceSection === "適應症",
    );
    expect(purpose).toHaveLength(1);
    expect(compact(purpose[0].quote)).toBe("適應症:袪痰。");
    expect(purpose[0].quote).not.toContain("用法用量");
    expect(
      citationsValid(
        {
          text: "袪痰",
          citations: [{ chunkId: page.id, quote: purpose[0].quote }],
        },
        [page],
      ),
    ).toBe(true);
    const partial = syntheticPage("適應症：袪痰。其他原文資訊。");
    expect(
      citationsValid(
        {
          text: "袪痰",
          citations: [{ chunkId: partial.id, quote: "適應症：袪痰。" }],
        },
        [partial],
      ),
    ).toBe(false);
    const unlabelled = syntheticPage("合成七字原文。");
    expect(
      citationsValid(
        {
          text: "合成",
          citations: [{ chunkId: unlabelled.id, quote: unlabelled.text }],
        },
        [unlabelled],
      ),
    ).toBe(false);
  });

  it.each([
    [
      "source budget exceeded",
      "警語：" + "合成症狀".repeat(5500) + "請洽醫師。",
    ],
    ["unfinished", "警語：若有合成症狀，可能發生其他未完整"],
    [
      "original old 1000-character boundary",
      originalPage("040161").text.slice(0, 1000),
    ],
  ])(
    "refuses a %s warning before any model call instead of cropping it",
    async (_name, text) => {
      let calls = 0;
      await expect(
        grounded(
          {
            json: async () => {
              calls++;
              throw Error("must not call");
            },
          },
          "仿單用途與警語",
          [syntheticPage(text)],
          {},
          "bundle",
        ),
      ).rejects.toMatchObject({ code: "source_requires_review" });
      expect(calls).toBe(0);
    },
  );
});
