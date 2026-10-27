import { describe, expect, it } from "vitest";
import { recognize } from "../server/ai.js";
import { concentrationWithoutPackage } from "../server/recognition-usage.js";

async function transcribe(
  rawText: string,
  fields: Record<string, unknown> = {},
) {
  return recognize(
    {
      json: async () => ({
        status: "succeeded",
        guidance: "用法尚有缺漏，請對照藥袋核對。",
        medications: [
          {
            name: "合成核對品",
            strength: null,
            form: null,
            doseAmount: null,
            doseUnit: null,
            doseText: null,
            frequencyRaw: null,
            route: null,
            durationDays: null,
            rawText,
            confidence: "medium",
            ...fields,
          },
        ],
      }),
    },
    Buffer.from("synthetic mocked transcription; zero hosted AI calls"),
    "image/jpeg",
  );
}

describe("recognition source context regressions from the independent audit", () => {
  it.each([
    "藥名：合成錠；範例：每次1錠，需要時，口服；藥袋用法：未標示",
    "教學：每次1錠；需要時；口服",
    "例如：每次1錠；需要時；口服",
    "用法：□ 每次1錠；需要時；口服",
    "用法：[ ] 每次1錠；需要時；口服",
    "用法：[x] 每次1錠；需要時；口服",
  ])(
    "does not repair null usage from examples or checkbox selections: %s",
    async (rawText) => {
      const result = await transcribe(rawText);
      expect(result.medications[0]).toMatchObject({
        doseAmount: null,
        doseUnit: null,
        frequencyRaw: null,
        route: null,
        confidence: "low",
        rawText,
      });
      expect(result.guidance).toContain("缺漏");
      expect(result.guidance).not.toContain("已從辨識原文補回");
    },
  );

  it.each([
    "注意事項：必要時請洽醫師",
    "備註：需要時聯絡醫師",
    "藥名：必要時錠",
    "商品名：需要時膠囊",
    "藥品：必要時錠",
    "必要時請洽醫師",
    "必要時可聯絡醫師",
  ])(
    "does not interpret a product or consultation note as a frequency: %s",
    async (note) => {
      const result = await transcribe(`合成核對品；每次1錠；口服；${note}`);
      expect(result.medications[0]).toMatchObject({
        doseAmount: 1,
        doseUnit: "錠",
        frequencyRaw: null,
        route: "口服",
        confidence: "low",
      });
    },
  );

  it.each([
    "合成核對品；每次1錠，需要時，口服",
    "藥品：合成外用液；外用藥；局部需要時使用",
    "合成核對品；每次1粒；必要時才使用；口服",
  ])("retains explicit administration text: %s", async (rawText) => {
    const result = await transcribe(rawText);
    expect(result.medications[0].frequencyRaw).toMatch(/需要時|必要時/);
    expect(result.medications[0].route).not.toBeNull();
  });

  it.each([
    [
      "藥名：合成外用液 0.5mg/gm/25ml/Bot；每次用量：未標示；每日1次；外用",
      25,
      "ml",
      "0.5mg/gm/25ml/Bot",
    ],
    [
      "合成核對品；發藥總量：28錠；每次用量：未標示；每日1次；口服",
      28,
      "錠",
      null,
    ],
    ["合成核對品；總量28錠；每次用量：未標示；每日1次；口服", 28, "錠", null],
    ["合成藥水 60ml/瓶；每次用量：未標示；每日1次；口服", 60, "ml", null],
    [
      "藥名：合成測試錠 500mg；每次用量：未標示；每日1次；口服",
      500,
      "mg",
      null,
    ],
    [
      "藥品：合成測試錠 500mg；每次用量：未標示；每日1次；口服",
      500,
      "mg",
      null,
    ],
    ["合成外用液 0.5mg/ml；每次用量：未標示；每日1次；外用", 0.5, "mg", null],
  ])(
    "clears a supplied dose supported only by a package, total or product heading: %s",
    async (rawText, doseAmount, doseUnit, strength) => {
      const result = await transcribe(rawText as string, {
        doseAmount,
        doseUnit,
        strength,
        frequencyRaw: "每日1次",
        route: (rawText as string).includes("外用") ? "外用" : "口服",
      });
      expect(result.medications[0]).toMatchObject({
        doseAmount: null,
        doseUnit: null,
        confidence: "low",
      });
      expect(result.guidance).toContain("已清空");
    },
  );

  it.each([
    ["藥名：合成藥水 25ml/瓶；每次25ml；每日1次；口服", 25, "ml"],
    ["合成核對品；1錠；每日1次；口服", 1, "錠"],
    ["合成核對品5mg；每次劑量：5 mg 頻次：BID PC", 5, "mg"],
    ["合成核對品；每次1錠，總量28錠；每日1次；口服", 1, "錠"],
    ["合成外用液 0.5mg/ml；每次0.5mg；每日1次；外用", 0.5, "mg"],
  ])(
    "retains a dose independently printed as administration: %s",
    async (rawText, doseAmount, doseUnit) => {
      const result = await transcribe(rawText as string, {
        doseAmount,
        doseUnit,
      });
      expect(result.medications[0]).toMatchObject({ doseAmount, doseUnit });
    },
  );

  it.each([
    ["合成藥水 60ml/瓶", "60ml/瓶"],
    ["合成藥水 60ml/瓶", "60ml"],
    ["合成乳膏 15g/管", "15g/管"],
    ["合成乳膏 15g/管", "15g"],
    ["合成藥水 60 ml / bottle", "60 ml / bottle"],
    ["合成藥水 60ml/瓶 每次5ml；每日1次；口服", "60ml"],
  ])(
    "leaves a pure container amount out of strength: %s",
    async (rawText, strength) => {
      const result = await transcribe(rawText, { strength });
      expect(result.medications[0]).toMatchObject({
        strength: null,
        rawText,
        confidence: "low",
      });
    },
  );

  it.each(["60mg", "1mg/5ml", "0.1g/錠"])(
    "preserves a literal strength without container evidence: %s",
    async (strength) => {
      const result = await transcribe(`合成核對品 ${strength}`, { strength });
      expect(result.medications[0].strength).toBe(strength);
    },
  );

  it.each([
    "0.5mg/gm/25ml/Bot(外用)",
    "0.5mg/gm/25ml/Bot（外用）",
    "0.5mg/gm/25ml/瓶外用液",
  ])(
    "separates a printed container immediately followed by route text: %s",
    async (raw) => {
      const supplied = raw.replace(/(?:\(|（|外用液).*$/u, "");
      expect(concentrationWithoutPackage(raw, supplied)).toBe("0.5mg/gm");
      const result = await transcribe(raw, { strength: supplied });
      expect(result.medications[0].strength).toBe("0.5mg/gm");
    },
  );

  it("does not match a container abbreviation inside another word", () => {
    const raw = "0.5mg/gm/25ml/Botanical";
    expect(concentrationWithoutPackage(raw, "0.5mg/gm/25ml/Bot")).toBeNull();
  });
});
