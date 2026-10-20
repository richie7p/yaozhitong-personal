import { describe, expect, it } from "vitest";
import { recognize } from "../server/ai";

const nullUsage = {
  doseAmount: null,
  doseUnit: null,
  doseText: null,
  frequencyRaw: null,
  route: null,
  durationDays: null,
};
const bubdel =
  "【藥名】G31 Infant acetaminophen 80mg/tab；商品名：Bubdel 普德；廠牌：溫士頓。使用方法：內服藥，口服；需要時，每次1粒。右側標示：1-1。";
const kentamin = [
  "Kentamin（Thiamine & Pyridoxine & Cyanocobalamin）130；口服；每天一次，早飯後使用，每次1顆，共30天",
  "Kentamin（Thiamine & Pyridoxine & Cyanocobalamin）130\n用法用量：【口服】每天一次，早飯後使用，每次1顆，共30天",
];
async function transcribe(
  rawText: string,
  fields: Record<string, unknown> = {},
  guidance = "",
) {
  return recognize(
    {
      json: async () => ({
        status: "succeeded",
        guidance,
        medications: [
          {
            name: "原文轉錄測試品",
            strength: null,
            form: null,
            ...nullUsage,
            rawText,
            confidence: "high",
            ...fields,
          },
        ],
      }),
    },
    Buffer.from("mocked transcription; no hosted AI"),
    "image/jpeg",
  );
}

