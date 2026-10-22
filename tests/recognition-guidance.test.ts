import { describe, expect, it } from "vitest";
import { recognize } from "../server/ai";
import { withoutMissingFrequencyGuidance } from "../server/recognition-guidance";

const raw =
  "【藥名】G31 Infant acetaminophen 80mg/tab；商品名：Bubdel 普德；【使用方法】內服藥，口服；需要時，每次1粒；右側：1-1";
const medicine = (rawText = raw, frequencyRaw: string | null = "需要時") => ({
  name: "Bubdel 普德", strength: "80mg/tab", form: "錠劑",
  doseAmount: 1, doseUnit: "粒", doseText: null, frequencyRaw,
  route: "口服", durationDays: null, rawText, confidence: "high" as const,
});
const transcribe = (guidance: string, medications = [medicine()]) => recognize(
  { json: async () => ({ status: "succeeded", guidance, medications }) },
  Buffer.from("local mocked response; no hosted AI"), "image/jpeg",
);

describe("PRN guidance does not hide incomplete usage or unknown codes", () => {
  it.each(["需要時", null])("removes the real Bubdel missing-frequency clause after validation or literal repair (%s)", async (frequency) => {
    const result = await transcribe("頻次欄缺漏，需對照核對；右側「1-1」為不明代碼，未作為頻次。", [medicine(raw, frequency)]);
    expect(result.medications[0]).toMatchObject({ frequencyRaw: "需要時", doseAmount: 1, doseUnit: "粒", route: "口服", rawText: raw });
    expect(result.guidance).not.toContain("頻次欄缺漏");
    expect(result.guidance).toContain("需對照核對");
    expect(result.guidance).toContain("右側「1-1」為不明代碼，未作為頻次");
  });
  it("keeps missing-usage guidance when any medicine still lacks a validated frequency", async () => {
    const result = await transcribe("頻次欄缺漏，請核對。", [medicine(), medicine("Bubdel 普德 80mg/tab；每次1粒；口服", null)]);
    expect(result.medications[1].frequencyRaw).toBeNull();
    expect(result.guidance).toContain("頻次或途徑尚有缺漏");
  });
  it("does not clear guidance when no medications were recognized", async () => {
    const guidance = "頻次欄缺漏，需對照核對。";
    const result = await transcribe(guidance, []);
    expect(result.medications).toEqual([]);
    expect(result.guidance).toBe(guidance);
  });
  it("retains missing-frequency guidance for an arbitrary raw code even if other usage fields are complete", async () => {
    const guidance = "頻次欄缺漏，右側1-1為不明代碼。";
    const result = await transcribe(guidance, [medicine("Bubdel 普德 80mg/tab；每次1粒；口服；1-1", "1-1")]);
    expect(result.medications[0].frequencyRaw).toBe("1-1");
    expect(result.guidance).toBe(guidance);
  });
  it.each([
    "若頻次欄缺漏，請補拍；右側「1-1」為不明代碼，未作為頻次。",
    "頻次欄不明時請補拍；右側「1-1」為不明代碼，未作為頻次。",
    "頻次「1-1」不明，請核對。",
  ])("preserves conditional or code-specific uncertainty: %s", async (guidance) => {
    expect((await transcribe(guidance)).guidance).toBe(guidance);
    expect(withoutMissingFrequencyGuidance(guidance)).toBe(guidance);
  });
});
