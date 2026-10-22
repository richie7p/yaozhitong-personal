import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import { passageCitations } from "../server/source-field-spans";
import type { Chunk } from "../shared/schema";
import { SOURCE_PAGE_CHAR_LIMIT } from "../shared/source";
import { completeRequestedChatCoverage } from "../server/chat-source-coverage";

const frozenSources: { licenseNo: string; chunks: Chunk[] }[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/cross-page-source-fields.json", import.meta.url),
    "utf8",
  ),
);
const actual = frozenSources.find(
  (source) => source.licenseNo === "衛署藥製字第010332號",
)!;
const actualQuestion =
  "請依仿單說明本藥用途、原文明列的禁用情形及交互作用，逐項附原文依據。請勿推算個人劑量。";
const chunk = (text: string, licenseNo = "SYNTHETIC-COVERAGE"): Chunk => ({
  id: licenseNo,
  licenseNo,
  version: "synthetic-v1",
  page: 1,
  start: 0,
  text,
  sourceFormat: "html",
});
function model(pick: (sources: any[]) => any[], rejectWarnings = false): Llm {
  return {
    json: async (system, input: any) =>
      system.includes("審核器")
        ? {
            verdicts: input.claims.map((c: any) => ({
              id: c.id,
              supported: !rejectWarnings || c.category !== "warning",
            })),
          }
        : {
            status: "supported",
            claims: pick(input.sources),
            quiz: [],
            followups: [],
          },
  };
}
const claim = (source: any, text = source.text) => ({
  text,
  category: source.purposeEligible ? "purpose" : "warning",
  citations: [{ sourceId: source.id }],
});
const purposeOnly = model((sources) => [
  claim(sources.find((source) => source.purposeEligible)),
]);

