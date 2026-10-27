import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../server/config";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Chunk, Drug, GroundedResult, Job } from "../shared/schema";

let originalConfig: typeof config;
beforeEach(() => {
  originalConfig = { ...config };
  Object.assign(config, {
    mode: "local",
    aiProvider: "nvidia",
    nvidiaKey: "synthetic-routing-secret",
    nvidiaBase: "https://synthetic-nvidia.invalid/v1",
    textModel: "synthetic/primary",
    nvidiaTextFallbackModels: ["synthetic/backup-a", "synthetic/backup-b"],
    nvidiaVisionFallbackModels: [],
    aiRequestTimeoutMs: 45000,
    aiPrimaryTimeoutMs: 18000,
    aiTextPrimaryTimeoutMs: 12000,
    aiJobTimeoutMs: 120000,
  });
});
afterEach(() => {
  Object.assign(config, originalConfig);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const drug: Drug = {
  licenseNo: "SYNTHETIC-ROUTING",
  nameZh: "合成路由核對資料",
  nameEn: "synthetic routing fixture",
  strength: "",
  form: "錠",
  ingredients: [],
  revoked: false,
};
const chunk: Chunk = {
  id: "synthetic-routing-source",
  licenseNo: drug.licenseNo,
  version: "synthetic-v1",
  page: 1,
  start: 0,
  text: "適應症：本文件僅用於合成軟體核對測試。",
};

async function setup() {
  const store = new MemoryStore();
  // Use the real Nvidia/JsonLlm client; fetch is stubbed by each test.
  const d = new Domain(store);
  d.catalog.get = async () => drug;
  d.catalog.all = async () => [drug];
  await d.account({
    uid: "synthetic-routing-owner",
    name: "合成路由核對帳號",
    email: "routing@example.invalid",
    verified: true,
    admin: false,
  });
  const med = await d.saveMedication("synthetic-routing-owner", {
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    confirmed: true,
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
  });
  await store.set("leaflets", "synthetic-leaflet", {
    id: "synthetic-leaflet",
    licenseNo: drug.licenseNo,
    version: chunk.version,
    sha256: "synthetic-only",
    status: "published",
    chunks: [chunk],
  });
  await store.set("published", hash(drug.licenseNo), {
    leafletId: "synthetic-leaflet",
  });
  const enqueue = (key: string) =>
    d.enqueueJob(
      "synthetic-routing-owner",
      true,
      "bundle",
      { medicationIds: [med.id] },
      key,
    );
  return { d, store, enqueue };
}

function responseFor(init?: RequestInit) {
  const body = JSON.parse(String(init?.body));
  const input = JSON.parse(body.messages[1].content);
  const reviewing = Array.isArray(input.expectedIds);
  const source = input.sources?.[0];
  const value = reviewing
    ? {
        verdicts: input.expectedIds.map((id: string) => ({
          id,
          supported: true,
        })),
      }
    : {
        status: "supported",
        claims: [
          {
            text: "依仿單適應症記載，本文件僅用於合成軟體核對測試。",
            category: "purpose",
            profileRefs: [],
            citations: [{ sourceId: source.id }],
          },
        ],
        quiz: [
          {
            q: "依仿單適應症欄記載，本文件的用途是哪一項？",
            options: ["合成軟體核對測試", "真實醫療診斷"],
            answer: 0,
            claimIndex: 0,
            learningObjective: "purpose",
            sourceSection: source.sourceSection,
            requiredConditions: source.requiredConditions,
            citations: [{ sourceId: source.id }],
          },
        ],
        followups: [],
      };
  return Response.json({
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(value) } },
    ],
    usage: { total_tokens: reviewing ? 7 : 11 },
  });
}

function useLuna() {
  Object.assign(config, {
    aiProvider: "openai",
    openaiKey: "synthetic-openai-routing-key",
    openaiBase: "https://synthetic-openai.invalid/v1",
    textModel: "gpt-6-luna",
    visionModel: "gpt-6-luna",
  });
}

