import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { citationsValid, sourcePassages } from "../server/ai";
import { passageCitations } from "../server/source-field-spans";
import { completeSafetyLearning } from "../server/safety-learning";
import type { Chunk } from "../shared/schema";

const chunks = (texts: string[]): Chunk[] =>
  texts.map((text, index) => ({
    id: `synthetic-heading-${index}`,
    licenseNo: "SYNTHETIC-HEADING-BOUNDARY",
    version: "synthetic-v1",
    page: index + 1,
    start: 0,
    sourceFormat: "pdf",
    text,
  }));
const originals: { licenseNo: string; chunks: Chunk[] }[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/source-heading-boundaries.json", import.meta.url),
    "utf8",
  ),
);
const held = (raw: Chunk[]) =>
  expect(() => sourcePassages(raw)).toThrowError(
    expect.objectContaining({ code: "source_requires_review" }),
  );

describe("source heading scope and closed structural containers", () => {
  it("keeps a pharmacology cross-reference out of the warning-field inventory", () => {
    const raw = chunks([
      "5 警語及注意事項\n合成主警語原文必須保留。\n10 藥理特性\n合成作用敘述(參閱【警語及注意事項】)，仍為合成作用的內容。\n13 包裝\n合成包裝。",
    ]);
    const passages = sourcePassages(raw);
    expect(
      passages.filter((p) => p.sourceSection === "警語及注意事項"),
    ).toHaveLength(1);
    const background = passages.find((p) => p.quote.includes("合成作用敘述"))!;
    expect(background.sourceSection).toBe("藥理特性");
    expect(background.originalFieldId).toBeUndefined();
    expect(background.quote).toContain("(參閱【警語及注意事項】)");
  });
  it.each([
    "(請參見【警語】)",
    "（參閱【警語】）",
    "(詳見【警語】)",
    "（請參考【警語】）",
  ])(
    "retains the balanced explicit reference %s inside the complete original field",
    (reference) => {
      const text = `3 使用上注意事項\n合成父條件甲成立時${reference}，仍需保留合成條件乙。\n5 警語\n合成其他警語不得省略。\n13 包裝\n合成包裝。`;
      const raw = chunks([text]),
        passages = sourcePassages(raw);
      const field = passages.find((p) => p.sourceSection === "使用上注意事項")!;
      expect(field.quote).toContain(`${reference}，仍需保留合成條件乙。`);
      expect(passages.filter((p) => p.sourceSection === "警語")).toHaveLength(
        1,
      );
      expect(passageCitations(field)).toEqual([
        { chunkId: raw[0].id, quote: field.quote },
      ]);
      expect(
        citationsValid(
          {
            text: "合成來源測試",
            category: "warning",
            citations: passageCitations(field),
          },
          raw,
          passages,
        ),
      ).toBe(true);
      expect(raw[0].text).toBe(text);
    },
  );
  it.each([
    "(請參見【警語】",
    "（請參見【警語】)",
    "(請參見【警語】）",
    "(請參見【警語",
    "(不明標記【警語】)",
  ])(
    "does not repair or reinterpret an unfinished or unrecognized reference %s",
    (reference) => {
      held(
        chunks([
          `【使用上注意事項】合成條件尚未完成${reference}\n【警語】合成完整警語。\n【包裝】合成包裝。`,
        ]),
      );
    },
  );
  it("still requires a complete containing field after a valid reference", () => {
    held(
      chunks([
        "【警語】合成條件甲(請參見【禁忌】)以及尚未完成的\n【禁忌】合成條件乙不得使用。",
      ]),
    );
    held(chunks(["【警語】合成完整條件。\n16.\n【禁忌】合成條件乙不得使用。"]));
  });
  it("does not turn a real bracketed heading into a reference", () => {
    const raw = chunks([
      "【警語】合成完整警語。\n【禁忌】合成條件乙不得使用。",
    ]);
    expect(
      sourcePassages(raw)
        .filter((p) => p.originalFieldId)
        .map((p) => p.sourceSection),
    ).toEqual(["警語", "禁忌"]);
    held(chunks(["【警語】合成尚未完成的\n【禁忌】合成條件乙不得使用。"]));
  });
  it("preserves a reference across verified consecutive pages without dropping its condition", () => {
    const raw = chunks([
      "【警語】合成父條件甲(請參見",
      "【禁忌】)，仍須保留合成條件乙。\n【禁忌】合成條件丙不得使用。",
    ]);
    const field = sourcePassages(raw).find((p) => p.sourceSection === "警語")!;
    expect(passageCitations(field)).toEqual([
      { chunkId: raw[0].id, quote: raw[0].text },
      { chunkId: raw[1].id, quote: "【禁忌】)，仍須保留合成條件乙。\n" },
    ]);
    held([{ ...raw[0] }, { ...raw[1], page: 3 }]);
    held([{ ...raw[0] }, { ...raw[1], version: "different" }]);
  });
  it.each(["", "(依文獻記載)\n"])(
    "keeps the empty numbered child container literal (%s)",
    (prefix) => {
      const raw = chunks([
        `5 警語及注意事項\n${prefix}5.1 警語/注意事項\n【注意事項】：合成條件成立時不得省略。\n7 交互作用\n目前尚無資訊。`,
      ]);
      const passages = sourcePassages(raw),
        container = passages.find((p) => p.sourceSection === "警語及注意事項")!;
      expect(container.evidenceKind).toBe("structural_container");
      expect(container.quote).toBe(
        `5 警語及注意事項\n${prefix}5.1 警語/注意事項\n`,
      );
      expect(
        completeSafetyLearning({ claims: [], quiz: [] }, passages).claims.some(
          (c) => c.text === container.quote.trim(),
        ),
      ).toBe(false);
    },
  );
  it.each([
    "6.1 警語/注意事項",
    "5.2 警語/注意事項",
    "5.1 警語/注意",
    "5.1 警語/注意事項\n合成未完成條件",
    "5.1 警語/注意事項\n女",
    "(其他未知標記)\n5.1 警語/注意事項",
  ])("keeps a mismatched, partial, or populated child held (%s)", (body) => {
    held(
      chunks([
        `5 警語及注意事項\n${body}\n【注意事項】合成完整條件。\n7 交互作用\n目前尚無資訊。`,
      ]),
    );
  });
  it("requires a verified following safety heading and a single page for a structural container", () => {
    held(chunks(["5 警語及注意事項\n5.1 警語/注意事項"]));
    held(chunks(["5 警語及注意事項\n5.1 警語/注意事項\n13 包裝\n合成包裝。"]));
    held(
      chunks([
        "5 警語及注意事項\n",
        "5.1 警語/注意事項\n【注意事項】合成完整條件。",
      ]),
    );
  });
  it.each([
    "【目前尚無資訊】",
    "《依文獻記載》\n目前尚無資訊",
    "(依文獻記載) 無",
  ])("retains the exact closed whole-field absence marker %s", (body) => {
    const raw = chunks([`【過量】${body}\n【包裝】合成包裝。`]);
    const field = sourcePassages(raw).find((p) => p.sourceSection === "過量")!;
    expect(field.evidenceKind).toBe("literal_unavailable");
    expect(field.quote).toBe(`【過量】${body}\n`);
  });
  it("requires every contiguous numbered child to explicitly state absence", () => {
    const body =
      "8.1 臨床重要副作用/不良反應\n目前尚無資訊\n8.2 臨床試驗經驗\n目前尚無資訊\n8.3 上市後經驗\n【目前尚無資訊】";
    const raw = chunks([`8 副作用/不良反應\n${body}\n9 過量\n目前尚無資訊。`]);
    const field = sourcePassages(raw).find(
      (p) => p.sourceSection === "副作用/不良反應",
    )!;
    expect(field.evidenceKind).toBe("literal_unavailable");
    expect(passageCitations(field)[0].quote).toBe(`8 副作用/不良反應\n${body}`);
    // Even a complete medical prefix cannot be hidden as an absence marker.
    for (const prefix of ["合成完整條件必須保留。\n", "合成尚未完成條件\n"])
      held(
        chunks([`8 副作用/不良反應\n${prefix}${body}\n9 過量\n目前尚無資訊。`]),
      );
  });
  it.each([
    "8.2 臨床試驗經驗\n目前尚無資訊",
    "8.1 臨床重要副作用/不良反應\n目前尚無資訊\n8.3 上市後經驗\n目前尚無資訊",
    "8.1 臨床重要副作用/不良反應\n目前尚無資訊\n8.1 臨床試驗經驗\n目前尚無資訊",
    "7.1 臨床重要副作用/不良反應\n目前尚無資訊",
    "8.1 未知的子欄\n目前尚無資訊",
    "8.1 臨床重要副作用/不良反應\n目前尚無資訊\n8.2 臨床試驗經驗",
    "8.1 臨床重要副作用/不良反應\n目前尚無資訊\n8.2 臨床試驗經驗\n合成條件尚未完成",
    "8.1 臨床重要副作用/不良反應\n目前尚無資訊\n合成條件乙必須保留",
  ])("keeps malformed or populated absence trees held (%s)", (body) => {
    held(chunks([`8 副作用/不良反應\n${body}\n9 過量\n目前尚無資訊。`]));
  });
  it.each([
    "【目前尚無資訊",
    "目前尚無資訊】",
    "《依文獻記載》目前尚無資訊且",
    "【目前尚無資訊】但合成條件尚未完成",
  ])(
    "does not complete an unbalanced or qualified absence marker %s",
    (body) => {
      held(chunks([`【過量】${body}\n【包裝】合成包裝。`]));
    },
  );
  it("recovers the complete already-published official reference and structural-container fixtures", () => {
    for (const original of originals) {
      const raw = structuredClone(original.chunks),
        before = JSON.stringify(raw),
        passages = sourcePassages(raw);
      for (const passage of passages)
        for (const citation of passageCitations(passage))
          expect(raw.find((c) => c.id === citation.chunkId)!.text).toContain(
            citation.quote,
          );
      expect(JSON.stringify(raw)).toBe(before);
      if (original.licenseNo.includes("034869")) {
        const field = passages.find(
          (p) => p.sourceSection === "使用上注意事項",
        )!;
        expect(field.quote).toContain("(請參見【警語】)");
        expect(field.quote).toContain("3.3");
      }
    }
  });
});
