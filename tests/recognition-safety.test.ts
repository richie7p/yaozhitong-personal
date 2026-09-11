import { it, expect } from "vitest";
import { recognize } from "../server/ai";
const base = {
  name: "合成測試片",
  strength: "5mg",
  form: "錠",
  doseAmount: 5,
  doseUnit: "mg",
  frequencyRaw: "頻次：",
  route: "口服",
  durationDays: 7,
  confidence: "high",
  rawText: "合成測試片 5mg\n每次劑量： 頻次：\n途徑：口服 天數：7",
};
it("does not turn product strength or an empty frequency label into a dose", async () => {
  const r = await recognize(
    { json: async () => ({ status: "succeeded", medications: [base] }) },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications[0]).toMatchObject({
    doseAmount: null,
    doseUnit: null,
    frequencyRaw: null,
    confidence: "low",
    rawText: base.rawText,
  });
  expect(r.guidance).toContain("已清空");
});
it("preserves an explicitly transcribed dose even when equal to strength", async () => {
  const r = await recognize(
    {
      json: async () => ({
        status: "succeeded",
        medications: [
          {
            ...base,
            frequencyRaw: "BID PC",
            rawText: "合成測試片 5mg\n每次劑量：5 mg 頻次：BID PC",
          },
        ],
      }),
    },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications[0]).toMatchObject({
    doseAmount: 5,
    doseUnit: "mg",
    frequencyRaw: "BID PC",
  });
});
it("accepts a single response wrapper without merging ambiguous multiple responses", async () => {
  const response = {
    status: "succeeded",
    medications: [
      { ...base, doseAmount: null, doseUnit: null, frequencyRaw: null },
    ],
  };
  const r = await recognize(
    { json: async () => [response] },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications).toHaveLength(1);
  await expect(
    recognize(
      { json: async () => [response, response] },
      Buffer.from("fixture"),
      "image/png",
    ),
  ).rejects.toMatchObject({ code: "invalid_ai_output" });
});
