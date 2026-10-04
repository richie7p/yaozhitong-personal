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
it("normalizes quoted decimal values and empty text without inferring values", async () => {
  const r = await recognize(
    {
      json: async () => ({
        status: "succeeded",
        medications: [
          {
            ...base,
            doseAmount: "0.5",
            doseUnit: "錠",
            durationDays: "7",
            frequencyRaw: "",
            rawText: "合成測試片 5mg\n每次劑量：0.5 錠 頻次：\n天數：7",
          },
        ],
      }),
    },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications[0]).toMatchObject({
    doseAmount: 0.5,
    doseUnit: "錠",
    durationDays: 7,
    frequencyRaw: null,
  });
});
it.each(["0.5 錠", "1/2", "1e2", "", "null", true, "-1", "Infinity"])(
  "does not coerce ambiguous or invalid dose values: %s",
  async (doseAmount) => {
    await expect(
      recognize(
        {
          json: async () => ({
            status: "succeeded",
            medications: [{ ...base, doseAmount }],
          }),
        },
        Buffer.from("fixture"),
        "image/png",
      ),
    ).rejects.toMatchObject({ code: "invalid_ai_output" });
  },
);
it("discards medication rows when the model says recognition failed", async () => {
  const r = await recognize(
    { json: async () => ({ status: "failed", medications: [base] }) },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications).toEqual([]);
  expect(r.guidance).not.toBe("");
});
it("does not report success with an empty medication list", async () => {
  await expect(
    recognize(
      { json: async () => ({ status: "succeeded", medications: [] }) },
      Buffer.from("fixture"),
      "image/png",
    ),
  ).rejects.toMatchObject({ code: "invalid_ai_output" });
});
it("treats dose-unit regex punctuation literally", async () => {
  const r = await recognize(
    {
      json: async () => ({
        status: "succeeded",
        medications: [
          {
            ...base,
            doseAmount: 1,
            doseUnit: "錠+",
            frequencyRaw: null,
            rawText: "合成測試片 每次1錠",
          },
        ],
      }),
    },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications[0].doseAmount).toBeNull();
  expect(r.medications[0].doseUnit).toBeNull();
});
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
it.each(["每次劑量：頻次：", "服用頻次：／用法：", "頻率： --", "  "])(
  "clears combined empty field labels instead of using them as a frequency: %s",
  async (frequencyRaw) => {
    const r = await recognize(
      {
        json: async () => ({
          status: "succeeded",
          medications: [
            { ...base, frequencyRaw, rawText: `${base.name}\n${frequencyRaw}` },
          ],
        }),
      },
      Buffer.from("fixture"),
      "image/png",
    );
    expect(r.medications[0].frequencyRaw).toBeNull();
  },
);
it.each(["BID PC", "每日2次", "服用頻次：每日2次", "需要時使用"])(
  "preserves visible frequency text without interpreting it: %s",
  async (frequencyRaw) => {
    const r = await recognize(
      {
        json: async () => ({
          status: "succeeded",
          medications: [
            { ...base, frequencyRaw, rawText: `${base.name}\n${frequencyRaw}` },
          ],
        }),
      },
      Buffer.from("fixture"),
      "image/png",
    );
    expect(r.medications[0].frequencyRaw).toBe(frequencyRaw);
  },
);
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
