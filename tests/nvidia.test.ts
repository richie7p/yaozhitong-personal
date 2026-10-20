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
it("maps network timeout to a retryable error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw Error("TimeoutError");
  });
  await expect(new Nvidia().json("test", "test")).rejects.toMatchObject({
    code: "ai_timeout",
  });
});
it("requests JSON mode for the supported text model without sending it to vision models", async () => {
  const originalModel = config.textModel;
  config.textModel = "nvidia/nemotron-3.5-lightning-30b-a3b";
  const requests: any[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, request: RequestInit) => {
    requests.push(JSON.parse(String(request.body)));
    return Response.json({
      choices: [{ message: { content: '{"ok":true}' } }],
    });
  });
  try {
    await expect(new Nvidia().json("JSON", {})).resolves.toEqual({ ok: true });
    await expect(new Nvidia().json("JSON", [], true)).resolves.toEqual({
      ok: true,
    });
    expect(requests[0].response_format).toEqual({ type: "json_object" });
    expect(requests[1]).not.toHaveProperty("response_format");
    expect(requests[0].chat_template_kwargs.enable_thinking).toBe(false);
  } finally {
    config.textModel = originalModel;
  }
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
