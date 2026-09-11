import { it, expect } from "vitest";
import { grounded } from "../server/ai";
const chunk = {
  id: "source",
  licenseNo: "fixture",
  version: "v1",
  page: 1,
  start: 0,
  text: "這是合成測試資料，不作為醫療依據。",
};
const claims = ["僅供軟體測試。", "可以當成醫療依據。"].map((text) => ({
  text,
  citations: [{ chunkId: "source", quote: chunk.text }],
}));
const run = (verdict: unknown) =>
  grounded(
    {
      json: async (system) =>
        system.includes("審核器") ? verdict : { status: "supported", claims },
    },
    "用途？",
    [chunk],
    {},
    "chat",
  );
it("maps semantic verdicts by identity instead of response order", async () => {
  const r = await run({
    verdicts: [
      { id: "claim-1", supported: false },
      { id: "claim-0", supported: true },
    ],
  });
  expect(r.claims.map((c) => c.text)).toEqual([claims[0].text]);
});
it("rejects duplicated, extra, missing or unrelated semantic verdict IDs", async () => {
  for (const ids of [
    ["claim-0", "claim-0"],
    ["claim-0"],
    ["claim-0", "claim-1", "claim-2"],
    ["claim-0", "other"],
  ]) {
    await expect(
      run({ verdicts: ids.map((id) => ({ id, supported: true })) }),
    ).rejects.toMatchObject({ code: "verification_failed" });
  }
});
