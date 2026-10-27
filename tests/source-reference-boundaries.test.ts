import { describe, expect, it } from "vitest";
import {
  sourceFieldClassificationOutdated,
  sourcePassages,
} from "../server/ai";
import { passageCitations } from "../server/source-field-spans";
import type { Chunk } from "../shared/schema";

const chunks = (texts: string[]): Chunk[] =>
  texts.map((text, index) => ({
    id: `synthetic-reference-${index}`,
    licenseNo: "SYNTHETIC-REFERENCE-BOUNDARY",
    version: "synthetic-v1",
    page: index + 1,
    start: 0,
    sourceFormat: "pdf",
    text,
  }));

describe("compound and inline references preserve their original field", () => {
  it.each(["參考", "請參見"])(
    "does not hide a genuine next-line heading after the standalone word %s",
    (directive) => {
      const raw = chunks([
        `【藥理特性】合成背景完整。${directive}\n【警語】合成真正警語完整。\n【禁忌】合成真正禁忌完整。`,
      ]);
      const fields = sourcePassages(raw);
      expect(
        fields.filter((field) => field.sourceSection === "警語"),
      ).toHaveLength(1);
      expect(
        fields.filter((field) => field.sourceSection === "禁忌"),
      ).toHaveLength(1);
    },
  );
  it.each([
    "(請參見【警語】及【禁忌】)",
    "（詳見【警語】、【禁忌】）",
    "(參閱【警語】，以及【禁忌】)",
    "(請參考【警語】和【禁忌】)",
    "請參見【警語】",
    "詳見【禁忌】部分",
    "參見【警語】及【禁忌】",
    "請參閱【警語】，以及【禁忌】",
  ])("does not invent a warning field from the reference %s", (reference) => {
    const text = `【藥理特性】合成背景甲${reference}，合成背景乙必須保留。\n【警語】合成真正警語完整。\n【禁忌】合成真正禁忌完整。`;
    const raw = chunks([text]);
    const fields = sourcePassages(raw);
    expect(
      fields.filter((field) => field.sourceSection === "警語"),
    ).toHaveLength(1);
    expect(
      fields.filter((field) => field.sourceSection === "禁忌"),
    ).toHaveLength(1);
    const background = fields
      .filter((field) => field.sourceSection === "藥理特性")
      .map((field) => field.quote)
      .join("");
    expect(background).toContain(
      `合成背景甲${reference}，合成背景乙必須保留。`,
    );
    for (const field of fields)
      for (const citation of passageCitations(field))
        expect(
          raw.find((chunk) => chunk.id === citation.chunkId)!.text,
        ).toContain(citation.quote);
    expect(raw[0].text).toBe(text);
  });

  it("does not silently cut a general-use field at a prose reference", () => {
    const text =
      "【用法用量】合成用法甲，請參見【禁忌】部分並保留合成條件乙。\n【禁忌】合成真正禁忌完整。";
    const fields = sourcePassages(chunks([text]));
    expect(
      fields.filter((field) => field.sourceSection === "禁忌"),
    ).toHaveLength(1);
    expect(
      fields.find((field) => field.sourceSection === "用法用量")!.quote,
    ).toContain("請參見【禁忌】部分並保留合成條件乙。");
  });

  it.each([
    "(請參見【警語】及【禁忌】",
    "（請參見【警語】及【禁忌】)",
    "(請參見【警語】及【禁忌】）",
    "(不明標記【警語】及【禁忌】)",
  ])("keeps a malformed or unknown reference unresolved: %s", (reference) => {
    expect(() =>
      sourcePassages(
        chunks([
          `【警語】合成條件尚未完成${reference}\n【禁忌】合成真正禁忌完整。`,
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "source_requires_review" }));
  });

  it("keeps real adjacent headings distinct", () => {
    const fields = sourcePassages(
      chunks(["【警語】合成真正警語完整。【禁忌】合成真正禁忌完整。"]),
    );
    expect(fields.map((field) => field.sourceSection)).toEqual([
      "警語",
      "禁忌",
    ]);
  });

  it("preserves a complete compound reference across consecutive original pages", () => {
    const raw = chunks([
      "【警語】合成條件甲(請參見【禁忌】及",
      "【交互作用】)，仍須保留合成條件乙。\n【禁忌】合成真正禁忌完整。",
    ]);
    const warning = sourcePassages(raw).find(
      (field) => field.sourceSection === "警語",
    )!;
    expect(passageCitations(warning)).toEqual([
      { chunkId: raw[0].id, quote: raw[0].text },
      { chunkId: raw[1].id, quote: "【交互作用】)，仍須保留合成條件乙。\n" },
    ]);
    expect(() => sourcePassages([raw[0], { ...raw[1], page: 3 }])).toThrowError(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });

  it.each(["請參見【禁忌】", "(請參見【警語】及【禁忌】)"])(
    "selectively retires a cached warning invented from %s",
    (reference) => {
      const text = `【藥理特性】合成背景甲${reference}部分並保留合成條件乙。`;
      const quote = reference.includes("及")
        ? "【禁忌】)部分並保留合成條件乙。"
        : "【禁忌】部分並保留合成條件乙。";
      const raw = chunks([text]);
      const result = {
        chunks: raw,
        claims: [
          {
            category: "warning",
            text: "合成舊分類",
            citations: [{ chunkId: raw[0].id, quote }],
          },
        ],
        quiz: [],
      };
      expect(sourceFieldClassificationOutdated(result as any)).toBe(true);
    },
  );

  it("does not retire a citation that also matches a genuine warning field", () => {
    const quote = "【禁忌】合成完整禁忌。";
    const raw = chunks([`【藥理特性】請參見${quote}\n${quote}`]);
    const result = {
      chunks: raw,
      claims: [
        {
          category: "warning",
          text: "合成舊分類",
          citations: [{ chunkId: raw[0].id, quote }],
        },
      ],
      quiz: [],
    };
    expect(sourceFieldClassificationOutdated(result as any)).toBe(false);
  });
});