describe("model routes, cache and atomic job persistence", () => {
  it("reuses the same route but regenerates after ordered fallback or deadline policy changes", async () => {
    const request = vi.fn(async (_url: unknown, init?: RequestInit) =>
      responseFor(init),
    );
    vi.stubGlobal("fetch", request);
    const { d, store, enqueue } = await setup();
    const run = async (key: string) => {
      const job = await enqueue(key);
      await d.processJob(job.id);
      expect(await store.get("jobs", job.id)).toMatchObject({
        status: "succeeded",
        result: {
          status: "supported",
          claims: [expect.anything()],
          quiz: [expect.anything()],
        },
      });
    };
    await run("routing-cache-0001");
    expect(request).toHaveBeenCalledTimes(2);
    await run("routing-cache-0002");
    expect(request).toHaveBeenCalledTimes(2);
    const cached = (await store.list<Job>("jobs")).find(
      (job) => job.tokens === 0,
    )!;
    expect(cached.aiRequests).toEqual([]);
    config.nvidiaTextFallbackModels = [
      "synthetic/backup-b",
      "synthetic/backup-a",
    ];
    await run("routing-cache-0003");
    expect(request).toHaveBeenCalledTimes(4);
    await run("routing-cache-0004");
    expect(request).toHaveBeenCalledTimes(4);
    config.aiPrimaryTimeoutMs += 1000;
    await run("routing-cache-0005");
    expect(request).toHaveBeenCalledTimes(6);
    config.aiRequestTimeoutMs += 1000;
    await run("routing-cache-0006");
    expect(request).toHaveBeenCalledTimes(8);
    config.aiJobTimeoutMs += 1000;
    await run("routing-cache-0007");
    expect(request).toHaveBeenCalledTimes(10);
    config.aiTextPrimaryTimeoutMs += 1000;
    await run("routing-cache-0008");
    expect(request).toHaveBeenCalledTimes(12);
    expect(await store.list("generated")).toHaveLength(6);
    expect(await store.list("learning")).toHaveLength(8);
  });

  it("publishes once after primary 503 and backup success, with actual models and summed known usage", async () => {
    let calls = 0;
    const request = vi.fn(async (_url: unknown, init?: RequestInit) =>
      ++calls === 1
        ? new Response("synthetic private upstream body", { status: 503 })
        : responseFor(init),
    );
    vi.stubGlobal("fetch", request);
    const { d, store, enqueue } = await setup();
    const job = await enqueue("routing-fallback-0001");
    expect((await enqueue("routing-fallback-0001")).id).toBe(job.id);
    await Promise.all([d.processJob(job.id), d.processJob(job.id)]);
    const saved = await store.get<Job>("jobs", job.id);
    expect(saved).toMatchObject({
      status: "succeeded",
      attempts: 1,
      tokens: 18,
    });
    expect((saved?.result as GroundedResult).quiz).toHaveLength(1);
    expect(saved?.aiRequests).toEqual([
      expect.objectContaining({
        model: "synthetic/primary",
        stage: "generation",
        status: 503,
        error: "ai_busy",
        tokens: null,
      }),
      expect.objectContaining({
        model: "synthetic/backup-a",
        stage: "generation",
        status: 200,
        fallbackFrom: "synthetic/primary",
        tokens: 11,
      }),
      expect.objectContaining({
        model: "synthetic/backup-a",
        stage: "verification",
        status: 200,
        tokens: 7,
      }),
    ]);
    const safeMetrics = JSON.stringify(saved?.aiRequests);
    expect(safeMetrics).not.toContain("synthetic-routing-secret");
    expect(safeMetrics).not.toContain("synthetic private upstream body");
    expect(safeMetrics).not.toContain(chunk.text);
    expect(await store.list("jobs")).toHaveLength(1);
    expect(await store.list("learning")).toHaveLength(1);
    expect(await store.list("generated")).toHaveLength(1);
    await d.processJob(job.id);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("persists failed verification metrics and never publishes the backup's unreviewed generation", async () => {
    let calls = 0;
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1)
        return new Response("synthetic unavailable", { status: 503 });
      if (calls === 2) return responseFor(init);
      return new Response("synthetic private auth response", { status: 401 });
    });
    vi.stubGlobal("fetch", request);
    const { d, store, enqueue } = await setup();
    const job = await enqueue("routing-review-failed-0001");
    await d.processJob(job.id);
    const saved = await store.get<Job>("jobs", job.id);
    expect(saved).toMatchObject({
      status: "failed",
      result: null,
      tokens: 11,
      error: { code: "ai_auth_error" },
    });
    expect(saved?.aiRequests).toEqual([
      expect.objectContaining({
        model: "synthetic/primary",
        stage: "generation",
        status: 503,
        error: "ai_busy",
      }),
      expect.objectContaining({
        model: "synthetic/backup-a",
        stage: "generation",
        status: 200,
        tokens: 11,
      }),
      expect.objectContaining({
        model: "synthetic/backup-a",
        stage: "verification",
        status: 401,
        error: "ai_auth_error",
        tokens: null,
      }),
    ]);
    expect(await store.list("learning")).toEqual([]);
    expect(await store.list("generated")).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain(
      "synthetic private auth response",
    );
    expect(JSON.stringify(saved)).not.toContain("synthetic-routing-secret");
    await d.processJob(job.id);
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe("OpenAI Luna job boundaries", () => {
  it("regenerates after a provider/model migration and caches only the matching Luna route", async () => {
    const request = vi.fn(async (_url: unknown, init?: RequestInit) =>
      responseFor(init),
    );
    vi.stubGlobal("fetch", request);
    const { d, store, enqueue } = await setup();
    const nvidia = await enqueue("provider-migration-nvidia");
    await d.processJob(nvidia.id);
    expect(request).toHaveBeenCalledTimes(2);
    useLuna();
    const luna = await enqueue("provider-migration-luna");
    await d.processJob(luna.id);
    expect(request).toHaveBeenCalledTimes(4);
    const saved = await store.get<Job>("jobs", luna.id);
    expect(saved).toMatchObject({ status: "succeeded", tokens: 18 });
    expect(
      saved?.aiRequests?.map((metric) => [
        metric.provider,
        metric.model,
        metric.stage,
      ]),
    ).toEqual([
      ["openai", "gpt-6-luna", "generation"],
      ["openai", "gpt-6-luna", "verification"],
    ]);
    const cached = await enqueue("provider-migration-luna-cache");
    await d.processJob(cached.id);
    expect(request).toHaveBeenCalledTimes(4);
    expect(await store.get("jobs", cached.id)).toMatchObject({
      status: "succeeded",
      tokens: 0,
      aiRequests: [],
    });
    expect(await store.list("generated")).toHaveLength(2);
    expect(
      request.mock.calls
        .slice(2)
        .every(
          ([url]) =>
            url === "https://synthetic-openai.invalid/v1/chat/completions",
        ),
    ).toBe(true);
  });

  it("recovers a temporary Luna 503 with the same model and publishes one reviewed record", async () => {
    vi.useFakeTimers();
    useLuna();
    let calls = 0;
    const request = vi.fn(async (_url: unknown, init?: RequestInit) =>
      ++calls === 1
        ? new Response("synthetic private upstream response", { status: 503 })
        : responseFor(init),
    );
    vi.stubGlobal("fetch", request);
    const { d, store, enqueue } = await setup();
    const job = await enqueue("luna-transient-retry");
    const processed = d.processJob(job.id);
    await vi.runAllTimersAsync();
    await processed;
    const saved = await store.get<Job>("jobs", job.id);
    expect(saved).toMatchObject({
      status: "succeeded",
      attempts: 1,
      tokens: 18,
    });
    expect((saved?.result as GroundedResult).quiz).toHaveLength(1);
    expect(saved?.aiRequests).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-6-luna",
        stage: "generation",
        attempt: 1,
        status: 503,
        error: "ai_busy",
        tokens: null,
      }),
      expect.objectContaining({
        provider: "openai",
        model: "gpt-6-luna",
        stage: "generation",
        attempt: 2,
        status: 200,
        tokens: 11,
      }),
      expect.objectContaining({
        provider: "openai",
        model: "gpt-6-luna",
        stage: "verification",
        attempt: 1,
        status: 200,
        tokens: 7,
      }),
    ]);
    expect(saved?.aiRequests?.every((metric) => !metric.fallbackFrom)).toBe(
      true,
    );
    expect(
      request.mock.calls.every(
        ([url, init]) =>
          url === "https://synthetic-openai.invalid/v1/chat/completions" &&
          new Headers(init?.headers).get("authorization") ===
            "Bearer synthetic-openai-routing-key" &&
          !JSON.stringify(init).includes("synthetic-routing-secret"),
      ),
    ).toBe(true);
    expect(await store.list("jobs")).toHaveLength(1);
    expect(await store.list("generated")).toHaveLength(1);
    expect(await store.list("learning")).toHaveLength(1);
    await d.processJob(job.id);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["auth", "ai_auth_error", 11],
    ["invalid_json", "invalid_ai_output", 18],
    ["truncation", "ai_output_limit", 18],
    ["timeout", "ai_timeout", 11],
    ["quota", "ai_quota_exceeded", 11],
    ["refusal", "ai_refused", 18],
  ])(
    "does not publish Luna generation when mandatory review fails with %s",
    async (kind, code, tokens) => {
      useLuna();
      let calls = 0;
      const privateMarker = "synthetic private unreviewed content";
      const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (++calls === 1) return responseFor(init);
        if (kind === "auth")
          return new Response(privateMarker, { status: 401 });
        if (kind === "timeout")
          throw new DOMException("synthetic body timed out", "TimeoutError");
        if (kind === "quota")
          return Response.json(
            { error: { code: "insufficient_quota", message: privateMarker } },
            { status: 429 },
          );
        const review = await responseFor(init).json();
        if (kind === "invalid_json")
          review.choices[0].message.content = privateMarker;
        if (kind === "truncation") review.choices[0].finish_reason = "length";
        if (kind === "refusal")
          review.choices[0].message.refusal = privateMarker;
        return Response.json(review);
      });
      vi.stubGlobal("fetch", request);
      const { d, store, enqueue } = await setup();
      const job = await enqueue(
        "luna-review-failed-" + String(kind).replaceAll("_", "-"),
      );
      await d.processJob(job.id);
      const saved = await store.get<Job>("jobs", job.id);
      expect(saved).toMatchObject({
        status: "failed",
        result: null,
        tokens,
        error: { code },
      });
      expect(saved?.aiRequests).toHaveLength(2);
      expect(saved?.aiRequests?.[1]).toMatchObject({
        provider: "openai",
        model: "gpt-6-luna",
        stage: "verification",
        error: code,
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        request.mock.calls.every(
          ([url]) =>
            url === "https://synthetic-openai.invalid/v1/chat/completions",
        ),
      ).toBe(true);
      expect(await store.list("generated")).toEqual([]);
      expect(await store.list("learning")).toEqual([]);
      expect(JSON.stringify(saved)).not.toContain(privateMarker);
      expect(JSON.stringify(saved)).not.toContain(
        "synthetic-openai-routing-key",
      );
      expect(JSON.stringify(saved)).not.toContain("synthetic-routing-secret");
    },
  );
});
