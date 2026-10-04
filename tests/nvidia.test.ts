import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Nvidia, recognize } from "../server/ai";
import { config } from "../server/config";
let originalKey: string;
beforeEach(() => {
  originalKey = config.nvidiaKey;
  config.nvidiaKey = "synthetic-key";
});
afterEach(() => {
  config.nvidiaKey = originalKey;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("retries 429 and returns a bounded busy error", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => new Response("", { status: 429 }));
  vi.stubGlobal("fetch", request);
  const done = expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "ai_busy",
  });
  await vi.runAllTimersAsync();
  await done;
  expect(request).toHaveBeenCalledTimes(3);
});
it("rejects malformed JSON without exposing model content", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      choices: [{ message: { content: "private unparseable output" } }],
    }),
  );
  await expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "invalid_ai_output",
  });
});
it("rejects an invalid HTTP JSON envelope without exposing its contents", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response("private upstream failure", { status: 200 }),
  );
  await expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "invalid_ai_output",
  });
});
it.each([
  null,
  {},
  { choices: [] },
  { choices: [{ message: { content: 5 } }] },
])("rejects malformed completion envelopes safely: %j", async (body) => {
  vi.stubGlobal("fetch", async () => Response.json(body));
  await expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "invalid_ai_output",
  });
});
it("maps network timeout to a retryable error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("TimeoutError");
  });
  await expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "ai_timeout",
  });
});
it("does not accept truncated output even when it happens to be valid JSON", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      choices: [
        { message: { content: '{"ok":true}' }, finish_reason: "length" },
      ],
    }),
  );
  await expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "invalid_ai_output",
  });
});
it("preserves missing doses and normalizes literal null text", async () => {
  const r = await recognize(
    {
      json: async () => ({
        status: "succeeded",
        medications: [
          {
            name: "測試",
            strength: "null",
            form: null,
            doseAmount: null,
            doseUnit: null,
            frequencyRaw: null,
            route: null,
            durationDays: null,
            rawText: "測試",
            confidence: "low",
          },
        ],
      }),
    },
    Buffer.from("fixture"),
    "image/png",
  );
  expect(r.medications[0].strength).toBeNull();
  expect(r.medications[0].doseAmount).toBeNull();
});
