import { it, expect } from "vitest";
import { grounded, interactionScopeValid } from "../server/ai";
const context = {
  medications: [
    { licenseNo: "A", name: "合成甲", identityTerms: ["fixture-a"] },
    { licenseNo: "B", name: "合成乙", identityTerms: ["fixture-b"] },
  ],
};
const chunk = {
  id: "A-1",
  licenseNo: "A",
  version: "v1",
  page: 1,
  start: 0,
  text: "本品不可與含酒精飲料併服。與 fixture-b 併用的影響記載於此合成測試段落。",
};
it("does not treat a true general warning as evidence about the selected drug pair", async () => {
  const claim = {
    text: "本品不可與含酒精飲料併服。",
    citations: [{ chunkId: chunk.id, quote: "本品不可與含酒精飲料併服。" }],
  };
  const r = await grounded(
    {
      json: async (system) =>
        system.includes("審核器")
          ? { supported: [true] }
          : { status: "supported", claims: [claim] },
    },
    "比對甲乙兩藥",
    [chunk],
    context,
    "interaction",
  );
  expect(r.status).toBe("insufficient_data");
  expect(r.claims).toEqual([]);
  expect(r.rejectedCount).toBe(1);
});
it("permits pair-specific quotes for semantic review and rejects a third drug", () => {
  const claim = {
    text: "合成甲乙之交互作用",
    citations: [
      {
        chunkId: chunk.id,
        quote: "與 fixture-b 併用的影響記載於此合成測試段落。",
      },
    ],
  };
  expect(interactionScopeValid(claim, [chunk], context)).toBe(true);
  expect(
    interactionScopeValid(
      {
        ...claim,
        citations: [
          {
            chunkId: chunk.id,
            quote: "與 fixture-c 併用的影響記載於此合成測試段落。",
          },
        ],
      },
      [chunk],
      context,
    ),
  ).toBe(false);
});