describe("chat requested safety scope after independent review", () => {
  it.each([
    [
      "衛署藥製字第051528號",
      "請依仿單說明本藥用途，以及 Acetaminophen 用藥過量相關的警語。逐項附原文依據，請勿推算個人劑量。",
      ["警語及注意事項"],
    ],
    [
      "衛署藥製字第018498號",
      "請依仿單說明本藥用途、原文明列的注意事項，以及「身體部位／副作用」表格內容，逐項附原文依據。請勿推算個人劑量。",
      ["使用上注意事項", "警語"],
    ],
  ] as const)(
    "keeps all requested safety fields from the actual %s source when only purpose survives",
    async (licenseNo, question, sections) => {
      const source = frozenSources.find(
        (source) => source.licenseNo === licenseNo,
      )!;
      const result = await grounded(
        purposeOnly,
        question,
        source.chunks,
        {},
        "chat",
      );
      expect(result.status).toBe("insufficient_data");
      expect(
        result.sourceReading?.sections.map((section) => section.sourceSection),
      ).toEqual([...sections]);
      const fields = sourcePassages(source.chunks).filter((field) =>
        (sections as readonly string[]).includes(field.sourceSection || ""),
      );
      expect(
        result.sourceReading?.sections.flatMap((section) => section.citations),
      ).toEqual(fields.flatMap(passageCitations));
      expect(result.sourceReading?.missingTopics).toBeUndefined();
      expect(result.quiz).toEqual([]);
    },
  );
  it("keeps the actual010332 contraindications in the complete cross-page attention field when the generated warning is rejected", async () => {
    const llm = model(
      (sources) => [
        claim(sources.find((s) => s.purposeEligible)),
        claim(sources.find((s) => s.sourceSection === "交互作用")),
      ],
      true,
    );
    const result = await grounded(
      llm,
      actualQuestion,
      actual.chunks,
      {},
      "chat",
    );
    const fields = sourcePassages(actual.chunks).filter((p) =>
      ["注意事項", "交互作用"].includes(p.sourceSection || ""),
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].category).toBe("purpose");
    expect(result.rejectedCount).toBe(1);
    expect(result.sourceReading).toEqual({
      reason: "requested_topic_coverage",
      sections: fields.map((field) => ({
        sourceSection: field.sourceSection,
        citations: passageCitations(field),
      })),
    });
    expect(result.sourceReading!.sections[0].citations).toHaveLength(2);
    expect(
      result.sourceReading!.sections[0].citations.map((c) => c.quote).join(""),
    ).toContain("19.");
    expect(result.sourceReading).not.toHaveProperty("missingTopics");
    expect(result.chunks).toEqual(actual.chunks);
    expect(result.quiz).toEqual([]);
    expect(result.followups).toEqual([]);
  });
  it("does not treat a one-point summary with a whole eight-item citation as a complete interaction answer", async () => {
    const result = await grounded(
      model((sources) => [
        claim(
          sources.find((s) => s.sourceSection === "交互作用"),
          "毛地黃與本藥同時使用時應小心監視。",
        ),
      ]),
      "請說明交互作用。",
      actual.chunks,
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.sourceReading?.reason).toBe("requested_topic_coverage");
    expect(result.sourceReading?.sections.map((s) => s.sourceSection)).toEqual([
      "交互作用",
    ]);
  });
  it("keeps fully reviewed complete field text supported, including its literal body after a standalone heading", async () => {
    const result = await grounded(
      model((sources) => [
        claim(sources.find((s) => s.sourceSection === "交互作用")),
      ]),
      "請逐項說明交互作用。",
      actual.chunks,
      {},
      "chat",
    );
    expect(result.status).toBe("supported");
    expect(result.claims).toHaveLength(1);
    expect(result.sourceReading).toBeUndefined();
  });
  it("does not let one complete warning hide a second requested safety field", async () => {
    const source = chunk(
      "【適應症】緩解合成症狀。\n【警語】合成條件甲者不得使用。\n【注意事項】合成條件乙者請先詢問醫師。",
    );
    const result = await grounded(
      model((sources) => [
        claim(sources.find((s) => s.sourceSection === "警語")),
      ]),
      "請說明警語與注意事項。",
      [source],
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.sourceReading?.sections.map((s) => s.sourceSection)).toEqual([
      "注意事項",
    ]);
  });
  it("does not borrow a first product's complete field for the same topic in another product", async () => {
    const sources = [
      chunk(
        "【適應症】緩解合成甲症狀。\n【交互作用】合成藥甲併用時請注意合成影響。",
        "SYNTHETIC-A",
      ),
      chunk(
        "【適應症】緩解合成乙症狀。\n【交互作用】合成藥乙併用時請注意另一合成影響。",
        "SYNTHETIC-B",
      ),
    ];
    const result = await grounded(
      model((fields) => [
        claim(
          fields.find(
            (s) =>
              s.licenseNo === "SYNTHETIC-A" && s.sourceSection === "交互作用",
          ),
        ),
      ]),
      "兩款藥的交互作用。",
      sources,
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.sourceReading?.sections).toHaveLength(1);
    expect(result.sourceReading!.sections[0].citations[0].chunkId).toBe(
      "SYNTHETIC-B",
    );
    expect(result.claims).toHaveLength(1);
  });
  it("records a requested topic without an actual field separately instead of inventing an omitted field or no-risk answer", async () => {
    const result = await grounded(
      purposeOnly,
      "用途及交互作用是什麼？",
      [chunk("【適應症】緩解合成測試症狀。")],
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.sourceReading).toEqual({
      reason: "requested_topic_coverage",
      sections: [],
      missingTopics: [
        {
          topic: "交互作用",
          licenseNo: "SYNTHETIC-COVERAGE",
          version: "synthetic-v1",
        },
      ],
    });
  });
  it.each([
    "請只說明用途。",
    "請只說明用途，不需要警語或交互作用。",
    "不用說明警語，請講用途。",
  ])(
    "does not request excluded or unasked safety topics: %s",
    async (question) => {
      const result = await grounded(
        purposeOnly,
        question,
        [chunk("【適應症】緩解合成測試症狀。\n【警語】合成條件者不得使用。")],
        {},
        "chat",
      );
      expect(result.status).toBe("supported");
      expect(result.sourceReading).toBeUndefined();
    },
  );
  it.each([
    "不用說明個人劑量只說明用途和交互作用",
    "不需要說明個人劑量，只說明用途和交互作用",
    "不需要警語，只說明用途和交互作用",
    "不用說明個人劑量以及請說明交互作用",
    "不用說明個人劑量和請列出交互作用",
    "不需要警語或用途和交互作用",
    "沒有交互作用嗎？",
    "不要漏掉交互作用",
    "不用說明交互作用以外的資料",
  ])(
    "cannot let a negated unrelated object or mixed list suppress a positive safety request: %s",
    async (question) => {
      const result = await grounded(
        purposeOnly,
        question,
        [
          chunk(
            "【適應症】緩解合成測試症狀。\n【交互作用】合成併用情形請注意合成影響。",
          ),
        ],
        {},
        "chat",
      );
      expect(result.status).toBe("insufficient_data");
      expect(result.sourceReading?.reason).toBe("requested_topic_coverage");
      expect(
        result.sourceReading?.sections.map((s) => s.sourceSection),
      ).toEqual(["交互作用"]);
    },
  );
  it.each(["哪些人不能用？", "什麼情況不能使用？", "請不要漏掉禁用情形。"])(
    "recognizes an explicit general contraindication request: %s",
    async (question) => {
      const result = await grounded(
        purposeOnly,
        question,
        [
          chunk(
            "【適應症】緩解合成測試症狀。\n【注意事項】合成條件者請勿使用。",
          ),
        ],
        {},
        "chat",
      );
      expect(result.status).toBe("insufficient_data");
      expect(result.sourceReading?.sections[0].sourceSection).toBe("注意事項");
    },
  );
  it("preserves an explicit personal-decision refusal without resurrecting safety source reading", async () => {
    const result = await grounded(
      { json: async () => ({ status: "refused", claims: [], quiz: [] }) },
      "我可以服用嗎？也請說明禁用和交互作用。",
      actual.chunks,
      {},
      "chat",
    );
    expect(result.status).toBe("refused");
    expect(result.claims).toEqual([]);
    expect(result.chunks).toEqual([]);
    expect(result.sourceReading).toBeUndefined();
  });
  it("cannot mark an approved one-point summary complete merely because it cites the whole field", () => {
    const fields = sourcePassages(actual.chunks),
      interaction = fields.find((field) => field.sourceSection === "交互作用")!;
    const checked = completeRequestedChatCoverage(
      "請說明交互作用。",
      actual.chunks,
      actual.chunks,
      fields,
      [
        {
          text: "毛地黃與本藥同時使用時應小心監視。",
          category: "warning",
          citations: passageCitations(interaction),
        },
      ],
    );
    expect(checked.incomplete).toBe(true);
    expect(checked.sourceReading?.sections).toEqual([
      { sourceSection: "交互作用", citations: passageCitations(interaction) },
    ]);
  });
  it("keeps a reviewed complete literal body supported when only the standalone canonical heading line was omitted", () => {
    const source = chunk("【交互作用】\n合成藥併用時請注意合成影響。"),
      fields = sourcePassages([source]);
    const checked = completeRequestedChatCoverage(
      "交互作用",
      [source],
      [source],
      fields,
      [
        {
          text: "合成藥併用時請注意合成影響。",
          category: "warning",
          citations: passageCitations(fields[0]),
        },
      ],
    );
    expect(checked).toEqual({ incomplete: false, sourceReading: undefined });
  });
  it("answers an explicit purpose-only request without presenting unrelated overlong safety fields as unanswered", async () => {
    const result = await grounded(
      purposeOnly,
      "請只說明用途，不需要警語或交互作用。",
      [
        chunk(
          "【適應症】緩解合成測試症狀。\n【警語】" +
            "合成完整條件。".repeat(240),
        ),
      ],
      {},
      "chat",
    );
    expect(result.status).toBe("supported");
    expect(result.claims[0].category).toBe("purpose");
    expect(result.sourceReading).toBeUndefined();
  });
  it("retains purpose incompleteness even after excluding unrelated overlong safety reading", async () => {
    const result = await grounded(
      purposeOnly,
      "請只說明用途，不需要警語或交互作用。",
      [
        chunk(
          "【適應症】緩解合成測試症狀。" +
            "合成用途限制。".repeat(240) +
            "\n【警語】" +
            "合成安全條件。".repeat(240),
        ),
      ],
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.sourceReading).toBeUndefined();
  });
  it("keeps conservative existing capacity disclosure for an ambiguous purpose question", async () => {
    const result = await grounded(
      purposeOnly,
      "用途是什麼？",
      [
        chunk(
          "【適應症】緩解合成測試症狀。\n【警語】" +
            "合成完整條件。".repeat(240),
        ),
      ],
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(result.sourceReading?.reason).toBe("model_source_capacity");
  });
  it("retains the existing source budget and exposes an actual omitted field without a partial quote", async () => {
    const chunks = ["SYNTHETIC-A", "SYNTHETIC-B", "SYNTHETIC-C"].map(
      (license) =>
        chunk(
          "【適應症】緩解合成測試症狀。\n【警語】" +
            "合成完整條件。".repeat(1100),
          license,
        ),
    );
    const result = await grounded(
      purposeOnly,
      "請列出一般警語。",
      chunks,
      {},
      "chat",
    );
    expect(result.status).toBe("insufficient_data");
    expect(
      result.chunks.reduce((n, c) => n + c.text.length, 0),
    ).toBeLessThanOrEqual(SOURCE_PAGE_CHAR_LIMIT);
    expect(result.sourceReading?.unavailableSections).toHaveLength(1);
    for (const section of result.sourceReading?.sections || [])
      for (const citation of section.citations)
        expect(chunks.find((c) => c.id === citation.chunkId)!.text).toContain(
          citation.quote,
        );
    expect(result.sourceReading?.missingTopics).toBeUndefined();
  });
});