describe("bounded literal repair of originally null recognition fields", () => {
  it.each([bubdel, bubdel.replace("。使用方法", "。4 PC。使用方法")])(
    "recovers the real public bag's three explicit fields without interpreting its side code",
    async (raw) => {
      const result = await transcribe(raw, {
        name: "Bubdel 普德",
        strength: "80mg/tab",
        confidence: "low",
      });
      expect(result.medications[0]).toMatchObject({
        doseAmount: 1,
        doseUnit: "粒",
        doseText: null,
        frequencyRaw: "需要時",
        route: "口服",
        durationDays: null,
        rawText: raw,
        strength: "80mg/tab",
      });
      expect(result.guidance).not.toMatch(/矛盾|衝突/);
    },
  );
  it("does not reconstruct a dose or frequency from packaging totals, side codes or one-day supplies", async () => {
    const result = await transcribe(
      "原文測試品；4 PC；1-1；發藥1條，1日份；途徑：口服",
    );
    expect(result.medications[0]).toMatchObject({
      doseAmount: null,
      doseUnit: null,
      frequencyRaw: null,
      durationDays: null,
      confidence: "low",
    });
    expect(result.guidance).toMatch(/核對/);
  });
  it.each([
    [
      "每次1粒或2粒；需要時；口服",
      { doseAmount: null, frequencyRaw: "需要時" },
    ],
    [
      "每次1粒；每次2粒；需要時；口服",
      { doseAmount: null, frequencyRaw: "需要時" },
    ],
    ["每次1粒；需要時；每天3次；口服", { doseAmount: 1, frequencyRaw: null }],
    [
      "每次1粒，或2粒；需要時；口服",
      { doseAmount: null, frequencyRaw: "需要時" },
    ],
  ])(
    "leaves ambiguous printed alternatives unresolved: %s",
    async (raw, expected) => {
      const result = await transcribe(raw as string);
      expect(result.medications[0]).toMatchObject({
        ...expected,
        confidence: "low",
      });
      expect(result.guidance).toMatch(/核對/);
    },
  );
  it("never replaces a supplied invalid dose after clearing it during validation", async () => {
    const result = await transcribe(bubdel, { doseAmount: 2, doseUnit: "粒" });
    expect(result.medications[0]).toMatchObject({
      doseAmount: null,
      doseUnit: null,
      frequencyRaw: "需要時",
      route: "口服",
      confidence: "low",
    });
    expect(result.guidance).toContain("已清空");
  });
  it("does not recover a frequency from a PRN mention in a product name or note", async () => {
    for (const raw of [
      "商品名：PRN；每次1粒；口服",
      "備註提到PRN；每次1粒；口服",
    ]) {
      const result = await transcribe(raw);
      expect(result.medications[0].frequencyRaw).toBeNull();
      expect(result.guidance).toMatch(/核對/);
    }
  });
  it("lets conflicting literal routes clear all usage after any null repair", async () => {
    const result = await transcribe("途徑：外用；口服；需要時，每次1粒。", {
      durationDays: 1,
    });
    expect(result.medications[0]).toMatchObject({
      ...nullUsage,
      confidence: "low",
    });
    expect(result.guidance).toMatch(/矛盾/);
  });
  it("flags the real gel transcription's incomplete usage without claiming it read an omitted oral annotation", async () => {
    const raw =
      "藥品學名：ETOFENAMATE GEL 100MG/GM 20GM\n藥品名稱：思舒痛凝膠\n用法欄：每次 1 條 1 日份；發藥 1 條\n外用勾選。";
    const result = await transcribe(raw, {
      name: "思舒痛凝膠",
      strength: "100MG/GM",
      confidence: "medium",
    });
    expect(result.medications[0]).toMatchObject({
      ...nullUsage,
      rawText: raw,
      strength: "100MG/GM",
      confidence: "low",
    });
    expect(result.guidance).toMatch(/缺漏.*核對/);
    expect(result.guidance).not.toMatch(/矛盾|衝突/);
  });
  it("replaces an unsupported provider conflict narrative with the fixed incomplete-usage notice", async () => {
    const rawText = "ETOFENAMATE GEL 100MG/GM 20GM；每次1條1日份；外用勾選。";
    const result = await transcribe(
      rawText,
      { name: "思舒痛凝膠", strength: "100MG/GM", confidence: "medium" },
      "外用勾選與口服、晚餐後矛盾，紅字要求口服所以無法確認。",
    );
    expect(result.medications[0]).toMatchObject({
      ...nullUsage,
      rawText,
      confidence: "low",
    });
    expect(result.guidance).toBe(
      "每次用量、頻次或途徑尚有缺漏，請對照原藥袋核對後再確認；未由藥名或不明代碼推測用法。",
    );
    expect(result.guidance).not.toMatch(/紅字|勾選|矛盾|晚餐/);
  });
  it.each(kentamin)(
    "clears the actual Kentamin product code 130 rather than fabricating photographed strength",
    async (raw) => {
      const result = await transcribe(raw, {
        name: "Kentamin",
        strength: "130",
        doseAmount: 1,
        doseUnit: "顆",
        frequencyRaw: "每天一次",
        route: "口服",
        durationDays: 30,
        confidence: "medium",
      });
      expect(result.medications[0]).toMatchObject({
        strength: null,
        rawText: raw,
        doseAmount: 1,
        doseUnit: "顆",
        frequencyRaw: "每天一次",
        route: "口服",
        durationDays: 30,
        confidence: "low",
      });
      expect(result.guidance).toMatch(/純數字代碼不作含量/);
    },
  );
  it("requires a supplied strength to occur literally in the raw photo transcription", async () => {
    const result = await transcribe(kentamin[0], { strength: "50mg" });
    expect(result.medications[0].strength).toBeNull();
    expect(result.guidance).toContain("未從藥品目錄補入");
  });
  it("does not fill an omitted strength or require an unprinted duration for otherwise complete usage", async () => {
    const result = await transcribe(
      "原文測試品 80mg/tab；每次1粒；需要時；口服",
      { doseAmount: 1, doseUnit: "粒", frequencyRaw: "需要時", route: "口服" },
    );
    expect(result.medications[0]).toMatchObject({
      strength: null,
      durationDays: null,
      confidence: "high",
    });
    expect(result.guidance).toBe("");
  });
});
