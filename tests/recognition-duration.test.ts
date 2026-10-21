import { describe, expect, it } from "vitest";
import { recognize } from "../server/ai";
import {
  missingLiteralDuration,
  withoutMissingDurationGuidance,
} from "../server/recognition-duration";

const kentamin =
  "Kentamin（Thiamine & Pyridoxine & Cyanocobalamin）｜口服｜每天一次，早飯後使用，每次1顆，共30天";
const missingFields = "含量、劑型及療程天數未見明確標示，需對照核對。";

function medication(rawText: string, fields: Record<string, unknown> = {}) {
  return {
    name: "Kentamin（Thiamine & Pyridoxine & Cyanocobalamin）",
    strength: null,
    form: null,
    doseAmount: 1,
    doseUnit: "顆",
    doseText: null,
    frequencyRaw: "每天一次",
    route: "口服",
    durationDays: null,
    rawText,
    confidence: "medium",
    ...fields,
  };
}

async function transcribe(
  medications = [medication(kentamin)],
  guidance = missingFields,
) {
  return recognize(
    { json: async () => ({ status: "succeeded", guidance, medications }) },
    Buffer.from("mocked provider; no external AI"),
    "image/jpeg",
  );
}

describe("original-null literal duration recovery at the recognition boundary", () => {
  it("recovers the actual Kentamin transcript's thirty days without changing other photo fields", async () => {
    const result = await transcribe();
    expect(result.medications[0]).toEqual({
      ...medication(kentamin),
      durationDays: 30,
    });
    expect(result.guidance).toBe("含量、劑型未見明確標示，需對照核對。");
  });
  it("never replaces an originally supplied duration", async () => {
    const result = await transcribe([
      medication(kentamin, { durationDays: 7 }),
    ]);
    expect(result.medications[0].durationDays).toBe(7);
    expect(result.guidance).toBe(missingFields);
  });
  it("lets contradictory administration labels clear even a freshly recovered duration", async () => {
    const result = await transcribe([medication(kentamin + "；外用")]);
    expect(result.medications[0]).toMatchObject({
      doseAmount: null,
      doseUnit: null,
      doseText: null,
      frequencyRaw: null,
      route: null,
      durationDays: null,
      confidence: "low",
    });
    expect(result.guidance).toMatch(/矛盾.*天數已留白/u);
  });
  it("retains the duration warning when another medication still has no explicit duration", async () => {
    const result = await transcribe([
      medication(kentamin),
      medication("合成核對品；每天一次，每次1顆；口服"),
    ]);
    expect(result.medications.map((med) => med.durationDays)).toEqual([
      30,
      null,
    ]);
    expect(result.guidance).toBe(missingFields);
  });
  it("retains strength validation and the form warning after repairing duration", async () => {
    const result = await transcribe([
      medication(kentamin.replace("｜口服", "130｜口服"), { strength: "130" }),
    ]);
    expect(result.medications[0]).toMatchObject({
      strength: null,
      form: null,
      durationDays: 30,
      confidence: "low",
    });
    expect(result.guidance).toContain("純數字代碼不作含量");
    expect(result.guidance).toContain("含量、劑型未見明確標示");
    expect(result.guidance).not.toContain("療程天數");
  });
  it("keeps optional unprinted duration null without inferring from a supply or follow-up date", async () => {
    const result = await transcribe(
      [medication("每天一次，每次1顆；口服；發藥30顆；回診2026/11/20；130")],
      "劑型未明確，需對照核對。",
    );
    expect(result.medications[0].durationDays).toBeNull();
    expect(result.guidance).toBe("劑型未明確，需對照核對。");
  });
});

describe("conservative printed duration fields", () => {
  it.each([
    [kentamin, 30],
    ["合成藥袋；每天兩次，每次0.5錠，共7天", 7],
    ["療程：14天", 14],
    ["用法：口服，共5天", 5],
    ["用法用量：外用，每次適量，共10天", 10],
    ["每次1.5毫升，共3天", 3],
    ["用法：口服\n療程天數：３０天", 30],
    ["療程共30天；療程30天", 30],
  ])(
    "reads the literal field without using the medication's identity: %s",
    (raw, days) => {
      expect(missingLiteralDuration(raw as string)).toBe(days);
    },
  );
  it.each([
    "130；每次1顆；每天一次；口服",
    "每次1顆；發藥30顆；30日份",
    "包裝共30天；每次1顆",
    "每次1顆，發藥總量共30天",
    "年齡30歲；每次1顆；口服",
    "生日2026/10/21；回診2026/11/20",
    "每次1顆，30天後回診",
    "每次1顆，共30天後回診",
    "症狀持續共7天；每次1顆",
    "每次1顆，建議共7天",
    "用法：每次1顆，最多共7天",
    "療程：最多7天",
    "建議療程7天",
    "建議用法；療程7天",
    "範例：每次1顆，共7天",
    "教學說明；每天一次；每次1顆，共30天",
    "範例；口服；每次1顆，共7天",
    "建議用法；每天一次；每次1顆，共30天",
    "最多；每天一次；每次1顆，共7天",
    "療程0天",
    "療程-7天",
    "療程1.5天",
    "療程3 0天",
    "療程3至5天",
    "療程3~5天",
    "療程3天或5天",
    "每次1顆，共3天，或5天",
    "每次1顆，共3天，改共5天",
    "每次1顆，共3天；療程5天",
    "每次1顆，共30天；或7天",
    "療程30天；改為7天",
    "療程30天；7天",
    "每次1顆，共30天；建議最多7天",
    "□療程30天",
    "療程30天未勾選",
    "每次1顆，保存期限共30天",
    "共30天",
    "商品名：共30天；每次1顆",
    "療程9007199254740993天",
  ])(
    "leaves non-prescription, incomplete or competing numbers unresolved: %s",
    (raw) => {
      expect(missingLiteralDuration(raw)).toBeNull();
    },
  );
});

describe("guidance after final duration recovery", () => {
  it.each([
    [missingFields, "含量、劑型未見明確標示，需對照核對。"],
    ["療程天數及劑型未明確，請核對。", "劑型未明確，請核對。"],
    ["療程未明確。含量不清楚，請核對。", "含量不清楚，請核對。"],
    ["療程天數未見明確標示，需對照核對。", "需對照核對。"],
    ["含量未明確，療程天數未明確。", "含量未明確"],
    ["照片反光，請核對劑型。", "照片反光，請核對劑型。"],
    ["請核對療程天數與原藥袋。", "請核對療程天數與原藥袋。"],
    [
      "療程未明確且照片反光，請重新核對。",
      "療程未明確且照片反光，請重新核對。",
    ],
  ])("removes only the resolved missing subject: %s", (guidance, expected) => {
    expect(withoutMissingDurationGuidance(guidance)).toBe(expected);
  });
});
