import { describe, expect, it } from "vitest";
import { recognitionUsageConflict } from "../server/recognition-usage.js";
import { recognize } from "../server/ai.js";

describe("contradictory literal usage labels", () => {
  it("flags the public gel bag's competing external and meal-time oral labels", () => {
    expect(recognitionUsageConflict("ETOFENAMATE GEL 100MG/GM 20GM；外用；每日3次各1次，飯後服用；每次1條1日份")).toBe(true);
  });
  it.each(["外用，每日飯後塗抹", "口服，每天一次早餐後使用", "外用；請勿口服", "外用；不得將本品當作口服", "非外用，請口服"])("does not mistake a single route or prohibition for competing directions: %s", text => {
    expect(recognitionUsageConflict(text)).toBe(false);
  });
  it("does not supply a route from a product name or dosage-form assumption", () => {
    expect(recognitionUsageConflict("ETOFENAMATE GEL；每日3次飯後服用")).toBe(false);
  });
  it("clears every usage field and preserves the transcription for review", async () => {
    const rawText = "ETOFENAMATE GEL 100MG/GM 20GM；外用；每日3次飯後服用；每次1條，1日份";
    const result = await recognize({ json: async () => ({ status: "succeeded", guidance: "", medications: [{
      name: "ETOFENAMATE GEL", strength: "100MG/GM", form: "gel", doseAmount: 1,
      doseUnit: "條", doseText: null, frequencyRaw: "每日3次", route: "外用",
      durationDays: 1, rawText, confidence: "high",
    }] }) }, Buffer.from("local mocked image"), "image/jpeg");
    expect(result.medications[0]).toMatchObject({
      rawText, strength: "100MG/GM", confidence: "low", doseAmount: null,
      doseUnit: null, doseText: null, frequencyRaw: null, route: null, durationDays: null,
    });
    expect(result.guidance).toMatch(/矛盾|衝突/);
  });
});
