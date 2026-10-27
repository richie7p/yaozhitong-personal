import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { config } from "../server/config.js";
import {
  normalizedUsage,
  parseOptions,
  runJcmitEvaluation,
  type EvaluationOptions,
} from "../tools/run-jcmit-evaluation.js";

const repository = process.cwd();
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const codeFiles = [
  "server/ai.ts",
  "server/llm.ts",
  "server/catalog.ts",
  "server/config.ts",
  "server/source-boundary.ts",
  "server/safety-learning.ts",
  "server/recognition-usage.ts",
  "shared/learning.ts",
  "shared/source.ts",
  "shared/schema.ts",
  "package-lock.json",
  "tools/run-jcmit-evaluation.ts",
  "tools/evaluation-core.ts",
];
let directory = "";
let original: typeof config;
const names = ["合成甲錠", "合成乙錠"];
const legible = (value: string | number) => ({ state: "legible", value });
function ref(name: string, index: number) {
  return {
    id: `med-${index}`,
    fields: {
      name: legible(name),
      strength: { state: "absent" },
      dose: legible(1),
      doseUnit: legible("錠"),
      frequency: legible("BID"),
      route: legible("口服"),
    },
    expectedLicenseNo: `fixture-license-${index}`,
  };
}
function recognized(name: string) {
  return {
    name,
    strength: null,
    form: null,
    doseAmount: 1,
    doseUnit: "錠",
    doseText: null,
    frequencyRaw: "BID",
    route: "口服",
    durationDays: null,
    rawText: `${name}\n每次劑量：1錠\n頻次：BID\n途徑：口服`,
    confidence: "high",
  };
}
async function fixture(mode: "vision" | "learning" = "vision") {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const source = JSON.stringify({
    chunks: [
      {
        id: "chunk-1",
        licenseNo: "fixture-license-0",
        version: "fixture-v1",
        page: 1,
        start: 0,
        text: "適應症\n緩解合成測試的特定症狀。",
        sourceFormat: "pdf",
      },
    ],
  });
  const catalog = JSON.stringify(
    names.map((nameZh, i) => ({
      licenseNo: `fixture-license-${i}`,
      nameZh,
      nameEn: "",
      strength: "",
      form: "",
      ingredients: [],
      revoked: false,
    })),
  );
  await Promise.all([
    writeFile(join(directory, "image.png"), image),
    writeFile(join(directory, "source.json"), source),
    writeFile(join(directory, "catalog.json"), catalog),
  ]);
  const manifest = {
    schemaVersion: 1,
    datasetId: "fixture",
    split: "development",
    referenceStatus: "ai_draft",
    deidentified: true,
    catalog: { path: "catalog.json", sha256: sha(catalog) },
    cases:
      mode === "vision"
        ? [
            {
              id: "two-medications",
              bagId: "bag-1",
              mode,
              image: {
                path: "image.png",
                sha256: sha(image),
                mediaType: "image/png",
              },
              medications: names.map(ref),
            },
          ]
        : [
            {
              id: "same-generation",
              mode,
              question: "整理來源用途與理解題",
              source: { path: "source.json", sha256: sha(source) },
            },
          ],
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}
function options(
  overrides: Partial<EvaluationOptions> = {},
): EvaluationOptions {
  return {
    manifest: "manifest.json",
    mode: "vision",
    runId: "bounded-run",
    maxCases: 1,
    repeats: 1,
    maxRequests: 6,
    maxEstimatedUsd: 1,
    allowProvisional: true,
    runRealAi: true,
    ...overrides,
  };
}
function provider(
  content: unknown,
  usage: unknown = {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 },
  },
) {
  return new Response(
    JSON.stringify({
      model: "gpt-6-luna",
      service_tier: "default",
      usage,
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
    { status: 200 },
  );
}
const visionResponse = () =>
  provider({ status: "succeeded", medications: names.map(recognized) });
const execute = (o: EvaluationOptions, transport: typeof fetch) =>
  runJcmitEvaluation(o, { cwd: directory, transport, log: () => {} });

beforeEach(async () => {
  original = { ...config };
  Object.assign(config, {
    aiProvider: "openai",
    textModel: "gpt-6-luna",
    visionModel: "gpt-6-luna",
    openaiBase: "https://api.openai.com/v1",
    openaiKey: "fake-test-key-not-a-secret",
  });
  await mkdir(resolve(repository, ".local"), { recursive: true });
  directory = await mkdtemp(resolve(repository, ".local/jcmit-runner-test-"));
  for (const file of codeFiles) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await cp(resolve(repository, file), join(directory, file));
  }
});
afterEach(async () => {
  Object.assign(config, original);
  const child = relative(resolve(repository, ".local"), resolve(directory));
  if (child.startsWith("jcmit-runner-test-") && !child.includes(".."))
    await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("bounded JCMIT evaluation runner", () => {
  it("defaults to dry-run and requires every explicit paid-run bound", () => {
    expect(
      parseOptions(["--manifest", "x", "--mode", "vision"]).runRealAi,
    ).toBe(false);
    expect(() =>
      parseOptions(["--manifest", "x", "--mode", "vision", "--run-real-ai"]),
    ).toThrow("evaluation_explicit_limits_required");
    expect(() =>
      parseOptions([
        "--manifest",
        "x",
        "--mode",
        "vision",
        "--max-cases",
        "-1",
      ]),
    ).toThrow("evaluation_invalid_limit");
  });

  it("validates pinned files in dry-run without transport or creating a run", async () => {
    await fixture();
    const transport = vi.fn(async () => visionResponse());
    const result = await execute(
      options({ runRealAi: false, allowProvisional: false }),
      transport,
    );
    expect(result.status).toBe("dry_run");
    expect(result.plan.humanValidated).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    await expect(
      readFile(
        join(directory, ".local/jcmit-evaluation/bounded-run/state.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(directory, "image.png"), "changed");
    await expect(
      execute(options({ runRealAi: false }), transport),
    ).rejects.toThrow("evaluation_file_hash_mismatch");
  });

  it("requires explicit provisional opt-in before any paid request", async () => {
    await fixture();
    const transport = vi.fn(async () => visionResponse());
    await expect(
      execute(options({ allowProvisional: false }), transport),
    ).rejects.toThrow("evaluation_provisional_requires_opt_in");
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses production multi-medication recognition and catalog, preserving and resuming one trial", async () => {
    await fixture();
    const transport = vi.fn(async () => visionResponse());
    const first = await execute(options(), transport);
    expect(transport).toHaveBeenCalledTimes(1);
    const trial = first.trials[0];
    expect(trial.status).toBe("succeeded");
    expect(trial.humanValidated).toBe(false);
    expect((trial.predictions as any[]).map((p) => p.candidates[0])).toEqual([
      "fixture-license-0",
      "fixture-license-1",
    ]);
    expect(trial.requests[0]).toMatchObject({
      model: "gpt-6-luna",
      serviceTier: "default",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 100,
        cacheWriteTokens: 200,
      },
    });
    const second = await execute(options(), transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(second.trials[0]).toEqual(first.trials[0]);
    const persisted = await readFile(
      join(directory, ".local/jcmit-evaluation/bounded-run/state.json"),
      "utf8",
    );
    expect(persisted).not.toContain("base64");
    expect(persisted).not.toContain(config.openaiKey);
    await expect(execute(options({ repeats: 2 }), transport)).rejects.toThrow(
      "evaluation_resume_plan_mismatch",
    );
  });

  it("captures the same learning generation before production rejection without generating a second direct arm", async () => {
    await fixture("learning");
    const transport = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const content = JSON.parse(body.messages[1].content);
      if (content.expectedIds)
        return provider({
          verdicts: content.expectedIds.map((id: string) => ({
            id,
            supported: false,
          })),
        });
      return provider({
        status: "supported",
        claims: [
          {
            text: "完全沒有副作用",
            category: "purpose",
            citations: [{ sourceId: content.sources[0].id }],
          },
        ],
        quiz: [],
        followups: [],
      });
    });
    const result = await execute(options({ mode: "learning" }), transport);
    // The explicit no-risk claim is rejected before model review; no extra generation.
    expect(transport).toHaveBeenCalledTimes(1);
    const trial = result.trials[0] as any;
    expect(trial.rawGeneration.claims[0].text).toBe("完全沒有副作用");
    expect(trial.candidate.claims[0].citations[0]).toMatchObject({
      chunkId: "chunk-1",
    });
    expect(
      trial.published.claims.some((c: any) => c.text === "完全沒有副作用"),
    ).toBe(false);
    expect(trial.semanticReview.publishedSupported).toBeNull();
    expect(trial.sourceChunks[0].version).toBe("fixture-v1");
  });

  it("enforces the request cap and keeps the blocked trial without a hidden retry", async () => {
    await fixture();
    const transport = vi.fn(async () => visionResponse());
    const result = await execute(
      options({ repeats: 2, maxRequests: 1 }),
      transport,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.trials.map((t) => t.status)).toEqual(["succeeded", "failed"]);
    expect(result.trials[1].error).toBe("evaluation_request_cap");
    expect(result.trials[1].requests).toHaveLength(0);
  });

  it("blocks an estimate over budget before sending the first request", async () => {
    await fixture();
    const transport = vi.fn(async () => visionResponse());
    const result = await execute(
      options({ maxEstimatedUsd: 0.000001 }),
      transport,
    );
    expect(transport).not.toHaveBeenCalled();
    expect(result.trials[0].error).toBe("evaluation_estimated_budget_cap");
  });

  it("preserves unknown usage and stops every later provider request", async () => {
    await fixture();
    const transport = vi.fn(async () =>
      provider(
        { status: "succeeded", medications: names.map(recognized) },
        undefined,
      ),
    );
    // Explicit null means the provider did not report usage.
    transport.mockImplementation(async () =>
      provider(
        { status: "succeeded", medications: names.map(recognized) },
        null,
      ),
    );
    const result = await execute(options({ repeats: 2 }), transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.trials[0].requests[0].usage?.inputTokens).toBeNull();
    expect(result.trials[1].error).toBe("evaluation_unknown_usage_stop");
    expect(
      "summary" in result && result.summary?.estimatedReportedCostUpperUsd,
    ).toBeNull();
  });

  it("keeps malformed output and failures, redacts provider-echoed secrets and never retries that trial", async () => {
    await fixture();
    const transport = vi.fn(async () =>
      provider({ echoed: config.openaiKey, invalid: true }),
    );
    const result = await execute(options(), transport);
    expect(result.trials[0].error).toBe("invalid_ai_output");
    expect(result.trials[0].status).toBe("failed");
    expect(result.trials[0].reference).toBeDefined();
    expect((result.trials[0].recognition as any).missedRows).toBe(2);
    const file = join(
      directory,
      ".local/jcmit-evaluation/bounded-run/state.json",
    );
    expect(await readFile(file, "utf8")).not.toContain(config.openaiKey);
    await execute(options(), transport);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not replay a durable started checkpoint after an interrupted process", async () => {
    await fixture();
    const transport = vi.fn(async () => visionResponse());
    await execute(options(), transport);
    const file = join(
      directory,
      ".local/jcmit-evaluation/bounded-run/state.json",
    );
    const state = JSON.parse(await readFile(file, "utf8"));
    Object.values<any>(state.trials)[0].state = "started";
    state.requests[0].state = "started";
    await writeFile(file, JSON.stringify(state));
    const result = await execute(options(), transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.trials[0].state).toBe("interrupted");
    expect(result.trials[0].error).toBe(
      "interrupted_outcome_unknown_not_replayed",
    );
  });

  it("does not silently treat absent cache fields as measured zero", () => {
    expect(
      normalizedUsage({ prompt_tokens: 12, completion_tokens: 4 }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: null,
      cacheWriteTokens: null,
    });
  });

  it("rejects blank legible references in preflight before sending or creating a run", async () => {
    const manifest = await fixture();
    (manifest.cases[0] as any).medications[0].fields.name.value = "";
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const transport = vi.fn(async () => visionResponse());
    await expect(
      execute(options({ runRealAi: false }), transport),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("groups a no-source learning negative by pinned source hash and makes no request", async () => {
    const manifest = await fixture("learning");
    const empty = JSON.stringify({ chunks: [] });
    await writeFile(join(directory, "source.json"), empty);
    (manifest.cases[0] as any).source.sha256 = sha(empty);
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const transport = vi.fn(async () => visionResponse());
    const result = await execute(options({ mode: "learning" }), transport);
    expect(transport).not.toHaveBeenCalled();
    expect(result.trials[0].bagId).toBe("source-" + sha(empty));
    expect(result.trials[0].status).toBe("partial");
    expect((result.trials[0].workflowCompletion as any).complete).toBe(false);
  });

  it("never repairs a candidate citation containing a fabricated quote", async () => {
    await fixture("learning");
    const transport = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const content = JSON.parse(body.messages[1].content);
      return provider({
        status: "supported",
        claims: [
          {
            text: "捏造內容",
            category: "purpose",
            citations: [{ sourceId: content.sources[0].id, quote: "捏造原文" }],
          },
        ],
        quiz: [],
        followups: [],
      });
    });
    const result = await execute(options({ mode: "learning" }), transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.trials[0].error).toBe("invalid_ai_output");
    expect(
      (result.trials[0].candidate as any).claims[0].citations[0],
    ).toMatchObject({
      quote: "捏造原文",
      resolutionError: "invalid_source_reference",
    });
  });
});
