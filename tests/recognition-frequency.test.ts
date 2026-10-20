import { describe, expect, it } from "vitest";
import { recognize } from "../server/ai";

async function transcribe(frequencyRaw: string | null, rawText: string) {
  return recognize(
    {
      async json() {
        return {
          status: "succeeded",
          medications: [
            {
              name: "合成轉錄測試品",
              doseAmount: null,
              doseUnit: null,
              frequencyRaw,
              route: null,
              durationDays: null,
              rawText,
              confidence: "high",
            },
          ],
        };
      },
    },
    Buffer.from("synthetic-fixture"),
    "image/png",
  );
}

describe("literal frequency field extraction", () => {
  it.each([
    [
      "PRN（需要時才服用）",
      "品名：合成轉錄測試品；每次：1錠 頻次：PRN；途徑：口服",
      "PRN",
    ],
    [
      "TID (模型附加說明)",
      "品名：合成轉錄測試品\n頻率：TID\n途徑：口服",
      "TID",
    ],
  ])(
    "keeps only a complete explicit source code from %s",
    async (provided, raw, expected) => {
      const result = await transcribe(provided, raw);
      expect(result.medications[0].frequencyRaw).toBe(expected);
      expect(raw).toContain(expected);
      expect(result.medications[0].confidence).toBe("high");
    },
  );

  it.each([
    ["PRN（需要時才服用）", "備註提到 PRN；需要時才服用"],
    ["PRN（需要時才服用）", "頻次：TID；需要時才服用"],
    ["PRN（需要時才服用）", "頻次：PRN；頻次：QD"],
    ["PRN（需要時才服用）", "頻次：PRN 或 QD"],
    ["PRN（需要時才服用）", "非頻次：PRN"],
    ["PRN（需要時才服用）", "頻次：PRN 途徑：口服"],
    ["QD", "頻次：TID"],
  ])("clears unsupported or ambiguous %s in %s", async (provided, raw) => {
    const result = await transcribe(provided, raw);
    expect(result.medications[0].frequencyRaw).toBeNull();
    expect(result.medications[0].confidence).toBe("low");
  });

  it("does not fill a missing model field from source text", async () => {
    expect(
      (await transcribe(null, "頻次：PRN")).medications[0].frequencyRaw,
    ).toBeNull();
  });

  it("preserves a verbatim source field without rewriting it", async () => {
    const literal = "PRN（需要時才服用）";
    expect(
      (await transcribe(literal, "頻次：" + literal)).medications[0]
        .frequencyRaw,
    ).toBe(literal);
  });
});
