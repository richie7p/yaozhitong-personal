import { describe, expect, it } from "vitest";
import { concentrationWithoutPackage } from "../server/recognition-usage.js";
import { recognize } from "../server/ai.js";

describe("literal separation of concentration from container amount", () => {
  it.each([
    ["0.5mg/gm/25ml/Bot", "0.5mg/gm"],
    ["0.5mg/gm/25ml", "0.5mg/gm"],
    ["0.5 mg / gm / 25 ml / Bot", "0.5 mg / gm"],
  ])(
    "separates only the printed package suffix from %s",
    (supplied, expected) => {
      const raw = supplied.includes(" ")
        ? "合成泡沫液 0.5 mg / gm / 25 ml / Bot"
        : "合成泡沫液 0.5mg/gm/25ml/Bot (合成成分 0.5mg/gm/25ml/Bot)";
      expect(concentrationWithoutPackage(raw, supplied)).toBe(expected);
    },
  );
  it.each([
    ["0.5mg/gm/25ml", "0.5mg/gm/25ml"],
    ["0.5mg/gm/25ml/Unknown", "0.5mg/gm/25ml/Unknown"],
    ["0.5mg/gm/25ml/Bot", "0.5mg/ml/25ml/Bot"],
    ["0.5mg/gm/25ml/Bot", "5mg/gm/25ml/Bot"],
    ["0.5mg/gm/25ml/Bot", "0.5mg/gm/50ml/Bot"],
    ["0.5mg/gm + 1mg/gm/25ml/Bot", "0.5mg/gm + 1mg/gm/25ml/Bot"],
    ["0.5mg/gm/25ml/Bot", "0.05%"],
    ["0mg/gm/25ml/Bot", "0mg/gm/25ml/Bot"],
    ["0.5mg/0gm/25ml/Bot", "0.5mg/0gm/25ml/Bot"],
    ["0.5mg/gm/0ml/Bot", "0.5mg/gm/0ml/Bot"],
    ["-0.5mg/gm/25ml/Bot", "0.5mg/gm/25ml/Bot"],
    ["- 1 mg/g/60ml/bottle", "1 mg/g/60ml/bottle"],
    ["合成品 −\t1 mg/g/60ml/bottle", "1 mg/g/60ml/bottle"],
  ])(
    "does not invent package evidence or reconcile a different quantity: %s",
    (raw, supplied) => {
      expect(concentrationWithoutPackage(raw, supplied)).toBeNull();
    },
  );
  it("keeps concentration, raw text and every missing prescribed-dose field separate", async () => {
    const rawText =
      "外用藥\n合成泡沫液 0.5mg/gm/25ml/Bot\n局部需要時使用；單量1.00，總量1";
    const result = await recognize(
      {
        json: async () => ({
          status: "succeeded",
          medications: [
            {
              name: "SYNTHETIC FOAMING SOLUTION",
              strength: "0.5mg/gm/25ml/Bot",
              form: "foaming solution",
              doseAmount: null,
              doseUnit: null,
              doseText: null,
              frequencyRaw: null,
              route: null,
              durationDays: null,
              rawText,
              confidence: "low",
            },
          ],
        }),
      },
      Buffer.from("fake local image"),
      "image/png",
    );
    expect(result.medications[0]).toMatchObject({
      strength: "0.5mg/gm",
      route: "外用",
      frequencyRaw: "需要時",
      doseAmount: null,
      doseUnit: null,
      doseText: null,
      durationDays: null,
      rawText,
      confidence: "low",
    });
    expect(result.guidance).toContain("尚有缺漏");
  });
});
